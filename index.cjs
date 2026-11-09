'use strict'

/**
 * CommonJS 入口。
 *
 * 本包主体为 ESM，此文件仅做导出形状整形：
 * 把 ESM 命名空间收敛成 v2 时代 `module.exports = NeoPG` 的形态，
 * 使 `const NeoPG = require('neopg')` 与解构用法都能继续工作。
 *
 * 依赖 Node 的 require(esm) 能力（Node >= 22.12 默认启用）。
 */
const ns = require('./index.js')

const NeoPG = ns.default

module.exports = NeoPG
module.exports.default = NeoPG
module.exports.NeoPG = NeoPG
module.exports.dataTypes = ns.dataTypes
module.exports.ModelChain = ns.ModelChain
module.exports.SchemaSync = ns.SchemaSync