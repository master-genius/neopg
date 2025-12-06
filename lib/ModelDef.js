'use strict';

const dataTypes = require('./dataTypes.js')
const makeId = require('./makeId.js')
const forbidColumns = require('./forbidColumns.js')

class ModelDef {
  constructor(rawSchema) {
    this.tableName = rawSchema.tableName
    this.modelName = rawSchema.modelName || rawSchema.tableName
    this.primaryKey = rawSchema.primaryKey || 'id'
    this.columns = rawSchema.column || {}

    this._parseColumns()

    // 1. 解析主键相关信息 (pkLen, autoId)
    const pkInfo = this._parsePkInfo(rawSchema)
    this.pkLen = pkInfo.len
    this.autoId = pkInfo.auto
    this.makeId = makeId.serialId

    // 2. 时间戳配置
    this.timestamps = this._parseTimestamps()

    // 3. 静态默认值
    this.defaults = this._parseDefaults()

    this.validates = Object.create(null)
    this._parseValidate()
  }

  /**
   * 
   */
  _parseValidate() {
    for (let k in this.columns) {
      let col = this.columns[k]
      if (col.validate) {
        if (col.validate instanceof RegExp) {
          this.validates[k] = (v) => {
            return col.validate.test(v)
          }
        } else if (Array.isArray(col.validate)) {
          this.validates[k] = (v) => {
            return col.validate.includes(v)
          }
        } else if (typeof col.validate === 'function') {
          this.validates[k] = col.validate
        }
      }
    }
  }

  _parseColumns() {
    for (let k in this.columns) {
      if (forbidColumns.forbid.includes(k.toLowerCase().trim())) {
        throw new Error(`[NeoPG] Column name '${k}' in table '${this.tableName}' is FORBIDDEN.`)
      }

      if (!/^[a-z][a-z0-9_]*$/i.test(colName)) {
         throw new Error(`[NeoPG] Column name '${k}' is invalid. Only alphanumeric and underscore allowed, must start with letter.`)
      }
    }
  }

  /**
   * 解析主键策略
   * 产出: { len: Number, auto: Boolean }
   */
  _parsePkInfo(schema) {
    const pk = this.primaryKey
    const colDef = this.columns[pk]
    
    // 默认值
    let info = { len: 16, auto: true, type: 'string'}

    // 如果 Schema 显式关闭，优先级最高
    if (schema.autoId === false) {
      info.auto = false
      return info
    }

    // 如果没有主键定义，无法自动生成
    if (!colDef) {
      info.auto = false
      return info
    }

    // 显式指定了 autoIncrement (数据库自增)
    if (colDef.autoIncrement) {
      info.auto = false
      return info
    }

    // --- 类型分析 ---
    let typeStr = ''

    if (typeof colDef.type === 'string') {
      typeStr = colDef.type.toLowerCase().trim()
    } else {
      // 容错：如果 type 是 undefined
      info.auto = false
      return info
    }

    // A. 数据库自增类型 (serial, bigserial, integer/int 且未声明 autoId=true)
    if (typeStr.includes('serial')) {
      info.auto = false
      return info
    }

    if (typeStr === 'bigint') {
      info.auto = true
      info.type = 'number'
      this.makeId = makeId.bigId
      return info
    }
    
    // B. 字符串类型处理 (varchar, char, string, text)
    if (typeStr.includes('char') || typeStr.includes('varchar') || typeStr.includes('text')) {
      // 1. 尝试解析长度: varchar(32) -> 32
      const match = typeStr.match(/\((\d+)\)/)
      if (match && match[1]) {
        info.len = parseInt(match[1], 10)
      }
      
      // 2. 如果 Schema 根部定义了 pkLen，覆盖解析值
      if (schema.pkLen && typeof schema.pkLen === 'number') {
        if (info.len < schema.pkLen) {
          info.len = schema.pkLen
        } else if (info.len > schema.pkLen) {
          schema.pkLen = info.len
        }
      } else {
        schema.pkLen = info.len
      }
      
      info.auto = true
    } else {
      // 其他类型（如 int 但不是 serial），通常不自动生成字符串ID
      // 除非用户在 Schema 显式写了 autoId: true，否则偏向于 false
      if (schema.autoId !== true) {
         info.auto = false
      }
    }

    return info
  }

  _parseTimestamps() {
    const insertTs = []
    const updateTs = []

    for (const [colName, colDef] of Object.entries(this.columns)) {
      if (!colDef.timestamp) continue

      let typeStr = 'bigint'

      if (typeof colDef.type === 'string') {
        const t = colDef.type.toLowerCase()
        if (t.includes('int') && !t.includes('big')) typeStr = 'int'
        else if (t.includes('timestamp') || t.includes('date')) typeStr = 'timestamp'
      }

      const tuple = [colName, typeStr]

      if (colDef.timestamp === 'insert' || colDef.timestamp === true) {
        insertTs.push(tuple)
      } else if (colDef.timestamp === 'update') {
        insertTs.push(tuple)
        updateTs.push(tuple)
      }
    }

    return { insert: insertTs, update: updateTs }
  }

  _parseDefaults() {
    const defs = []
    for (const [colName, colDef] of Object.entries(this.columns)) {
      if (colDef.default !== undefined) {
        defs.push({ key: colName, val: colDef.default })
      }
    }
    return defs
  }

  validateField(key, value) {
    const col_validate = this.validates[key]
    if (!col_validate) return true

    if (value === undefined) {
      throw new Error(`[NeoPG] Field '${key}' is required.`)
    }

    if (!col_validate(value)) {
      throw new Error(`[NeoPG] Validation failed for field '${key}' with value: ${value}`)
    }

    return true
  }
}

module.exports = ModelDef