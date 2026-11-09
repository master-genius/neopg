// ============================================================
// NeoPG 3.0.0 完整测试套件
// 覆盖：ESM/CJS 双入口、模型加载、ORM 全链路、边界场景
// 用法：node test/suite.mjs
// ============================================================

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import NeoPG, { NeoPG as NamedNeoPG, dataTypes, ModelChain, SchemaSync } from 'neopg'

const CFG = {
  host: process.env.PGHOST || '127.0.0.1',
  user: process.env.PGUSER || 'wy',
  database: process.env.PGDATABASE || 'wdata',
  schema: 'neopg_test',
  max: 3
}

let pass = 0
let fail = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message.split('\n')[0]}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// 测试用的模型文件需能 import/require 到 neopg，
// 因此放在「本包被安装的 node_modules 可达范围内」：取本文件所在包的父级。
const pkgRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const TMP = fs.mkdtempSync(path.join(pkgRoot, '.neopg-test-'))

// 无论正常结束还是中途抛错，都保证清掉临时目录
const cleanupTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ } }
process.on('exit', cleanupTmp)
process.on('uncaughtException', (e) => { cleanupTmp(); console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { cleanupTmp(); console.error(e); process.exit(1) })

// ============================================================
section('1. 包入口与导出形状')
// ============================================================
await t('ESM default 导出是类', () => {
  assert.strictEqual(typeof NeoPG, 'function')
  assert.strictEqual(NeoPG.name, 'NeoPG')
})

await t('ESM 命名导出齐全且一致', () => {
  assert.strictEqual(NeoPG, NamedNeoPG)
  assert.strictEqual(NeoPG.dataTypes, dataTypes)
  assert.strictEqual(NeoPG.ModelChain, ModelChain)
  assert.strictEqual(NeoPG.SchemaSync, SchemaSync)
})

await t('dataTypes 常量正确', () => {
  assert.strictEqual(dataTypes.ID, 'varchar(16)')
  assert.strictEqual(dataTypes.INT, 'int')
  assert.strictEqual(dataTypes.JSONB, 'jsonb')
  assert.strictEqual(dataTypes.STRING(50), 'varchar(50)')
  assert.strictEqual(dataTypes.ARRAY(dataTypes.INT), 'int[]')
})

await t('CJS 入口形状与 ESM 一致', async () => {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const cjs = req('neopg')
  assert.strictEqual(typeof cjs, 'function')
  assert.strictEqual(cjs.name, 'NeoPG')
  assert.strictEqual(cjs.default, cjs)
  assert.strictEqual(cjs.NeoPG, cjs)
  assert.strictEqual(cjs.ModelChain, ModelChain)
})

// ============================================================
section('2. 驱动层（postgres.js v4 集成）')
// ============================================================
const db = new NeoPG(CFG)

await t('infer 默认开启（保持 v2 语义）', () => {
  assert.strictEqual(db.sql.options.infer, true)
})

await t('显式传 infer 时以调用方为准', () => {
  const d = new NeoPG({ ...CFG, infer: false })
  assert.strictEqual(d.sql.options.infer, false)
})

await t('sql.options.database 可用（SchemaSync 依赖）', () => {
  assert.strictEqual(db.sql.options.database, CFG.database)
})

await t('Buffer 参数推断为 bytea', async () => {
  const r = await db.sql`select ${Buffer.from('hi')} as v`
  assert.ok(Buffer.isBuffer(r[0].v), `期望 Buffer，实际 ${r[0].v?.constructor?.name}`)
  assert.strictEqual(r[0].v.toString(), 'hi')
})

await t('原生 sql 标签执行', async () => {
  const r = await db.sql`select 1 as x, 'a' as y`
  assert.strictEqual(r[0].x, 1)
  assert.strictEqual(r[0].y, 'a')
})

await t('sql.unsafe 带参数', async () => {
  const r = await db.sql.unsafe('select $1::int as v', [42])
  assert.strictEqual(r[0].v, 42)
})

await t('Result 元信息（count/columns）', async () => {
  const r = await db.sql`select 1 as a, 2 as b`
  assert.strictEqual(r.count, 1)
  assert.deepStrictEqual(r.columns.map(c => c.name), ['a', 'b'])
})

await t('listen / notify', async () => {
  let got = null
  const ch = 'neopg_suite_' + Math.random().toString(36).slice(2, 8)
  const l = await db.listen(ch, p => { got = p })
  await db.notify(ch, { hello: 'suite' })
  await new Promise(r => setTimeout(r, 400))
  await l.close()
  assert.deepStrictEqual(got, { hello: 'suite' })
})

await t('事务提交', async () => {
  const v = await db.transaction(async tx => {
    const r = await tx.sql`select 7 as v`
    return r[0].v
  })
  assert.strictEqual(v, 7)
})

await t('事务回滚', async () => {
  await assert.rejects(
    db.transaction(async tx => {
      await tx.sql`select 1`
      throw new Error('rollback-test')
    }),
    /rollback-test/
  )
})

await t('嵌套事务（savepoint）', async () => {
  const v = await db.transaction(async tx => {
    const a = await tx.sql`select 1 as v`
    const b = await tx.transaction(async tx2 => (await tx2.sql`select 2 as v`)[0].v)
    return [a[0].v, b]
  })
  assert.deepStrictEqual(v, [1, 2])
})

// ============================================================
section('3. 模型加载（modtype 自动识别）')
// ============================================================
const modelDir = path.join(TMP, 'models')
fs.mkdirSync(modelDir, { recursive: true })

fs.writeFileSync(path.join(modelDir, 'AstESM.js'), `
import { dataTypes, ModelChain } from 'neopg'
export default class AstESM extends ModelChain {
  static schema = { tableName: 't_esm', modelName: 'AstESM', primaryKey: 'id',
    column: { id: { type: dataTypes.ID }, name: { type: dataTypes.STRING(30) } } }
}`)

fs.writeFileSync(path.join(modelDir, 'AstMjs.mjs'), `
import { dataTypes, ModelChain } from 'neopg'
export default class AstMjs extends ModelChain {
  static schema = { tableName: 't_mjs', modelName: 'AstMjs', primaryKey: 'id',
    column: { id: { type: dataTypes.ID } } }
}`)

fs.writeFileSync(path.join(modelDir, 'AstTla.mjs'), `
import { dataTypes, ModelChain } from 'neopg'
const tag = await Promise.resolve('Tla')
export default class AstTla extends ModelChain {
  static schema = { tableName: 't_tla', modelName: 'Ast' + tag, primaryKey: 'id',
    column: { id: { type: dataTypes.ID } } }
}`)

fs.writeFileSync(path.join(modelDir, 'AstCjs.cjs'), `
'use strict'
const { dataTypes, ModelChain } = require('neopg')
globalThis.__astCjsLoads = (globalThis.__astCjsLoads || 0) + 1
class AstCjs extends ModelChain {
  static schema = { tableName: 't_cjs', modelName: 'AstCjs', primaryKey: 'id',
    column: { id: { type: dataTypes.ID } } }
}
module.exports = AstCjs`)

fs.writeFileSync(path.join(modelDir, '_private.js'), `throw new Error('下划线文件不应被加载')`)
fs.writeFileSync(path.join(modelDir, '!disabled.js'), `throw new Error('叹号文件不应被加载')`)

await t('loadModels 加载 .js(ESM) / .mjs / .cjs', async () => {
  await db.loadModels(modelDir)
  assert.ok(db.has('AstESM'), '.js ESM 未加载')
  assert.ok(db.has('AstMjs'), '.mjs 未加载')
  assert.ok(db.has('AstCjs'), '.cjs 未加载')
})

await t('loadModels 支持顶层 await 的 ESM', () => {
  assert.ok(db.has('AstTla'), '顶层 await 模型未加载')
})

await t('loadModels 忽略 _ 与 ! 前缀', () => {
  const names = [...db.registry.keys()]
  assert.ok(!names.some(n => n.startsWith('_') || n.startsWith('!')))
})

await t('CJS 模型只执行一次（不重复初始化）', () => {
  assert.strictEqual(globalThis.__astCjsLoads, 1, `期望 1，实际 ${globalThis.__astCjsLoads}`)
})

await t('loadFiles + 显式 modtype=esm', async () => {
  const d = new NeoPG(CFG)
  await d.loadFiles([path.join(modelDir, 'AstESM.js')], 'esm')
  assert.ok(d.has('AstESM'))
  await d.close()
})

await t('loadFiles + 显式 modtype=cjs', async () => {
  const d = new NeoPG(CFG)
  await d.loadFiles([path.join(modelDir, 'AstCjs.cjs')], 'cjs')
  assert.ok(d.has('AstCjs'))
  await d.close()
})

await t('模块抛错时不重复执行且保留原始错误', async () => {
  const badDir = path.join(TMP, 'bad')
  fs.mkdirSync(badDir, { recursive: true })
  fs.writeFileSync(path.join(badDir, 'Bad.cjs'), `
globalThis.__badLoads = (globalThis.__badLoads || 0) + 1
throw new Error('intentional-failure')`)

  const d = new NeoPG(CFG)
  await assert.rejects(d.loadModels(badDir), /intentional-failure/)
  assert.strictEqual(globalThis.__badLoads, 1, `模块被重复执行 ${globalThis.__badLoads} 次`)
  await d.close()
})

await t('无 default 导出时给出明确错误', async () => {
  const d = new NeoPG(CFG)
  const f = path.join(TMP, 'NoDefault.mjs')
  fs.writeFileSync(f, `export class NoDefault {}`)
  await assert.rejects(d.loadFiles([f]), /no model export found/)
  await d.close()
})

// ============================================================
section('4. ORM 全链路')
// ============================================================

class Item extends ModelChain {
  static schema = {
    tableName: 'suite_item',
    modelName: 'SuiteItem',
    primaryKey: 'id',
    column: {
      id: { type: dataTypes.ID },
      title: { type: dataTypes.STRING(50), default: '' },
      score: { type: dataTypes.INT, default: 0 },
      // NeoPG 的列默认是 NOT NULL，可空列需显式声明 notNull: false
      meta: { type: dataTypes.JSONB, notNull: false },
      created_at: { type: dataTypes.BIGINT, timestamp: 'insert' }
    },
    index: ['score'],
    unique: ['title']
  }
}
db.define(Item)

await t('createSchema + sync', async () => {
  await db.createSchema(CFG.schema).catch(() => {})
  await db.sync()
})

await t('insert 单条', async () => {
  await db.model('SuiteItem').where('1=1').delete()
  const r = await db.model('SuiteItem').insert({ title: 'one', score: 10 })
  assert.ok(r)
})

await t('insert 批量', async () => {
  await db.model('SuiteItem').insert([
    { title: 'two', score: 20, meta: { k: 2 } },
    { title: 'three', score: 30, meta: { k: 3 } }
  ])
  assert.strictEqual(await db.model('SuiteItem').count(), 3)
})

await t('find 全量', async () => {
  const rows = await db.model('SuiteItem').find()
  assert.strictEqual(rows.length, 3)
})

await t('get 单条 / 无结果返回 null', async () => {
  const one = await db.model('SuiteItem').where({ title: 'one' }).get()
  assert.strictEqual(one.title, 'one')
  const none = await db.model('SuiteItem').where({ title: 'nope' }).get()
  assert.strictEqual(none, null)
})

await t('where 对象条件 + null', async () => {
  const rows = await db.model('SuiteItem').where({ title: 'two' }).find()
  assert.strictEqual(rows.length, 1)
})

await t('where 数组条件（ANY）', async () => {
  const rows = await db.model('SuiteItem').where({ title: ['one', 'three'] }).find()
  assert.strictEqual(rows.length, 2)
})

await t('where 空数组不匹配任何行', async () => {
  const rows = await db.model('SuiteItem').where({ title: [] }).find()
  assert.strictEqual(rows.length, 0)
})

await t('where 三参数（字段/操作符/值）', async () => {
  const rows = await db.model('SuiteItem').where('score', '>', 15).find()
  assert.strictEqual(rows.length, 2)
})

await t('where sql 片段', async () => {
  const { sql } = db
  const rows = await db.model('SuiteItem').where(sql`score >= ${20}`).find()
  assert.strictEqual(rows.length, 2)
})

await t('select 指定列', async () => {
  const rows = await db.model('SuiteItem').select(['title', 'score']).where({ title: 'one' }).find()
  assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['score', 'title'])
})

await t('orderby / limit / page', async () => {
  const rows = await db.model('SuiteItem').orderby('score', 'DESC').limit(2).find()
  assert.deepStrictEqual(rows.map(r => r.score), [30, 20])
  const p = await db.model('SuiteItem').orderby('score', 'ASC').page(1, 2).find()
  assert.deepStrictEqual(p.map(r => r.score), [10, 20])
})

await t('JSONB 字段读写', async () => {
  const r = await db.model('SuiteItem').where({ title: 'two' }).get()
  const meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta
  assert.strictEqual(meta.k, 2)
})

await t('时间戳自动填充', async () => {
  const r = await db.model('SuiteItem').where({ title: 'one' }).get()
  assert.ok(r.created_at, 'created_at 未自动填充')
})

await t('count / findAndCount', async () => {
  assert.strictEqual(await db.model('SuiteItem').count(), 3)
  const fc = await db.model('SuiteItem').select().findAndCount()
  assert.strictEqual(fc.data.length, 3)
  assert.strictEqual(fc.total, 3)
})

await t('聚合 sum / avg / min / max', async () => {
  assert.strictEqual(await db.model('SuiteItem').sum('score'), 60)
  assert.strictEqual(await db.model('SuiteItem').avg('score'), 20)
  assert.strictEqual(await db.model('SuiteItem').min('score'), 10)
  assert.strictEqual(await db.model('SuiteItem').max('score'), 30)
})

await t('update + returning', async () => {
  const r = await db.model('SuiteItem').where({ title: 'one' }).returning('*').update({ score: 99 })
  assert.strictEqual(r.score, 99)
})

await t('update 无 where 时拒绝执行', async () => {
  await assert.rejects(db.model('SuiteItem').update({ score: 1 }), /requires a WHERE/)
})

await t('delete + count', async () => {
  const r = await db.model('SuiteItem').where({ title: 'three' }).delete()
  assert.strictEqual(r.count, 1)
})

await t('delete 无 where 时拒绝执行', async () => {
  await assert.rejects(db.model('SuiteItem').delete(), /requires a WHERE/)
})

await t('防重放：执行后不可复用', async () => {
  const q = db.model('SuiteItem').where('1=1')
  await q.find()
  await assert.rejects(q.find(), /already been executed/)
})

await t('clone 后复用', async () => {
  const q = db.model('SuiteItem').where('1=1')
  const a = await q.clone().find()
  const b = await q.clone().count()
  assert.ok(a.length >= 1 && b >= 1)
})

await t('事务内写操作', async () => {
  await db.transaction(async tx => {
    await tx.model('SuiteItem').where('1=1').delete()
    await tx.model('SuiteItem').insert({ title: 'tx-only', score: 1 })
  })
  const r = await db.model('SuiteItem').where({ title: 'tx-only' }).find()
  assert.strictEqual(r.length, 1)
})

await t('校验器生效（validate）', async () => {
  class Strict extends ModelChain {
    static schema = {
      tableName: 'suite_strict', modelName: 'SuiteStrict', primaryKey: 'id',
      column: {
        id: { type: dataTypes.ID },
        n: { type: dataTypes.INT, validate: v => v >= 0 && v < 10 }
      }
    }
  }
  db.define(Strict)
  await db.sync({ model: 'SuiteStrict' })
  await db.model('SuiteStrict').where('1=1').delete()
  await db.model('SuiteStrict').insert({ n: 5 })
  await assert.rejects(db.model('SuiteStrict').insert({ n: 100 }), /Validation failed/)
})

await t('join 关联查询', async () => {
  const { sql } = db
  const rows = await db.model('SuiteItem')
    .select(sql`suite_item.title`)
    .join(
      sql`${sql(CFG.schema)}.${sql('suite_item')} as b`,
      sql`b.id = suite_item.id`
    )
    .find()
  assert.ok(Array.isArray(rows))
})

// ============================================================
section('5. 清理')
// ============================================================
await t('清理测试数据', async () => {
  await db.model('SuiteItem').where('1=1').delete()
  await db.model('SuiteStrict').where('1=1').delete()
})

await t('close 正常关闭', async () => {
  await db.close()
})

fs.rmSync(TMP, { recursive: true, force: true })

// ============================================================
console.log('\n' + '='.repeat(52))
console.log(`通过: ${pass}   失败: ${fail}`)
if (fail > 0) {
  console.log('\n失败详情:')
  for (const f of failures) {
    console.log(`\n[${f.name}]`)
    console.log(f.error.stack)
  }
  process.exit(1)
} else {
  console.log('全部测试通过 ✓')
}