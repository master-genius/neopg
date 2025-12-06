'use strict';

const postgres = require('../postgres/index.js')
const ModelDef = require('./ModelDef.js')
const SchemaSync = require('./SchemaSync.js')
const TransactionScope = require('./TransactionScope.js')
const ModelChain = require('./ModelChain.js')
const dataTypes = require('./dataTypes.js')

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
    return new this.ModelChain(this, {tableName, isRaw: true}, target)
  }

  model(name, schema = null) {
    const item = this.registry.get(name)
    if (!item) throw new Error(`[NeoPG] Model '${name}' not found.`)
    
    const target = schema || this.defaultSchema
    return new item.Class(this, item.def, target)
  }

  // --- 注册 ---

  add(input) {
    let ModelClass

    if (typeof input === 'function') {
      ModelClass = input
    } else {
      ModelClass = this.ModelChain.from(input)
    }

    const rawSchema = ModelClass.schema
    if (!rawSchema) throw new Error(`[NeoPG] Missing static schema for ${ModelClass.name}`)

    const def = new ModelDef(rawSchema)

    this.registry.set(def.modelName, {
      Class: ModelClass,
      def: def
    })

    return this
  }

  define(model) {
    return this.add(model)
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

  async close() {
    await this.driver.end()
  }
}

NeoPG.dataTypes = dataTypes
NeoPG.ModelChain = ModelChain
NeoPG.postgres = postgres
NeoPG.SchemaSync = SchemaSync

module.exports = NeoPG
