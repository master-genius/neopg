'use strict';

const postgres = require('../postgres/index.js')
const ModelDef = require('./ModelDef.js')
const SchemaSync = require('./SchemaSync.js')
const TransactionScope = require('./TransactionScope.js')
const ModelChain = require('./ModelChain.js')
const dataTypes = require('./dataTypes.js')

const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

/**
 * 将下划线命名转换为大驼峰命名 (e.g. shop_order -> ShopOrder)
 */
function toPascalCase(str) {
  if (!str) return ''

  return str.split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
}

class NeoPG {
  constructor(config) {
    this.driver = postgres(config)
    this.ModelChain = ModelChain
    this.sql = this.driver
    
    this.defaultSchema = config.schema || 'public'
    this.registry = new Map()
    this.config = config
  }

  table(tableName, schema = null) {
    const target = schema || this.defaultSchema
    let m = new this.ModelChain(this, {tableName, isRaw: true}, target)
    m._isRaw = true
    return m
  }

  model(name, schema = null) {
    const item = this.registry.get(name)
    if (!item) throw new Error(`[NeoPG] Model '${name}' not found.`)
    
    const target = schema || this.defaultSchema
    let m = new item.Class(this, item.def, target)

    if (!m.def) {
      m.ctx = this
      m.sql = this.sql
      m.def = item.def
      m.schema = target
    }

    return m
  }

  // --- 注册 ---

  add(input, is_reset=false) {
    let ModelClass

    if (typeof input === 'function') {
      ModelClass = input
    } else {
      ModelClass = this.ModelChain.from(input)
    }

    const rawSchema = ModelClass.schema

    if (!rawSchema) throw new Error(`[NeoPG] Missing static schema for ${ModelClass.name}`)

    // 如果没有显式指定 modelName，则尝试自动推断
    if (!rawSchema.modelName) {
      const className = ModelClass.name
      
      const genericNames = ['AnonymousModel', 'ModelChain', 'Function', '']

      // 1. 优先尝试使用类名 (如果类名不是通用的)
      if (className && !genericNames.includes(className)) {
        rawSchema.modelName = className
      } else if (rawSchema.tableName) {
        rawSchema.modelName = toPascalCase(rawSchema.tableName)
        setTimeout(() => {
          console.error(`\x1b[33;5m[NeoPG]Warning: modelName is not specified, `
                + `use ${rawSchema.modelName} as the modelName\x1b[0m`)
        }, 100)
      } else {
        // 此时说明modelName无法确定，但是tableName也没有指定
        throw new Error(`\x1b[31m[NeoPG] Missing modelName and tableName\x1b[0m`)
      }
    }

    //经过以上处理，modelName已经确定了，此时若没有指定tableName则把modelName转换为小写作为tableName
    if (!rawSchema.tableName) {
      rawSchema.tableName = rawSchema.modelName.toLowerCase()

      setTimeout(() => {
        console.error(`\x1b[33;5m[NeoPG]Warning: tableName is not specified, `
              + `use ${rawSchema.modelName.toLowerCase()} as the tableName\x1b[0m`)
      }, 100)
    }

    if ((/[a-z]/).test(rawSchema.modelName[0])) {
      throw new Error(`\x1b[31;5m[NeoPG] ${rawSchema.modelName}: modelName must start with an uppercase letter.\x1b[0m`)
    }

    const def = new ModelDef(rawSchema)

    //已经存在又不是更新，则报错
    if (!is_reset && this.registry.has(def.modelName)) {
      throw new Error(`[NeoPG] modelName conflict: ${def.modelName}`)
    }

    this.registry.set(def.modelName, {
      Class: ModelClass,
      def: def
    })

    return this
  }

  define(model) {
    return this.add(model)
  }

  set(model) {
    return this.add(model, true)
  }

  // --- 事务 ---
  async transaction(callback) {
    return await this.driver.begin(async (trxSql) => {
      const scope = new TransactionScope(this, trxSql)
      return await callback(scope)
    })
  }

  begin(callback) {
    return this.transaction(callback)
  }

  // --- 同步 ---
  async sync(options = {}) {
    if (!options || typeof options !== 'object') {
      options = {}
    }

    if (!options.schema) options.schema = this.defaultSchema

    if (options.model) {
      let model = this.registry.get(options.model)

      if (!model) {
        throw new Error(`[NeoPG] sync: ${options.model} not found.`)
      }

      return await SchemaSync.execute(this.driver, model.def, this, options)
    }

    for (const item of this.registry.values()) {
      await SchemaSync.execute(this.driver, item.def, this, options)
    }
  }

  /**
   * 监听 Postgres 消息通道
   * @param {string} channel - 通道名称
   * @param {Function} callback - (payload) => {}
   * @returns {Object} 包含 unlisten 方法的对象
   */
  async listen(channel, callback) {
    // postgres.js 的 listen 返回一个 Promise<void>
    // 但它内部会维持连接。我们需要提供一种方式来取消监听。
    // postgres.js v3 使用 sql.listen(channel, cb) 并返回一个 state 对象用于 close
    const listener = await this.sql.listen(channel, (payload) => {
      // 可以在这里统一处理 JSON 解析等
      try {
        const data = JSON.parse(payload)
        callback(data)
      } catch (e) {
        // 无法解析则返回原始字符串
        callback(payload)
      }
    })

    return {
      // 返回一个句柄用于取消监听
      close: () => listener.unlisten() 
    }
  }

  /**
   * 发送通知
   * @param {string} channel 
   * @param {string|Object} payload 
   */
  async notify(channel, payload) {
    const data = typeof payload === 'object' ? JSON.stringify(payload) : payload

    // 使用 sql.notify 是最高效的
    await this.sql.notify(channel, data)
  }

  createSchema(name) {
    return SchemaSync.createSchema(this.sql, name)
  }

  async close() {
    await this.driver.end()
  }

  /**
   * 自动加载指定目录下的模型文件
   * 规则：
   * 1. 只加载 .js 和 .mjs 文件
   * 2. 跳过以 '_' 开头的文件 (视为内部共享模块)
   * 3. 跳过以 '!' 开头的文件 (视为保留或禁用文件)
   * 
   * @param {string} dirPath - 目录路径 (相对 process.cwd() 或绝对路径)
   */
  async loadModels(dirPath) {
    // 解析绝对路径
    const absPath = path.isAbsolute(dirPath) 
      ? dirPath 
      : path.resolve(process.cwd(), dirPath)

    if (!fs.existsSync(absPath)) {
      throw new Error(`[NeoPG] Models directory not found: ${absPath}`)
    }

    const files = fs.readdirSync(absPath)

    for (const file of files) {
      // 过滤规则
      if (file.startsWith('_') || file.startsWith('!')) continue
      
      const ext = path.extname(file)

      if (ext !== '.js' && ext !== '.mjs') continue

      const fullFilePath = path.join(absPath, file)
      let modelExport

      try {
        if (ext === '.mjs') {
          // 处理 ESM 动态导入
          // Windows 下 import() 需要 file:// 协议路径
          const fileUrl = pathToFileURL(fullFilePath).href
          const imported = await import(fileUrl)
          modelExport = imported.default
        } else {
          // 处理 CommonJS
          modelExport = require(fullFilePath)
        }

        // 注册模型 (如果导出为空或不是合法对象/类，add 方法内部会抛错或处理)
        if (modelExport) {
          this.add(modelExport)
        }
      } catch (err) {
        console.error(`[NeoPG] Failed to load model: ${file}`)
        throw err
      }
    }

    return this
  }

}

NeoPG.dataTypes = dataTypes
NeoPG.ModelChain = ModelChain
NeoPG.postgres = postgres
NeoPG.SchemaSync = SchemaSync

module.exports = NeoPG
