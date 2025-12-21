'use strict';

class TransactionScope {
  constructor(parent, trxSql) {
    this.parent = parent
    this.driver = trxSql
    this.sql = trxSql
    this.defaultSchema = this.parent.defaultSchema
  }

  table(tableName, schema = null) {
    const target = schema || this.parent.defaultSchema
    let m = new this.parent.ModelChain(this, {tableName, isRaw: true}, target)
    m._isRaw = true
    return m
  }

  model(name, schema = null) {
    const item = this.parent.registry.get(name)
    if (!item) throw new Error(`[NeoPG] Model '${name}' not found.`)
    const target = schema || this.parent.defaultSchema
    let m = new item.Class(this, item.def, target)
    if (!m.def) {
      m.def = item.def
      m.ctx = this.parent
      m.sql = this.sql
      m.schema = target
    }

    return m
  }

  async transaction(callback) {
    return await this.driver.begin(async (sp) => {
      return await callback(new TransactionScope(this.parent, sp))
    })
  }

  begin(callback) {
    return this.transaction(callback)
  }
}

module.exports = TransactionScope
