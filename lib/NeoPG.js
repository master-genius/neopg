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
    return new this.ModelChain(this.driver, {tableName, isRaw: true}, target)
  }

  model(name, schema = null) {
    const item = this.registry.get(name)
    if (!item) throw new Error(`[NeoPG] Model '${name}' not found.`)
    
    const target = schema || this.defaultSchema
    return new item.Class(this.driver, item.def, target)
  }

  // --- 注册 ---

  add(input) {
    let ModelClass;
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

  // --- 事务 ---
  async transaction(callback) {
    return await this.driver.begin(async (trxSql) => {
      const scope = new TransactionScope(this, trxSql)
      return await callback(scope)
    })
  }

  // --- 同步 ---
  async sync(options = {}) {
    for (const item of this.registry.values()) {
      await SchemaSync.execute(this.driver, item.def, this, options)
    }
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
