'use strict'

const makeId = require('./makeId.js')
const makeTimestamp = require('./makeTimestamp.js')
const TransactionScope = require('./TransactionScope.js')

/**
 * ModelChain - 链式查询构建器
 * 负责运行时的查询构建、SQL 拼装和结果处理。
 */
class ModelChain {
  /**
   * @param {Object} ctx - 上下文 (NeoPG 实例 或 TransactionScope 实例)
   * @param {ModelDef} def - 模型元数据
   * @param {string} schema - 数据库 schema
   */
  constructor(ctx, def, schema = 'public') {
    this.ctx = ctx
    this.def = def
    this.sql = ctx.sql
    
    this.tableName = def.tableName
    this.schema = schema

    // --- 查询状态 (AST Lite) ---
    this._conditions = []
    this._order = []
    this._limit = null
    this._offset = null
    this._columns = null
    this._group = null
    this._lock = null

    // 内部状态标记
    this._isRaw = !!def.isRaw
  }

  // --- 静态构造器 ---
  static from(schemaObject) {
    return class AnonymousModel extends ModelChain {
      static schema = schemaObject
    }
  }

  // --- 核心：链式调用 API ---

  /**
   * 添加 WHERE 条件
   * 1. .where(sql`age > ${age}`) -> 原生片段 (Query)
   * 2. .where({ a: 1 }) -> a=1
   * 3. .where('age', '>', 18) -> age > 18 (兼容)
   */
  where(arg1, arg2, arg3) {
      if (!arg1) return this
      // 1. Fragment 检测
      if (arg1.constructor && arg1.constructor.name === 'Query') {
        this._conditions.push(arg1)
        return this
      }
      
      // 2. Object 写法
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

      // 3. String 写法
      if (typeof arg1 === 'string') {
          // .where('age', '>', 18)
          if (arg3 !== undefined) {
             this._conditions.push(this.sql`${this.sql(arg1)} ${this.sql.unsafe(arg2)} ${arg3}`)
             return this
          }
          // .where('age', 18) -> age = 18
          if (arg2 !== undefined) {
             this._conditions.push(this.sql`${this.sql(arg1)} = ${arg2}`)
             return this
          }
          // .where('id = ?', 123)
          if (arg1.includes('?') && arg2 !== undefined) {
             const p = arg1.split('?');
             if(p.length===2) {
               this._conditions.push(this.sql`${this.sql.unsafe(p[0])}${arg2}${this.sql.unsafe(p[1])}`)
               return this
             }
          }
          // .where('1=1') -> Raw SQL
          // 注意：这里必须用 unsafe，否则 '1=1' 会被当成字符串值处理
          this._conditions.push(this.sql.unsafe(arg1))
      }

      return this
  }

  whereIf(condition, arg1, arg2, arg3) {
    if (condition) return this.where(arg1, arg2, arg3)
    return this
  }

  select(columns) {
    if (!columns) return this

    if (typeof columns === 'string') {
        this._columns = columns.split(',').map(s => s.trim())
    } else if (Array.isArray(columns)) {
        this._columns = columns
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

   // --- 辅助：构建 Where 片段 (修复 Bug 的核心) ---
  _buildWhere() {
    const len = this._conditions.length
    if (len === 0) return this.sql``
    
    // 只有一个条件，直接返回，零开销
    if (len === 1) {
      return this.sql`WHERE ${this._conditions[0]}`
    }

    // 预分配数组：N个条件需要 N-1 个 'AND'，总长 2N-1
    // 使用 new Array 预分配内存，比 push 更快
    const parts = new Array(len * 2 - 1)
    const AND = this.sql.unsafe(' AND ')

    for (let i = 0; i < len; i++) {
      // 偶数位放条件
      parts[i * 2] = this._conditions[i]
      // 奇数位放 AND (除了最后一位)
      if (i < len - 1) {
        parts[i * 2 + 1] = AND
      }
    }

    // postgres.js 会自动展开这个扁平数组，性能极高
    return this.sql`WHERE ${parts}`
  }

  // --- 辅助：构建 Order 片段 (修复 Bug) ---
  _buildOrder() {
    if (this._order.length === 0) return this.sql``
    // 数组直接传入模板，postgres.js 默认用逗号连接，这正是 ORDER BY 需要的
    // 不能用 this.sql(this._order)，那样会试图转义为标识符
    return this.sql`ORDER BY ${this._order}`
  }

  // --- 核心：执行方法 ---

  async find() {
    const t = this.sql(this.tableName)
    const c = this._columns ? this.sql(this._columns) : this.sql`*`
    
    // 修复：使用新方法构建
    const w = this._buildWhere()
    const o = this._buildOrder()

    const l = this._limit ? this.sql`LIMIT ${this._limit}` : this.sql``
    const off = this._offset ? this.sql`OFFSET ${this._offset}` : this.sql``
    const lck = this._lock || this.sql``
    const ft = this.sql`${this.sql(this.schema)}.${t}`
    
    return await this.sql`SELECT ${c} FROM ${ft} ${w} ${o} ${l} ${off} ${lck}`
  }

  // Thenable 接口
  then(onFulfilled, onRejected) {
    return this.find().then(onFulfilled, onRejected)
  }

  async get() {
    this.limit(1)
    const rows = await this.find()
    return rows.length > 0 ? rows[0] : null
  }

  async count() {
    const t = this.sql(this.tableName); 
    // 修复：使用新方法构建
    const w = this._buildWhere()
    const ft = this.sql`${this.sql(this.schema)}.${t}`
    
    const r = await this.sql`SELECT count(*) as total FROM ${ft} ${w}`
    return parseInt(r[0].total)
  }

  async insert(data) {
    const isArray = Array.isArray(data)
    const inputs = isArray ? data : [data]
    if (inputs.length === 0) throw new Error('[NeoPG] Insert data cannot be empty')

    if (this.def) {
      this._prepareDataForInsert(inputs)
    }

    const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.tableName)}`
    const result = await this.sql`INSERT INTO ${fullTable} ${this.sql(inputs)} RETURNING *`

    if (!isArray && result.length > 0) return result[0]
    return result
  }

  async update(data) {
    if (!data || Object.keys(data).length === 0) throw new Error('[NeoPG] Update data cannot be empty')
    if (this.def) { this._prepareDataForUpdate(data) }
    
    if (this._conditions.length === 0) throw new Error('[NeoPG] UPDATE requires a WHERE condition')
    
    const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.tableName)}`
    // 修复：使用新方法构建
    const whereFragment = this._buildWhere()
    
    return await this.sql`UPDATE ${fullTable} SET ${this.sql(data)} ${whereFragment} RETURNING *`
  }

  async delete() {
    if (this._conditions.length === 0) throw new Error('[NeoPG] DELETE requires a WHERE condition')
    const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.tableName)}`
    // 修复：使用新方法构建
    const whereFragment = this._buildWhere()
    
    return await this.sql`DELETE FROM ${fullTable} ${whereFragment} RETURNING *`
  }

  async transaction(callback) {
    return await this.sql.begin(async (trxSql) => {
      const scope = new TransactionScope(this.ctx, trxSql)
      return await callback(scope)
    })
  }

  // --- 内部辅助方法 ---

  _prepareDataForInsert(rows) {
    const pk = this.def.primaryKey
    const autoId = this.def.autoId
    const pkLen = this.def.pkLen
    const ts = this.def.timestamps
    const defaults = this.def.defaults

    let make_timestamp = ts.insert && ts.insert.length > 0

    for (const row of rows) {
      if (autoId && row[pk] === undefined) {
        row[pk] = this.def.makeId(pkLen)
      }

      if (make_timestamp) {
        for (const t of ts.insert) {
          makeTimestamp(row, t)
        }
      }

      for (const key in row) {
        this.def.validateField(key, row[key])
      }
    }
  }

  _prepareDataForUpdate(row) {
    const ts = this.def.timestamps

    if (ts.update && ts.update.length > 0) {
      for (const t of ts.update) {
        makeTimestamp(row, t)
      }
    }

    for (const key in row) {
      this.def.validateField(key, row[key])
    }
  }
}

module.exports = ModelChain
