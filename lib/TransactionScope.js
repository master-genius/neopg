'use strict';

class TransactionScope {
  constructor(parent, trxSql) {
    this.parent = parent
    this.driver = trxSql
    this.sql = trxSql
  }

  table(tableName, schema = null) {
    const target = schema || this.parent.defaultSchema
    return new this.parent.ModelChain(this.driver, {tableName, isRaw: true}, target)
  }

  model(name, schema = null) {
    const item = this.parent.registry.get(name)
    if (!item) throw new Error(`[NeoPG] Model '${name}' not found.`)
    const target = schema || this.parent.defaultSchema
    return new item.Class(this.driver, item.def, target)
  }

  async transaction(callback) {
    return await this.driver.begin(async (sp) => {
      return await callback(new TransactionScope(this.parent, sp))
    })
  }
}

module.exports = TransactionScope
