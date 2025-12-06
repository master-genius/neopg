'use strict';

const path = require('path');
const process = require('node:process');
const randstring = require('./randstring.js');
const forbidColumns = require('./forbidColumns.js')

// 静态映射表 (保持原逻辑)
const DataTypeMap = {
  'varchar':    'character varying',
  'char':       'character',
  'text':       'text',
  'decimal':    'numeric',
  'numeric':    'numeric',
  'integer':    'integer',
  'int'    :    'integer',
  'smallint':   'smallint',
  'bigint':     'bigint',
  'boolean':    'boolean',
  'bytea':      'bytea',
  'jsonb':      'jsonb',
  'date':       'date',
  'time':       'time without time zone',
  'timestamp':  'timestamp without time zone',
  'timestamptz': 'timestamp with time zone',
};

const Numerics = ['smallint','bigint','integer','decimal','numeric', 'int'];
const Strings = ['char', 'varchar', 'text'];
const TypeWithBrackets = ['character varying', 'character', 'decimal', 'numeric'];
const DefaultWithType = ['varchar', 'char', 'text', 'bytea', 'timestamp', 'timestampz', 'date', 'time'];

class SchemaSync {

  /**
   * 入口方法
   */
  static async execute(sql, def, ctx, options = {}) {
    const debug = options.debug || false;
    const force = options.force || false;
    const dropNotExistCol = options.dropNotExistCol || false;
    const schema = ctx.defaultSchema || 'public';
    const tableName = def.tableName;
    const curTableName = `${schema}.${tableName}`;

    if (debug) console.log(`检测数据表 ${tableName} 的column...`);

    // 0. 检查列定义的合法性 (移植自 _checkFixColumn)
    // 简单复刻：NeoPG 的 ModelDef 已经做了一部分，这里补充检查
    for (let k in def.columns) {
      if (k.toLowerCase() !== k) {
        console.warn(`[NeoPG Warning] ${tableName} column ${k} 包含大写，Postgres会转小写，建议代码中改为小写。`);
      }
    }

    // 1. 获取 Schema OID (用于外键查询)
    let schemaOid = null;
    const nsRes = await sql`SELECT oid FROM pg_namespace WHERE nspname = ${schema}`;
    if (nsRes.length > 0) schemaOid = nsRes[0].oid;

    // 2. 检查表是否存在
    const tableInfo = await sql`
      SELECT * FROM information_schema.tables 
      WHERE table_catalog = ${sql.options.database} 
      AND table_schema = ${schema} 
      AND table_name = ${tableName}
    `;

    // A. 表不存在 -> 创建
    if (tableInfo.length === 0) {
      await this.createTable(sql, def, schema, curTableName, debug);
      // 同步索引、约束、外键
      await this.syncIndex(sql, def, schema, curTableName, debug);
      await this.syncUnique(sql, def, schema, curTableName, debug);
      await this.syncReferences(sql, def, schema, curTableName, schemaOid, debug, ctx);
      return;
    }

    // B. 表存在 -> 增量同步
    // 获取现有列信息
    const cols = await sql`
      SELECT column_name, data_type, column_default, character_maximum_length, 
             numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns 
      WHERE table_name = ${tableName} 
      AND table_schema = ${schema} 
      AND table_catalog = ${sql.options.database}
    `;

    const inf = {};
    for (const c of cols) inf[c.column_name] = c;

    // 预处理 rename 逻辑需要
    // 若存在 dropIndex 但是不存在 removeIndex 则指向 dropIndex (原逻辑)
    // NeoPG 中这部分配置可能需要从 def 传递进来，假设 def.rawSchema 包含这些配置
    // 为了简化，我们假设 def 上挂载了 extra 属性用于存储 index/unique 等非 column 配置

    await this.syncColumn(sql, def, inf, curTableName, debug, force, dropNotExistCol);
    await this.syncIndex(sql, def, schema, curTableName, debug);
    await this.syncUnique(sql, def, schema, curTableName, debug);
    await this.autoRemoveIndex(sql, def, schema, tableName, debug);
    await this.syncReferences(sql, def, schema, curTableName, schemaOid, debug, ctx);

    if (debug) console.log(` - 表结构同步完成 (${tableName}) - `);
  }

  // --- 创建表逻辑 ---
  static async createTable(sql, def, schema, curTableName, debug) {
    let colSqls = [];
    const qtag = randstring(12);

    for (let k in def.columns) {
      const col = def.columns[k];
      if (col.drop || col.ignore) continue;

      let line = `${this.fmtColName(k)} ${col.type}`;
      
      if (k === def.primaryKey) {
        line += ' primary key';
      } else {
        if (col.notNull !== false) line += ' not null';

        // 自动检测默认值逻辑
        let pt = this._parseType(col.type);
        if (col.default === undefined) {
          if (col.type.includes('[')) col.default = '{}';
          else if (Numerics.includes(pt)) col.default = 0;
          else if (Strings.includes(pt)) col.default = '';
        }

        if (col.default !== undefined) {
          if (col.default === null) line += ' default null';
          else line += ` default $${qtag}$${col.default}$${qtag}$`;
        }
      }
      colSqls.push(line);
    }

    // 联合主键
    if (Array.isArray(def.primaryKey)) {
       colSqls.push(`primary key (${def.primaryKey.join(',')})`);
    }

    const createSql = `CREATE TABLE IF NOT EXISTS ${curTableName} (${colSqls.join(',')})`;
    if (debug) console.log(createSql);
    await sql.unsafe(createSql);
  }

  // --- 列同步逻辑 (核心复杂逻辑) ---
  static async syncColumn(sql, def, inf, curTableName, debug, force, dropNotExistCol) {
    const qtag = randstring(12);
    let renameTable = {};

    for (let k in def.columns) {
      const col = def.columns[k];
      if (col.ignore) continue;

      // 1. Drop Column
      if (col.drop) {
        try {
          await sql.unsafe(`ALTER TABLE ${curTableName} DROP COLUMN IF EXISTS ${this.fmtColName(k)}`);
        } catch (e) {}
        continue;
      }

      // 2. Rename Check
      if (col.oldName && typeof col.oldName === 'string' && col.oldName.trim()) {
        const oldName = col.oldName.trim();
        if (inf[k] === undefined && inf[oldName]) {
          await sql.unsafe(`ALTER TABLE ${curTableName} RENAME ${this.fmtColName(oldName)} TO ${this.fmtColName(k)}`);
          inf[k] = inf[oldName]; // 更新内存信息
          renameTable[oldName] = true;
        }
      }

      let pt = this._parseType(col.type);
      let real_type = DataTypeMap[pt] || null;

      // 3. Add Column
      if (inf[k] === undefined) {
        let addSql = `ALTER TABLE ${curTableName} ADD COLUMN ${this.fmtColName(k)} ${col.type}`;
        if (col.notNull !== false) addSql += ' not null';

        // 默认值补全
        if (col.default === undefined) {
          if (col.type.includes('[')) col.default = '{}';
          else if (Numerics.includes(pt)) col.default = 0;
          else if (Strings.includes(pt)) col.default = '';
        }

        if (col.default !== undefined) {
            if (col.default === null) addSql += ' default null';
            else addSql += ` default $${qtag}$${col.default}$${qtag}$`;
        }

        if (debug) console.log(addSql);
        await sql.unsafe(addSql);
        continue;
      }

      if (col.typeLock) continue;
      if (real_type === null) continue; // 未知类型跳过

      // 4. Check Type Change
      if (this._compareType(inf[k], col, real_type) === false) {
        let alterSql = `ALTER TABLE ${curTableName} ALTER COLUMN ${this.fmtColName(k)} TYPE ${col.type}`;
        
        // 特殊处理字符串转非字符串的问题
        const isDbString = inf[k].data_type === 'text' || inf[k].data_type.includes('character');
        const isTargetString = Strings.includes(this._parseType(col.type));

        if (isDbString && !isTargetString) {
           if (col.force) {
             // 强制重建列
             await sql.unsafe(`ALTER TABLE ${curTableName} DROP COLUMN ${this.fmtColName(k)}`);
             let reAddSql = `ALTER TABLE ${curTableName} ADD COLUMN ${this.fmtColName(k)} ${col.type}`;
             if (col.notNull !== false) reAddSql += ' not null';
             if (col.default !== undefined) reAddSql += ` default $${qtag}$${col.default}$${qtag}$`;
             await sql.unsafe(reAddSql);
             col.changed = true; // 标记变更，供外键处理使用
             continue;
           } else {
             console.error(`Error: ${k} 从字符串转向其他类型无转换规则，且未设置force选项。`);
             continue;
           }
        }

        if (debug) console.log(alterSql);
        try {
          await sql.unsafe(alterSql);
          col.changed = true;
        } catch (err) {
          console.error('Type alter error:', err.message);
          continue;
        }
      }

      // 5. Check Default Value
      if (col.default !== undefined) {
        // 简单比对逻辑 (注：PG存储的默认值格式可能不同，这里仅作简单触发)
        // 实际生产中可能需要更复杂的解析，这里保留原逻辑结构
        // 原逻辑用了 _realDefault 方法，这里我们简单处理，仅当需要时设置
        let default_val_sql = col.default === null ? 'null' : `$${qtag}$${col.default}$${qtag}$`;
        // 这里为了简化，每次都重设默认值（开销很小），或者你需要实现 _realDefault
        await sql.unsafe(`ALTER TABLE ${curTableName} ALTER COLUMN ${this.fmtColName(k)} SET DEFAULT ${default_val_sql}`);
      }

      // 6. Check Not Null
      if (col.notNull === undefined || col.notNull) {
        if (inf[k].is_nullable === 'YES') {
          await sql.unsafe(`ALTER TABLE ${curTableName} ALTER COLUMN ${this.fmtColName(k)} SET NOT NULL`);
        }
      } else {
        if (inf[k].is_nullable === 'NO') {
          // 难以恢复为 Nullable，跳过
        }
      }
    }

    // 7. Drop Not Exist (Force Mode)
    if (dropNotExistCol) {
      for (let k in inf) {
        if (!def.columns[k] && !renameTable[k]) {
           await sql.unsafe(`ALTER TABLE ${curTableName} DROP COLUMN ${this.fmtColName(k)}`);
        }
      }
    }
  }

  // --- 索引同步 ---
  static async syncIndex(sql, def, schema, curTableName, debug) {
    // 假设索引定义在 def.rawSchema.index (数组)
    // ModelDef 需要暴露这个属性，或 def.indices
    const indices = def.rawSchema && def.rawSchema.index ? def.rawSchema.index : [];
    if (!Array.isArray(indices)) return;

    for (const indname of indices) {
        // 检查 removeIndex 配置
        const removeIndex = def.rawSchema.removeIndex || [];
        if (removeIndex.includes(indname)) continue;

        // 检查列是否存在
        if (!this._checkColumnsExist(indname, def)) {
            console.error(`Index ${indname} 包含不存在的列，跳过。`);
            continue;
        }

        // 检查索引是否存在
        const idxCols = indname.split(',').map(s=>s.trim()).filter(s=>s);
        const idxNamePart = idxCols.join('_');
        const targetIdxName = `${def.tableName}_${idxNamePart}_idx`;

        // 使用 pg_indexes 查询
        // 注意：pg_indexes 不支持 unsafe 拼 schema，只能查 schemaname 列
        const exist = await sql`
            SELECT * FROM pg_indexes 
            WHERE tablename = ${def.tableName} 
            AND schemaname = ${schema} 
            AND indexname = ${targetIdxName}
        `;

        if (exist.length > 0) continue;

        // 创建索引
        // 支持 using gin 等 (这里简化处理，假设无特殊 using)
        // 你的原代码有 indexType 检测，这里简单复刻
        // let ind_using = ...
        await sql.unsafe(`CREATE INDEX ON ${curTableName} (${idxCols.map(c=>this.fmtColName(c)).join(',')})`);
    }
  }

  static async syncUnique(sql, def, schema, curTableName, debug) {
      const uniques = def.rawSchema && def.rawSchema.unique ? def.rawSchema.unique : [];
      if (!Array.isArray(uniques)) return;

      for (const indname of uniques) {
          if (!this._checkColumnsExist(indname, def)) continue;

          const idxCols = indname.split(',').map(s=>s.trim()).filter(s=>s);
          const idxNamePart = idxCols.join('_');
          const targetIdxName = `${def.tableName}_${idxNamePart}_idx`; // Unique 索引命名通常也遵循此规则，或有 _key 后缀，这里假设一致

          const exist = await sql`
            SELECT * FROM pg_indexes 
            WHERE tablename = ${def.tableName} 
            AND schemaname = ${schema} 
            AND indexname = ${targetIdxName}
          `;

          if (exist.length > 0) continue;

          await sql.unsafe(`CREATE UNIQUE INDEX ON ${curTableName} (${idxCols.map(c=>this.fmtColName(c)).join(',')})`);
      }
  }

  static async autoRemoveIndex(sql, def, schema, tableName, debug) {
      // 1. 获取当前所有索引
      const allIdx = await sql`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = ${tableName} 
        AND schemaname = ${schema} 
        AND indexname != ${tableName + '_pkey'}
      `;
      
      if (allIdx.length === 0) return;

      const currentIdxNames = allIdx.map(i => i.indexname);
      
      // 2. 计算应该保留的索引名
      const indices = def.rawSchema && def.rawSchema.index ? def.rawSchema.index : [];
      const uniques = def.rawSchema && def.rawSchema.unique ? def.rawSchema.unique : [];
      
      const keepSet = new Set();
      const makeName = (n) => `${tableName}_${n.split(',').map(x=>x.trim()).filter(x=>x).join('_')}_idx`;

      indices.forEach(n => keepSet.add(makeName(n)));
      uniques.forEach(n => keepSet.add(makeName(n)));

      // 3. 差集删除
      for (const idxName of currentIdxNames) {
          if (!keepSet.has(idxName)) {
              if (debug) console.log('Auto removing index:', idxName);
              await sql.unsafe(`DROP INDEX ${schema}.${idxName}`);
          }
      }
  }

  // --- 外键同步 ---
  static async syncReferences(sql, def, schema, curTableName, schemaOid, debug, ctx) {
      // 1. 收集定义中的外键
      // 格式: { fkName: "xxx", createSql: "..." }
      let targetFKs = new Map();
      const qtag = randstring(8);

      for (let k in def.columns) {
          const col = def.columns[k];
          if (!col.ref) continue;

          // 解析 ref: "ModelName:colName"
          const [refModelName, refColName] = this._parseRef(col.ref, k);
          
          // 加载目标模型 (这里需要通过 ctx (NeoPG实例) 获取其他模型)
          // 假设 ctx.registry.get(refModelName) 能拿到
          // 或者如果是文件路径，尝试 require
          
          // 为了简化复刻，这里假设我们能拿到目标表名
          // 在原逻辑中是 require 文件，这里建议 NeoPG 注册机制解决
          // 这里做一个适配：
          let targetTableName = '';
          if (ctx.registry && ctx.registry.get(refModelName)) {
             targetTableName = ctx.registry.get(refModelName).def.tableName;
          } else {
             // 尝试作为表名直接使用 (Fallback)
             targetTableName = refModelName.toLowerCase(); 
          }

          // 构建外键名
          const fkName = `${def.tableName}_${k}_fkey`;
          
          // 构建 REFERENCES 子句
          let refSql = `REFERENCES ${schema}.${targetTableName} (${refColName})`;
          if (col.refActionUpdate) refSql += ` ON UPDATE ${col.refActionUpdate}`;
          else refSql += ` ON UPDATE CASCADE`; // 默认

          if (col.refActionDelete) refSql += ` ON DELETE ${col.refActionDelete}`;
          else refSql += ` ON DELETE CASCADE`; // 默认

          targetFKs.set(fkName, { col: k, sql: refSql, changed: col.changed });
      }

      // 2. 获取数据库现有外键
      const existFKs = new Set();
      if (targetFKs.size > 0 && schemaOid) {
          // 构建 IN 查询
          const names = Array.from(targetFKs.keys());
          const rows = await sql`
              SELECT conname FROM pg_constraint 
              WHERE connamespace = ${schemaOid} 
              AND contype = 'f' 
              AND conname IN ${sql(names)}
          `;
          rows.forEach(r => existFKs.add(r.conname));
      }

      // 3. 同步
      for (const [fkName, conf] of targetFKs) {
          // 如果变更了列类型，必须先删后加
          if (existFKs.has(fkName) && conf.changed) {
              await sql.unsafe(`ALTER TABLE ${curTableName} DROP CONSTRAINT ${fkName}`);
              existFKs.delete(fkName);
          }

          if (!existFKs.has(fkName)) {
              const addSql = `ALTER TABLE ${curTableName} ADD CONSTRAINT ${fkName} FOREIGN KEY (${conf.col}) ${conf.sql}`;
              if (debug) console.log(addSql);
              await sql.unsafe(addSql);
          }
      }
  }

  // --- 辅助方法 ---

  static fmtColName(col) {
      // 简单处理引用
      if (forbidColumns.quote.includes(col.toLowerCase())) {
          return `"${col}"`;
      }

      return `"${col}"`;
  }

  static _parseType(t) {
      const idx = t.indexOf('(');
      if (idx > 0) return t.substring(0, idx).trim().toLowerCase();
      const idx2 = t.indexOf('[');
      if (idx2 > 0) return t.substring(0, idx2).trim().toLowerCase();
      return t.trim().toLowerCase();
  }

  static _compareType(f, col, real_type) {
      if (!TypeWithBrackets.includes(real_type)) {
          return f.data_type === real_type;
      }
      
      // 括号解析
      // 原逻辑 _parseBrackets 
      const idx = col.type.indexOf('(');
      const brackets = idx > 0 ? col.type.substring(idx).trim() : '';

      if (f.data_type.startsWith('character')) {
         return `${f.data_type}(${f.character_maximum_length})` === `${real_type}${brackets}`;
      }
      
      // numeric(p,s)
      if (f.data_type === 'numeric' || f.data_type === 'decimal') {
         // 注意 PG 返回的 precision 可能是 null
         const p = f.numeric_precision;
         const s = f.numeric_scale;
         if (!p) return `${real_type}${brackets}` === real_type; // 无精度对比
         return `${f.data_type}(${p},${s})` === `${real_type}${brackets}`;
      }

      return false; // Fallback
  }

  static _checkColumnsExist(colsStr, def) {
      const parts = colsStr.split(',').map(x=>x.trim()).filter(x=>x);
      for (const p of parts) {
          if (!def.columns[p]) return false;
      }
      return true;
  }

  static _parseRef(refstr, curColumn) {
      if (refstr.includes(':')) {
          const parts = refstr.split(':');
          // 处理 Model:col 格式，取最后一部分做 col，前面做 Model
          const col = parts.pop();
          const model = parts.join(':');
          return [model, col];
      }
      return [refstr, curColumn];
  }
}

module.exports = SchemaSync;