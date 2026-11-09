import postgres from '../postgres/index.js'
import ModelDef from './ModelDef.js'
import SchemaSync from './SchemaSync.js'
import TransactionScope from './TransactionScope.js'
import ModelChain from './ModelChain.js'
import dataTypes from './dataTypes.js'

import path from 'node:path'
import fs from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// 保留 require 用于加载 CJS 模型文件（ESM 下无全局 require）
const require = createRequire(import.meta.url)

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
    this.driver = postgres(NeoPG._driverOptions(config))
    this.sql = this.driver
    
    this.defaultSchema = config.schema || 'public'
    this.registry = new Map()
    this.config = config
  }

  /**
   * 归一化驱动选项。
   *
   * postgres.js v4 起 `infer` 默认为 false，不再按值推断参数类型；
   * 而 NeoPG 的取值语义依赖该推断（如无类型上下文的 Buffer 参数），
   * 故此处默认开启，显式传入 infer 时以调用方为准。
   */
  static _driverOptions(config) {
    const options = { ...config }

    if (options.infer === undefined) options.infer = true

    return options
  }

  table(tableName, schema = null) {
    const target = schema || this.defaultSchema
    let m = new ModelChain(this, {tableName, isRaw: true}, target)
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
      ModelClass = ModelChain.from(input)
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
          console.error(`\x1b[33;3m[NeoPG]Warning: modelName is not specified, `
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
        console.error(`\x1b[33;7m[NeoPG]Warning: tableName is not specified, `
              + `use ${rawSchema.modelName.toLowerCase()} as the tableName\x1b[0m`)
      }, 100)
    }

    if ((/[a-z]/).test(rawSchema.modelName[0])) {
      throw new Error(`\x1b[31;7m[NeoPG] ${rawSchema.modelName}: modelName must start with an uppercase letter.\x1b[0m`)
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
   * 加载模型目录下的所有模型文件
   * 规则：
   * 1. 只加载 .js 和 .mjs 文件
   * 2. 跳过以 '_' 开头的文件 (视为内部共享模块)
   * 3. 跳过以 '!' 开头的文件 (视为保留或禁用文件)
   * 
   * @param {string} dirPath - 目录路径 (相对 process.cwd() 或绝对路径)
   * @param {stirng} modtype - 模块类型 cjs或esm，缺省 auto（按文件内容自动识别）
   */
  async loadModels(dirPath, modtype='auto') {
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

      if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') continue

      const fullFilePath = path.join(absPath, file)
      let modelExport

      try {
        modelExport = await this._importModule(fullFilePath, modtype)

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

  /**
   * 
   * @param {string} mname 
   */
  has(mname) {
    return this.registry.has(mname)
  }

  /**
   * 加载一组指定文件中的模型
   *
   * @param {array} mlist - 文件列表
   * @param {stirng} modtype - 模块类型 cjs或esm，缺省 auto（按文件内容自动识别）
   */
  async loadFiles(mlist, modtype='auto') {
    if (typeof mlist === 'string') {
      mlist = [mlist]
    }

    if (!Array.isArray(mlist)) {
      throw new Error(`[NeoPG] mlist is not [string]`)
    }

    let absPath
    let modelExport

    for (let m of mlist) {
      absPath = path.isAbsolute(m) ? m : path.resolve(process.cwd(), m)

      if (!/\.(mjs|cjs|js)$/.test(m)) continue

      modelExport = await this._importModule(absPath, modtype)

      if (!modelExport) {
        throw new Error(`[NeoPG] ${m}: no model export found (expected "export default" or "module.exports")`)
      }

      this.add(modelExport)
    }
  }

  /**
   * 加载单个模块并取出模型导出。
   *
   * NeoPG 3.x 以 ESM 为主形态，因此 auto 优先走 import()：
   * 它对 ESM、含顶层 await 的 ESM、以及 CJS 都能加载（CJS 会拿到 default = module.exports），
   * 且与 require() 共享模块实例，不会重复执行。
   * 仅在 import() 因「无法识别/解析该入口」而失败时才回退 require()。
   *
   * @param {string} filePath - 绝对路径
   * @param {stirng} modtype - cjs / esm / auto
   */
  async _importModule(filePath, modtype = 'auto') {
    const ext = path.extname(filePath)
    const fileUrl = pathToFileURL(filePath).href

    if (modtype === 'cjs' && ext !== '.mjs') {
      return this._unwrap(require(filePath))
    }

    if (modtype === 'esm') {
      return this._unwrap((await import(fileUrl)).default)
    }

    // auto：ESM 优先
    try {
      return this._unwrap((await import(fileUrl)).default)
    } catch (err) {
      // 只有「import() 识别不了该入口」才回退 require()。
      // 若失败源于模块自身执行（业务错误、语法错误）或依赖缺失，
      // 说明该文件已被真正执行过/原因与加载器无关，再 require() 只会让 CJS 重复执行一次，
      // 副作用不可控，因此直接上抛。
      const unresolvedEntry = err && (
        err.code === 'ERR_UNKNOWN_FILE_EXTENSION' ||
        err.code === 'ERR_UNSUPPORTED_DIR_IMPORT'
      )

      if (!unresolvedEntry) throw err

      try {
        return this._unwrap(require(filePath))
      } catch {
        // require 也失败时，抛原始 import 错误，信息更贴近真实原因
        throw err
      }
    }
  }

  /**
   * 从模块加载结果里取出真正的模型导出。
   * ESM 命名空间对象以 Symbol.toStringTag === 'Module' 标记，取 default。
   */
  _unwrap(mod) {
    if (mod && typeof mod === 'object' && mod[Symbol.toStringTag] === 'Module') {
      return mod.default
    }

    return mod
  }

}

NeoPG.dataTypes = dataTypes
NeoPG.ModelChain = ModelChain
NeoPG.postgres = postgres
NeoPG.SchemaSync = SchemaSync

export default NeoPG
export { NeoPG, dataTypes, ModelChain, SchemaSync }
