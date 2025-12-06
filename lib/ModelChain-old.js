'use strict';

const makeId = require('./makeId.js');
const makeTimestamp = require('./makeTimestamp.js');

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
  constructor(sql, def, schema = 'public') {
    this.def = def
    this.sql = sql
    
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

    // 1. 识别 Postgres Fragment (Query)
    // 依据指令：直接检测构造函数名称是否为 'Query'
    if (arg1.constructor && arg1.constructor.name === 'Query') {
        this._conditions.push(arg1)
        return this
    }

    // 2. 对象写法 .where({ id: 1, name: 'Neo' })
    if (typeof arg1 === 'object' && !Array.isArray(arg1)) {
      const keys = Object.keys(arg1)
      if (keys.length === 0) return this

      for (const key of keys) {
        const val = arg1[key];
        if (val === undefined) continue
        
        if (val === null) {
           this._conditions.push(this.sql`${this.sql(key)} IS NULL`)
        } else if (Array.isArray(val)) {
           this._conditions.push(this.sql`${this.sql(key)} IN ${this.sql(val)}`)
        } else {
           this._conditions.push(this.sql`${this.sql(key)} = ${val}`)
        }
      }

      return this
    }

    // 3. 字符串/参数写法
    if (typeof arg1 === 'string') {
      // Case A: .where('id', 123)  => id = 123 (默认等于)
      if (arg2 !== undefined && arg3 === undefined) {
        this._conditions.push(this.sql`${this.sql(arg1)} = ${arg2}`)
        return this
      }
      
      // Case B: .where('age', '>', 18)
      if (arg3 !== undefined) {
        // 注意：中间的操作符必须用 sql.unsafe，因为它不是变量
        this._conditions.push(this.sql`${this.sql(arg1)} ${this.sql.unsafe(arg2)} ${arg3}`)
        return this
      }

      // Case C: .where('id = ?', 123) (简单兼容)
      if (arg1.includes('?') && arg2 !== undefined) {
        const parts = arg1.split('?')

        // 只支持单个参数简单替换，复杂的请用 sql``
        if (parts.length === 2) {
           this._conditions.push(this.sql`${this.sql.unsafe(parts[0])}${arg2}${this.sql.unsafe(parts[1])}`)
           return this
        }
      }
      
      // Case D: 纯字符串 (视为 Raw SQL)
      // .where("status = 'active'")
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

  /**
   * 排序
   * .order(sql`create_time DESC`)
   * .order('create_time', 'DESC')
   * .order({ create_time: 'DESC' })
   */
  order(arg1, arg2) {
    if (!arg1) return this

    // 1. Fragment
    if (arg1.constructor && arg1.constructor.name === 'Query') {
      this._order.push(arg1)
      return this
    }

    // 2. Object { id: 'DESC' }
    if (typeof arg1 === 'object') {
      for (const key in arg1) {
        const dir = arg1[key].toUpperCase()
        this._order.push(this.sql`${this.sql(key)} ${this.sql.unsafe(dir)}`)
      }

      return this
    }

    // 3. String ('id', 'DESC')
    if (typeof arg1 === 'string') {
      const dir = arg2 ? arg2.toUpperCase() : 'ASC'
      // 检查 arg1 是否包含空格 (e.g. "id desc")
      if (arg1.includes(' ')) {
        this._order.push(this.sql.unsafe(arg1))
      } else {
        this._order.push(this.sql`${this.sql(arg1)} ${this.sql.unsafe(dir)}`)
      }
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

  // --- 核心：执行方法 ---

  async find() {
    const tableFragment = this.sql(this.tableName)

    const colsFragment = this._columns 
        ? this.sql(this._columns) 
        : this.sql`*`

    const whereFragment = this._conditions.length 
        ? this.sql`WHERE ${this.sql(this._conditions, ' AND ')}` 
        : this.sql``

    const orderFragment = this._order.length 
        ? this.sql`ORDER BY ${this.sql(this._order)}` 
        : this.sql``
        
    const limitFragment = this._limit 
        ? this.sql`LIMIT ${this._limit}` 
        : this.sql``
        
    const offsetFragment = this._offset 
        ? this.sql`OFFSET ${this._offset}` 
        : this.sql``
    
    const lockFragment = this._lock || this.sql``

    const fullTable = this.sql`${this.sql(this.schema)}.${tableFragment}`

    return await this.sql`
      SELECT ${colsFragment} 
      FROM ${fullTable}
      ${whereFragment}
      ${orderFragment}
      ${limitFragment}
      ${offsetFragment}
      ${lockFragment}
    `
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
    const tableFragment = this.sql(this.tableName);
    const whereFragment = this._conditions.length 
        ? this.sql`WHERE ${this.sql(this._conditions, ' AND ')}` 
        : this.sql``
    
    const fullTable = this.sql`${this.sql(this.schema)}.${tableFragment}`

    const result = await this.sql`
        SELECT count(*) as total FROM ${fullTable} ${whereFragment}
    `

    return parseInt(result[0].total)
  }

  // --- 写入方法 ---

  async insert(data) {
    const isArray = Array.isArray(data)
    const inputs = isArray ? data : [data]
    if (inputs.length === 0) throw new Error('[NeoPG] Insert data cannot be empty')

    if (this.def) {
      this._prepareDataForInsert(inputs)
    }
  
    const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.tableName)}`

    const result = await this.sql`
      INSERT INTO ${fullTable} ${this.sql(inputs)}
      RETURNING *
    `

    if (!isArray && result.length > 0) return result[0]

    return result
  }

  async update(data) {
    if (!data || Object.keys(data).length === 0) throw new Error('[NeoPG] Update data cannot be empty')

    if (this.def) {
      this._prepareDataForUpdate(data)
    }

    console.log(this._conditions)
    if (this._conditions.length === 0) {
        throw new Error('[NeoPG] UPDATE requires a WHERE condition')
    }

    const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.tableName)}`
    const whereFragment = this.sql`WHERE ${this.sql(this._conditions, ' AND ')}`

    // 使用 sql(data) 自动处理 set a=1, b=2
    return await this.sql`
      UPDATE ${fullTable}
      SET ${this.sql(data)}
      ${whereFragment}
      RETURNING *
    `
  }

  async delete() {
    if (this._conditions.length === 0) {
        throw new Error('[NeoPG] DELETE requires a WHERE condition')
    }

    const fullTable = this.sql`${this.sql(this.schema)}.${this.sql(this.tableName)}`

    const whereFragment = this.sql`WHERE ${this.sql(this._conditions, ' AND ')}`

    return await this.sql`
      DELETE FROM ${fullTable}
      ${whereFragment}
      RETURNING *
    `
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
