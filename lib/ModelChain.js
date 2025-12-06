'use strict'

const makeId = require('./makeId.js')
const makeTimestamp = require('./makeTimestamp.js')
const TransactionScope = require('./TransactionScope.js')

// [优化 1] 提取常量定义到类外部，提升性能
const INT_TYPES = new Set([
    'int', 'integer', 'smallint', 'bigint', 
    'serial', 'bigserial', 'smallserial',
    'int2', 'int4', 'int8'
])

const FLOAT_TYPES = new Set([
    'float', 'double', 'numeric', 'decimal', 'real', 
    'money', 'double precision', 'float4', 'float8'
])

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
    this._returning = null
    this._joins = []
    this._group = []

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

  returning(cols) {
    if (!cols) return this

    if (typeof cols === 'string') {
      // 支持 'id, name' 写法
      this._returning = cols.split(',').map(s => s.trim()).filter(s => s)
    } else if (Array.isArray(cols)) {
      this._returning = cols
    }

    return this
  }

  // --- 构建 RETURNING 片段 ---
  _buildReturning() {
    // 如果没有设置 returning，默认不返回数据 (节省性能)
    // 注意：这意味着默认 insert/update 返回的是 Result 对象(包含 count)，而不是行数据
    if (!this._returning || this._returning.length === 0) {
        return this.sql``
    }

    // 特殊处理 '*': 用户显式要求 returning('*')
    // 如果直接用 this.sql(['*']) 会被转义为 "*"，导致错误
    if (this._returning.length === 1 && this._returning[0] === '*') {
        return this.sql`RETURNING *`
    }

    // 普通字段：利用 postgres.js 自动转义标识符
    return this.sql`RETURNING ${this.sql(this._returning)}`
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
    const j = this._buildJoins()
    const g = this._buildGroup()

    const l = this._limit ? this.sql`LIMIT ${this._limit}` : this.sql``
    const off = this._offset ? this.sql`OFFSET ${this._offset}` : this.sql``
    const lck = this._lock || this.sql``
    const ft = this.sql`${this.sql(this.schema)}.${t}`
    
    return await this.sql`SELECT ${c} FROM ${ft} ${j} ${w} ${g} ${o} ${l} ${off} ${lck}`
  }

  async get() {
    this.limit(1)
    const rows = await this.find()
    return rows.length > 0 ? rows[0] : null
  }

  async count() {
    const t = this.sql(this.tableName)

    const w = this._buildWhere()
    const ft = this.sql`${this.sql(this.schema)}.${t}`
    const j = this._buildJoins()
    
    const r = await this.sql`SELECT count(*) as total FROM ${ft} ${j} ${w}`

    if (r.length === 0) return 0

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

    // [修改] 动态构建 returning
    const retFragment = this._buildReturning()

    const result = await this.sql`INSERT INTO ${fullTable} ${this.sql(inputs)} ${retFragment}`

    // 如果有 returning 数据，result 是数组（包含行）；否则 result 是 Result 对象（包含 count）
    // 逻辑保持兼容：如果用户请求了数据，且是单条插入，返回对象；否则返回数组
    if (this._returning && this._returning.length > 0) {
        if (!isArray && result.length === 1) {
          return result[0]
        }

        return result
    }
    
    // 如果没有 returning，返回 postgres 原生结果 (包含 count 等信息)
    // 测试发现如果没有returning则返回的是空数组
    return result
  }

  async update(data) {
    if (!data || Object.keys(data).length === 0) throw new Error('[NeoPG] Update data cannot be empty')
    if (this.def) { this._prepareDataForUpdate(data) }
    
    if (this._conditions.length === 0) throw new Error('[NeoPG] UPDATE requires a WHERE condition')
    
    const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.tableName)}`
    // 修复：使用新方法构建
    const whereFragment = this._buildWhere()
    
    // [修改] 动态构建 returning
    const retFragment = this._buildReturning()
    
    const result = await this.sql`UPDATE ${fullTable} SET ${this.sql(data)} ${whereFragment} ${retFragment}`

    if (this._returning && this._returning.length > 0) {
        if (result.length === 1) return result[0]

        return result
    }

    return result
  }

  async delete() {
    if (this._conditions.length === 0) throw new Error('[NeoPG] DELETE requires a WHERE condition')
    const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.tableName)}`
    // 修复：使用新方法构建
    const whereFragment = this._buildWhere()
    
    const retFragment = this._buildReturning()
      
    return await this.sql`DELETE FROM ${fullTable} ${whereFragment} ${retFragment}`
  }

  async transaction(callback) {
    return this.ctx.transaction(callback)
    /* return await this.sql.begin(async (trxSql) => {
      const scope = new TransactionScope(this.ctx, trxSql)
      return await callback(scope)
    }) */
  }

  begin(callback) {
    return this.ctx.transaction(callback)
  }

   /**
   * 内部通用 Join 添加器
   * @param {string} type - 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN'
   * @param {string|Object} table - 表名 或 sql`fragment`
   * @param {string|Object} on - 条件字符串 或 sql`fragment`
   */
  _addJoin(type, table, on) {
    let tableFragment
    let onFragment

    // 1. 处理 Table
    if (table.constructor && table.constructor.name === 'Query') {
      tableFragment = table
    } else {
      // 默认作为当前 Schema 下的表名处理 "public"."table"
      // 如果需要跨 Schema (e.g. "other.table")，请用户传入 sql`other.table`
      tableFragment = this.sql(table)
    }

    // 2. 处理 ON 条件
    if (on.constructor && on.constructor.name === 'Query') {
      onFragment = on;
    } else {
      // 字符串情况，视为 Raw SQL (e.g. "u.id = p.uid")
      // 因为 ON 条件通常包含操作符，无法简单参数化，必须 unsafe
      onFragment = this.sql.unsafe(on);
    }

    // 3. 构建单个 Join 片段
    // 格式: TYPE + table + ON + condition
    const joinFragment = this.sql`${this.sql.unsafe(type)} ${tableFragment} ON ${onFragment}`
    
    this._joins.push(joinFragment)
    return this
  }

  join(table, on) {
    return this._addJoin('INNER JOIN', table, on)
  }

  innerJoin(table, on) {
    return this._addJoin('INNER JOIN', table, on)
  }

  leftJoin(table, on) {
    return this._addJoin('LEFT JOIN', table, on)
  }

  rightJoin(table, on) {
    return this._addJoin('RIGHT JOIN', table, on)
  }

  fullJoin(table, on) {
    return this._addJoin('FULL OUTER JOIN', table, on)
  }

  _buildJoins() {
    const len = this._joins.length
    if (len === 0) return this.sql``

    // 只有一个 Join，直接返回
    if (len === 1) {
      return this._joins[0]
    }

    // 多个 Join，必须用空格连接，不能用逗号
    // 采用“平铺数组”高性能方案
    const parts = new Array(len * 2 - 1)
    const SPACE = this.sql.unsafe(' ')

    for (let i = 0; i < len; i++) {
      parts[i * 2] = this._joins[i]
      if (i < len - 1) {
        parts[i * 2 + 1] = SPACE
      }
    }

    return this.sql`${parts}`
  }

  /**
   * 添加 Group By 条件
   * .group('category_id')
   * .group('category_id, type')
   * .group(['id', 'name'])
   */
  group(arg) {
    if (!arg) return this
    
    // 1. Fragment
    if (arg.constructor && arg.constructor.name === 'Query') {
      this._group.push(arg)
      return this
    }

    // 2. Array
    if (Array.isArray(arg)) {
      arg.forEach(f => this.group(f))
      return this
    }

    // 3. String
    if (typeof arg === 'string') {
      if (arg.includes(',')) {
        // 'id, name' -> 拆分
        arg.split(',').map(s => s.trim()).filter(s=>s).forEach(s => {
          this._group.push(this.sql(s))
        })
      } else {
        // 单个字段
        this._group.push(this.sql(arg))
      }
    }

    return this
  }

  // 构建 Group 片段
  _buildGroup() {
    if (this._group.length === 0) return this.sql``

    // postgres.js 模板数组默认用逗号连接，正好符合 GROUP BY 语法
    return this.sql`GROUP BY ${this._group}`
  }

  // --- 聚合函数 ---

  async min(field) {
    return this._aggregate('MIN', field)
  }

  async max(field) {
    return this._aggregate('MAX', field)
  }

  async sum(field) {
    return this._aggregate('SUM', field)
  }

  async avg(field) {
    return this._aggregate('AVG', field)
  }

  /**
   * 通用聚合执行器
   * @param {string} func - MIN, MAX, SUM, AVG
   * @param {string} field - 列名
   */
  async _aggregate(func, field) {
    if (!field) throw new Error(`[NeoPG] ${func} requires a field name.`)

    const t = this.sql(this.tableName)
    const w = this._buildWhere()
    const j = this._buildJoins()
    const ft = this.sql`${this.sql(this.schema)}.${t}`

    // 处理字段名 (可能是 'age' 也可能是 'users.age')
    let colFragment;
    if (field.constructor && field.constructor.name === 'Query') {
        colFragment = field
    } else {
        colFragment = this.sql(field)
    }
    
    // SELECT MIN(age) as val ...
    const query = this.sql`
        SELECT ${this.sql.unsafe(func)}(${colFragment}) as val 
        FROM ${ft} ${j} ${w}
    `

    const result = await query
    const val = result.length > 0 ? result[0].val : null

    if (val === null) return null;

    // 智能类型转换
    return this._convertAggregateValue(val, field, func)
  }

  /**
   * 智能转换聚合结果类型
   * Postgres 对于 SUM/AVG/COUNT 经常返回字符串 (BigInt/Numeric)，我们需要转回 Number
   */
  _convertAggregateValue(val, field, func) {
    // 1. AVG 始终是浮点数
    if (func === 'AVG') {
      return parseFloat(val)
    }

    // 如果是 Raw Fragment，无法推断类型，直接返回原值（通常是 String）
    if (typeof field !== 'string') return val

    // 2. 尝试从 ModelDef 获取列定义
    // field 可能是 'age' 也可能是 'u.age' (别名暂不支持自动推断，这里只处理简单列名)
    const colDef = this.def && this.def.columns ? this.def.columns[field] : null

    // 如果不知道列定义，尝试尽力猜测
    if (!colDef) {
        // 如果 val 是字符串且长得像数字
        if (typeof val === 'string' && !isNaN(val)) {
            // SUM 默认为数字
            if (func === 'SUM') return parseFloat(val)
        }

        return val
    }

    // 5. [优化] 精确类型匹配
    // 处理 'numeric(10,2)' -> 'numeric'
    // 处理 'integer' -> 'integer'
    const rawType = colDef.type.toLowerCase()
    const parenIndex = rawType.indexOf('(')
    const baseType = parenIndex > 0 ? rawType.substring(0, parenIndex).trim() : rawType

    // 整数匹配
    if (INT_TYPES.has(baseType)) {
      return parseInt(val, 10)
    }

    // 浮点数匹配
    if (FLOAT_TYPES.has(baseType)) {
      return parseFloat(val)
    }

    // 其他 (Date, String, Boolean) 原样返回
    return val
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
