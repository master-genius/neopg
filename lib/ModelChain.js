'use strict'

const makeId = require('./makeId.js')
const makeTimestamp = require('./makeTimestamp.js')
const serialId = makeId.serialId

// 提取常量定义
const INT_TYPES = new Set([
    'int', 'integer', 'smallint', 'bigint', 
    'serial', 'bigserial', 'smallserial',
    'int2', 'int4', 'int8'
])

const FLOAT_TYPES = new Set([
    'float', 'double', 'numeric', 'decimal', 'real', 
    'money', 'double precision', 'float4', 'float8'
])

class ModelChain {
  constructor(ctx, def, schema='public') {
    this.ctx = ctx
    this.def = def
    this.sql = ctx ? ctx.sql : null
    this.schema = schema

    // --- 查询状态 ---
    this._conditions = []
    this._order = []
    this._limit = null
    this._offset = null
    this._columns = null
    this._returning = null
    this._joins = []
    this._group = []
    this._lock = null

    this._isRaw = false
    this._executed = false
  }

  static from(schemaObject) {
    return class AnonymousModel extends ModelChain {
      static schema = schemaObject
    }
  }

  // --- 内部状态管理 ---

  _ensureActive() {
    if (this._executed) {
      throw new Error(
        `[NeoPG] ModelChain for '${this.def.tableName}' has already been executed. ` +
        `Do NOT reuse the chain variable. Use .clone() if you need to fork queries.`
      )
    }
  }

  _destroy() {
    this._executed = true
    //this.def = null
    //this.ctx = null
    // this.sql = null // 可选：保留引用以便 debug，或者释放
  }

  clone() {
    this._ensureActive()
    const copy = new ModelChain(this.ctx, this.def, this.schema)
    
    // 拷贝状态
    copy._conditions = [...this._conditions]
    copy._joins = [...this._joins]
    copy._group = [...this._group]
    copy._order = [...this._order]
    
    copy._limit = this._limit
    copy._offset = this._offset
    copy._lock = this._lock
    if (this._columns) copy._columns = [...this._columns]
    if (this._returning) copy._returning = [...this._returning]

    return copy
  }

  // --- 构建方法 (无检测，高性能) ---

  select(columns) {
    if (!columns) return this
    if (typeof columns === 'string') {
        this._columns = columns.split(',').map(s => s.trim())
    } else if (Array.isArray(columns)) {
        this._columns = columns
    }
    return this
  }

  limit(count, offset = 0) {
    this._limit = count
    this._offset = offset
    return this
  }

  page(pageIndex, pageSize) {
    return this.limit(pageSize, (pageIndex - 1) * pageSize)
  }

  forUpdate() {
    this._lock = this.sql`FOR UPDATE`
    return this
  }

  forShare() {
    this._lock = this.sql`FOR SHARE`
    return this
  }

  returning(cols) {
    if (!cols) return this
    if (typeof cols === 'string') {
      this._returning = cols.split(',').map(s => s.trim()).filter(s => s)
    } else if (Array.isArray(cols)) {
      this._returning = cols
    }
    return this
  }

  orderby(a, b) {
      if(!a) return this

      if(a.constructor && a.constructor.name==='Query') {
        this._order.push(a)
        return this
      }

      if(typeof a==='object') {
        for(const k in a) {
          this._order.push(this.sql`${this.sql(k)} ${this.sql.unsafe(a[k].toUpperCase())}`)
        }
        return this
      }

      if(typeof a==='string') {
        const d = b ? b.toUpperCase() : 'ASC'
        if(a.includes(' ')) this._order.push(this.sql.unsafe(a));
        else this._order.push(this.sql`${this.sql(a)} ${this.sql.unsafe(d)}`);
      }
      return this
  }

  group(arg) {
    if (!arg) return this
    if (arg.constructor && arg.constructor.name === 'Query') {
      this._group.push(arg)
      return this
    }
    if (Array.isArray(arg)) {
      arg.forEach(f => this.group(f))
      return this
    }
    if (typeof arg === 'string') {
      if (arg.includes(',')) {
        arg.split(',').map(s => s.trim()).filter(s=>s).forEach(s => {
          this._group.push(this.sql(s))
        })
      } else {
        this._group.push(this.sql(arg))
      }
    }
    return this
  }

  // --- 特殊构建：Where (需要检测) ---

  where(arg1, arg2, arg3) {
      // ⚠️ 只有 where 需要提前检测，防止条件污染
      this._ensureActive()

      if (!arg1) return this

      if (arg1.constructor && arg1.constructor.name === 'Query') {
        this._conditions.push(arg1)
        return this
      }
      
      if (typeof arg1 === 'object' && !Array.isArray(arg1)) {
        for (const k of Object.keys(arg1)) {
          const v = arg1[k]
          if (v === undefined) continue
          if (v === null) this._conditions.push(this.sql`${this.sql(k)} IS NULL`)
          else if (Array.isArray(v)) this._conditions.push(this.sql`${this.sql(k)} IN ${this.sql(v)}`)
          else this._conditions.push(this.sql`${this.sql(k)} = ${v}`)
        }
        return this
      }

      if (typeof arg1 === 'string') {
          if (arg3 !== undefined) {
             this._conditions.push(this.sql`${this.sql(arg1)} ${this.sql.unsafe(arg2)} ${arg3}`)
             return this
          }
          if (arg2 !== undefined) {
             this._conditions.push(this.sql`${this.sql(arg1)} = ${arg2}`)
             return this
          }
          if (arg1.includes('?') && arg2 !== undefined) {
             const p = arg1.split('?');
             if(p.length===2) {
               this._conditions.push(this.sql`${this.sql.unsafe(p[0])}${arg2}${this.sql.unsafe(p[1])}`)
               return this
             }
          }
          this._conditions.push(this.sql.unsafe(arg1))
      }
      return this
  }

  whereIf(condition, arg1, arg2, arg3) {
    if (condition) return this.where(arg1, arg2, arg3)
    return this
  }

  // --- SQL 构建辅助 (内部方法) ---

  _buildWhere() {
    const len = this._conditions.length
    if (len === 0) return this.sql``
    if (len === 1) return this.sql`WHERE ${this._conditions[0]}`

    const parts = new Array(len * 2 - 1)
    const AND = this.sql.unsafe(' AND ')
    for (let i = 0; i < len; i++) {
      parts[i * 2] = this._conditions[i]
      if (i < len - 1) parts[i * 2 + 1] = AND
    }
    return this.sql`WHERE ${parts}`
  }

  _buildReturning() {
    if (!this._returning || this._returning.length === 0) return this.sql``
    if (this._returning.length === 1 && this._returning[0] === '*') return this.sql`RETURNING *`
    return this.sql`RETURNING ${this.sql(this._returning)}`
  }

  _buildOrder() {
    if (this._order.length === 0) return this.sql``
    return this.sql`ORDER BY ${this._order}`
  }

  _buildJoins() {
    const len = this._joins.length
    if (len === 0) return this.sql``
    if (len === 1) return this._joins[0]

    const parts = new Array(len * 2 - 1)
    const SPACE = this.sql.unsafe(' ')
    for (let i = 0; i < len; i++) {
      parts[i * 2] = this._joins[i]
      if (i < len - 1) parts[i * 2 + 1] = SPACE
    }
    return this.sql`${parts}`
  }

  _buildGroup() {
    if (this._group.length === 0) return this.sql``
    return this.sql`GROUP BY ${this._group}`
  }

  _buildSelectQuery() {
    const t = this.sql(this.def.tableName)
    const c = this._columns ? this.sql(this._columns) : this.sql`*`
    
    const w = this._buildWhere()
    const o = this._buildOrder()
    const j = this._buildJoins()
    const g = this._buildGroup()

    const l = this._limit ? this.sql`LIMIT ${this._limit}` : this.sql``
    const off = this._offset ? this.sql`OFFSET ${this._offset}` : this.sql``
    const lck = this._lock || this.sql``
    const ft = this.sql`${this.sql(this.schema)}.${t}`
    
    return this.sql`SELECT ${c} FROM ${ft} ${j} ${w} ${g} ${o} ${l} ${off} ${lck}`
  }

  // --- 执行动作 (Executors) ---
  // 必须检测 _ensureActive 并在 finally 中销毁

  async find() {
    this._ensureActive()
    try {
      return await this._buildSelectQuery()
    } finally {
      this._destroy()
    }
  }

  async get() {
    // get 依赖 find，但因为 get 修改了 limit 状态，虽然 limit 方法没检测，
    // 但最终调用的 find 会检测。为了保险起见，这里也可以不加 try/finally，
    // 让 find 去处理销毁。
    this.limit(1)
    const rows = await this.find() // find 会负责 destroy
    return rows.length > 0 ? rows[0] : null
  }

  async findAndCount() {
    this._ensureActive()
    try {
      // 1. 数据查询
      const dataQuery = this._buildSelectQuery()

      // 2. 总数查询
      const t = this.sql(this.def.tableName)
      const w = this._buildWhere()
      const j = this._buildJoins()
      const g = this._buildGroup()
      const ft = this.sql`${this.sql(this.schema)}.${t}`
      
      let countPromise

      if (this._group.length > 0) {
        countPromise = this.sql`SELECT count(*) as total FROM (SELECT 1 FROM ${ft} ${j} ${w} ${g}) as temp`
      } else {
        countPromise = this.sql`SELECT count(*) as total FROM ${ft} ${j} ${w}`
      }

      const [data, countResult] = await Promise.all([dataQuery, countPromise])

      return {
        data,
        total: parseInt(countResult[0]?.total || 0, 10)
      }
    } finally {
      this._destroy()
    }
  }

  async count() {
    this._ensureActive()
    try {
      const t = this.sql(this.def.tableName)
      const w = this._buildWhere()
      const j = this._buildJoins()
      const g = this._buildGroup()
      const ft = this.sql`${this.sql(this.schema)}.${t}`
      
      let query;
      if (this._group.length > 0) {
        query = this.sql`SELECT count(*) as total FROM (SELECT 1 FROM ${ft} ${j} ${w} ${g}) as temp`
      } else {
        query = this.sql`SELECT count(*) as total FROM ${ft} ${j} ${w}`
      }

      const r = await query
      if (r.length === 0) return 0
      return parseInt(r[0].total)
    } finally {
      this._destroy()
    }
  }

  async insert(data) {
    this._ensureActive()
    try {
      const isArray = Array.isArray(data)
      const inputs = isArray ? data : [data]
      if (inputs.length === 0) throw new Error('[NeoPG] Insert data cannot be empty')

      if (!this._isRaw) {
        this._prepareDataForInsert(inputs)
      }

      const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.def.tableName)}`
      const retFragment = this._buildReturning()

      const result = await this.sql`INSERT INTO ${fullTable} ${this.sql(inputs)} ${retFragment}`

      if (this._returning && this._returning.length > 0) {
          if (!isArray && result.length === 1) return result[0]
          return result
      }
      return result
    } finally {
      this._destroy()
    }
  }

  async update(data) {
    this._ensureActive()
    try {
      if (!data || Object.keys(data).length === 0) throw new Error('[NeoPG] Update data cannot be empty')
      
        if (!this._isRaw) {
        this._prepareDataForUpdate(data)
      }

      if (this._conditions.length === 0) throw new Error('[NeoPG] UPDATE requires a WHERE condition')
      
      const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.def.tableName)}`
      const whereFragment = this._buildWhere()
      const retFragment = this._buildReturning()
      
      const result = await this.sql`UPDATE ${fullTable} SET ${this.sql(data)} ${whereFragment} ${retFragment}`

      if (this._returning && this._returning.length > 0) {
          if (result.length === 1) return result[0]
          return result
      }
      return result
    } finally {
      this._destroy()
    }
  }

  async delete() {
    this._ensureActive()
    try {
      if (this._conditions.length === 0) throw new Error('[NeoPG] DELETE requires a WHERE condition')
      const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.def.tableName)}`
      const whereFragment = this._buildWhere()
      const retFragment = this._buildReturning()
        
      return await this.sql`DELETE FROM ${fullTable} ${whereFragment} ${retFragment}`
    } finally {
      this._destroy()
    }
  }

  async transaction(callback) {
    // 事务通常开启新的 Scope，不需要销毁当前 Chain
    return this.ctx.transaction(callback)
  }

  model(name) {
    return this.ctx.model(name)
  }

  async _aggregate(func, field) {
    this._ensureActive()
    try {
        if (!field) throw new Error(`[NeoPG] ${func} requires a field name.`)

        const t = this.sql(this.def.tableName)
        const w = this._buildWhere()
        const j = this._buildJoins()
        const ft = this.sql`${this.sql(this.schema)}.${t}`

        let colFragment;
        if (field.constructor && field.constructor.name === 'Query') {
            colFragment = field
        } else {
            colFragment = this.sql(field)
        }
        
        const query = this.sql`
            SELECT ${this.sql.unsafe(func)}(${colFragment}) as val 
            FROM ${ft} ${j} ${w}
        `

        const result = await query
        const val = result.length > 0 ? result[0].val : null
        if (val === null) return null;
        return this._convertAggregateValue(val, field, func)
    } finally {
        this._destroy()
    }
  }

  async min(field) { return this._aggregate('MIN', field) }
  async max(field) { return this._aggregate('MAX', field) }
  async sum(field) { return this._aggregate('SUM', field) }
  async avg(field) { return this._aggregate('AVG', field) }

  _convertAggregateValue(val, field, func) {
    if (func === 'AVG') return parseFloat(val)
    if (typeof field !== 'string') return val

    const colDef = this.def && this.def.columns ? this.def.columns[field] : null
    if (!colDef) {
        if (typeof val === 'string' && !isNaN(val)) {
            if (func === 'SUM') return parseFloat(val)
        }
        return val
    }

    const rawType = colDef.type.toLowerCase()
    const parenIndex = rawType.indexOf('(')
    const baseType = parenIndex > 0 ? rawType.substring(0, parenIndex).trim() : rawType

    if (INT_TYPES.has(baseType)) return parseInt(val, 10)
    if (FLOAT_TYPES.has(baseType)) return parseFloat(val)
    return val
  }

  join(table, on) { return this._addJoin('INNER JOIN', table, on) }
  innerJoin(table, on) { return this._addJoin('INNER JOIN', table, on) }
  leftJoin(table, on) { return this._addJoin('LEFT JOIN', table, on) }
  rightJoin(table, on) { return this._addJoin('RIGHT JOIN', table, on) }
  fullJoin(table, on) { return this._addJoin('FULL OUTER JOIN', table, on) }

  _addJoin(type, table, on) {
    // 内部方法，不需要检测，提升性能
    let tableFragment
    let onFragment

    if (table.constructor && table.constructor.name === 'Query') {
      tableFragment = table
    } else {
      tableFragment = this.sql(table)
    }

    if (on.constructor && on.constructor.name === 'Query') {
      onFragment = on;
    } else {
      onFragment = this.sql.unsafe(on);
    }

    this._joins.push(this.sql`${this.sql.unsafe(type)} ${tableFragment} ON ${onFragment}`)
    return this
  }

  // --- 数据预处理 ---
  _prepareDataForInsert(rows) {
    const pk = this.def.primaryKey
    const autoId = this.def.autoId
    const pkLen = this.def.pkLen
    const ts = this.def.timestamps

    let make_timestamp = ts.insert && ts.insert.length > 0

    for (const row of rows) {
      if (autoId && row[pk] === undefined) {
        row[pk] = this.def.makeId(pkLen)
      }

      if (make_timestamp) {
        for (const t of ts.insert) makeTimestamp(row, t)
      }

      for (const key in row) {
        this.def.validateField(key, row[key])
      }
    }
  }

  _prepareDataForUpdate(row) {
    const ts = this.def.timestamps
    if (ts.update && ts.update.length > 0) {
      for (const t of ts.update) makeTimestamp(row, t)
    }

    for (const key in row) {
      this.def.validateField(key, row[key])
    }
  }

  makeId(len=16) {
    return this.def ? this.def.makeId(this.def.pkLen) : serialId(len)
  }
}

module.exports = ModelChain