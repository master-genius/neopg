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
const DefaultWithType = ['varchar', 'char', 'text', 'bytea', 'timestamp', 'timestamptz', 'date', 'time'];

class SchemaSync {

  static async createSchema(sql, schema) {
    return sql.unsafe(`create schema if not exists ${schema};`)
  }

  /**
   * 入口方法
   */
  static async execute(sql, def, ctx, options = {}) {
    const debug = options.debug || false;
    const force = options.force || false;
    const dropNotExistCol = force || options.dropNotExistCol || false;
    const schema = options.schema || ctx.defaultSchema || 'public';
    const tableName = def.tableName;
    const curTableName = `${schema}.${tableName}`;

    // [递归锁初始化]
    if (!options.syncedModels) {
        options.syncedModels = new Set();
    }

    if (options.syncedModels.has(def.modelName)) {
        return; 
    }
    options.syncedModels.add(def.modelName);

    if (debug) console.log(`检测数据表 ${tableName} 的column...`);

    // 0. 检查列定义的合法性
    for (let k in def.columns) {
      if (k.toLowerCase() !== k) {
        console.warn(`[NeoPG Warning] ${tableName} column ${k} 包含大写，Postgres会转小写，建议代码中改为小写。`);
      }
    }

    // 1. 获取 Schema OID
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
      await this.syncIndex(sql, def, schema, curTableName, debug);
      await this.syncUnique(sql, def, schema, curTableName, debug);
      await this.syncReferences(sql, def, schema, curTableName, schemaOid, debug, ctx, options);
      return;
    }

    // B. 表存在 -> 增量同步
    const cols = await sql`
      SELECT column_name, data_type, column_default, character_maximum_length, 
             numeric_precision, numeric_scale, is_nullable, is_generated
      FROM information_schema.columns 
      WHERE table_name = ${tableName} 
      AND table_schema = ${schema} 
      AND table_catalog = ${sql.options.database}
    `;

    const inf = {};
    for (const c of cols) inf[c.column_name] = c;

    await this.syncColumn(sql, def, inf, curTableName, debug, force, dropNotExistCol);
    await this.syncIndex(sql, def, schema, curTableName, debug);
    await this.syncUnique(sql, def, schema, curTableName, debug);
    await this.autoRemoveIndex(sql, def, schema, tableName, debug);
    await this.syncReferences(sql, def, schema, curTableName, schemaOid, debug, ctx, options);

    if (debug) console.log(` - 表结构同步完成 (${tableName}) - `);
  }

  // --- [NEW] 抽取出的默认值推导逻辑 ---
  static _ensureDefaultValue(col) {
      // 如果已经有默认值定义，则跳过
      if (col.default !== undefined) return;

      const pt = this._parseType(col.type);
      
      if (col.type.includes('[')) {
          col.default = '{}';
      } else if (Numerics.includes(pt)) {
          col.default = 0;
      } else if (Strings.includes(pt)) {
          col.default = '';
      }
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

        // [Modified] 使用统一方法推导默认值
        this._ensureDefaultValue(col);

        if (col.default !== undefined) {
          if (col.default === null) line += ' default null';
          else line += ` default $_${qtag}_$${col.default}$_${qtag}_$`;
        }
      }
      colSqls.push(line);
    }

    if (Array.isArray(def.primaryKey)) {
       colSqls.push(`primary key (${def.primaryKey.join(',')})`);
    }

    const createSql = `CREATE TABLE IF NOT EXISTS ${curTableName} (${colSqls.join(',')})`;
    if (debug) console.log(createSql);
    await sql.unsafe(createSql);
  }

  // --- 列同步逻辑 ---
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
          inf[k] = inf[oldName];
          renameTable[oldName] = true;
        }
      }

      let pt = this._parseType(col.type);
      let real_type = DataTypeMap[pt] || null;

      // 3. Add Column
      if (inf[k] === undefined) {
        let addSql = `ALTER TABLE ${curTableName} ADD COLUMN ${this.fmtColName(k)} ${col.type}`;
        if (col.notNull !== false) addSql += ' not null';

        // [Modified] 使用统一方法推导默认值
        this._ensureDefaultValue(col);

        if (col.default !== undefined) {
            if (col.default === null) addSql += ' default null';
            else addSql += ` default $_${qtag}_$${col.default}$_${qtag}_$`;
        }

        if (debug) console.log(addSql);
        await sql.unsafe(addSql);
        continue;
      }

      if (col.typeLock) continue;
      if (real_type === null) continue; 

      // 4. Check Type Change
      if (this._compareType(inf[k], col, real_type) === false) {
        let alterSql = `ALTER TABLE ${curTableName} ALTER COLUMN ${this.fmtColName(k)} TYPE ${col.type}`;
        
        const isDbString = inf[k].data_type === 'text' || inf[k].data_type.includes('character');
        const isTargetString = Strings.includes(this._parseType(col.type));

        if (isDbString && !isTargetString) {
           if (col.force) {
             // 强制重建列
             await sql.unsafe(`ALTER TABLE ${curTableName} DROP COLUMN ${this.fmtColName(k)}`);
             
             let reAddSql = `ALTER TABLE ${curTableName} ADD COLUMN ${this.fmtColName(k)} ${col.type}`;
             if (col.notNull !== false) reAddSql += ' not null';
             
             // [Modified] 强制重建时，必须先推导默认值，否则 not null 会导致已有数据报错
             this._ensureDefaultValue(col);

             if (col.default !== undefined) {
                 if (col.default === null) reAddSql += ' default null';
                 else reAddSql += ` default $_${qtag}_$${col.default}$_${qtag}_$`;
             }

             await sql.unsafe(reAddSql);
             col.changed = true;
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

      // 5. Check Default Value (Only alter if explicitly changed or added)
      if (col.default !== undefined) {
        let default_val_sql = col.default === null ? 'null' : `$_${qtag}_$${col.default}$_${qtag}_$`;
        await sql.unsafe(`ALTER TABLE ${curTableName} ALTER COLUMN ${this.fmtColName(k)} SET DEFAULT ${default_val_sql}`);
      }

      // 6. Check Not Null
      if (col.notNull === undefined || col.notNull) {
        if (inf[k].is_nullable === 'YES') {
          await sql.unsafe(`ALTER TABLE ${curTableName} ALTER COLUMN ${this.fmtColName(k)} SET NOT NULL`);
        }
      }
    }

    // 7. Drop Not Exist (Force Mode)
    if (dropNotExistCol) {
      for (let dbColName in inf) {
        if (!def.columns[dbColName] && !renameTable[dbColName]) {
           const dbCol = inf[dbColName];
           if (dbCol.is_generated === 'ALWAYS') {
             if (debug) console.log(`[NeoPG] Ignoring DB-only generated column: ${dbColName}`);
             continue;
           }
           if (debug) console.log(`Deleting unused column: ${dbColName}`);
           await sql.unsafe(`ALTER TABLE ${curTableName} DROP COLUMN ${this.fmtColName(dbColName)}`);
        }
      }
    }
  }

  // --- 索引同步 ---
  static async syncIndex(sql, def, schema, curTableName, debug) {
    const indices = def.index || [];
    if (!Array.isArray(indices)) return;

    for (const indname of indices) {
        const removeIndex = def.removeIndex || [];
        if (removeIndex.includes(indname)) continue;

        if (!this._checkColumnsExist(indname, def)) {
            console.error(`Index ${indname} 包含不存在的列，跳过。`);
            continue;
        }

        let idxCols = Array.isArray(indname) ? indname : indname.split(',').map(s=>s.trim()).filter(s=>s);
        const idxNamePart = idxCols.join('_');
        const targetIdxName = `${def.tableName}_${idxNamePart}_idx`;

        const exist = await sql`
            SELECT * FROM pg_indexes 
            WHERE tablename = ${def.tableName} 
            AND schemaname = ${schema} 
            AND indexname = ${targetIdxName}
        `;

        if (exist.length > 0) continue;
        await sql.unsafe(`CREATE INDEX ON ${curTableName} (${idxCols.map(c=>this.fmtColName(c)).join(',')})`);
    }
  }

  static async syncUnique(sql, def, schema, curTableName, debug) {
      const uniques = def.unique || [];
      if (!Array.isArray(uniques)) return;

      const pkSet = new Set();
      if (Array.isArray(def.primaryKey)) {
          def.primaryKey.forEach(k => pkSet.add(k));
      } else if (def.primaryKey) {
          pkSet.add(def.primaryKey);
      }

      for (const indname of uniques) {
          if (!this._checkColumnsExist(indname, def)) continue;

          let idxCols = Array.isArray(indname) ? indname : indname.split(',').map(s=>s.trim()).filter(s=>s);

          // 监测是否等于主键
          if (pkSet.size > 0 && idxCols.length === pkSet.size) {
              const isPk = idxCols.every(col => pkSet.has(col));
              if (isPk) {
                  if (debug) console.log(`[NeoPG] Unique '${indname}' matches Primary Key. Skipping.`);
                  continue;
              }
          }

          const idxNamePart = idxCols.join('_');
          const targetIdxName = `${def.tableName}_${idxNamePart}_idx`;

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
      const allIdx = await sql`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = ${tableName} 
        AND schemaname = ${schema} 
        AND indexname != ${tableName + '_pkey'}
      `;
      
      if (allIdx.length === 0) return;

      const currentIdxNames = allIdx.map(i => i.indexname);
      
      const indices = def.index || [];
      const uniques = def.unique || [];
      
      const keepSet = new Set();
      const makeName = (n) => `${tableName}_${Array.isArray(n) ? n.map(x=>x.trim()).join('_') : n.split(',').map(x=>x.trim()).filter(x=>x).join('_')}_idx`;

      indices.forEach(n => keepSet.add(makeName(n)));
      uniques.forEach(n => keepSet.add(makeName(n)));

      for (const idxName of currentIdxNames) {
          if (!keepSet.has(idxName)) {
              if (debug) console.log('Auto removing index:', idxName);
              await sql.unsafe(`DROP INDEX ${schema}.${idxName}`);
          }
      }
  }

  // --- 外键同步 ---
  static async syncReferences(sql, def, schema, curTableName, schemaOid, debug, ctx, options) {
      let targetFKs = new Map();
      
      for (let k in def.columns) {
          const col = def.columns[k];
          if (!col.ref) continue;

          const [refModelName, refColName] = this._parseRef(col.ref, k);
          const targetModelItem = ctx.registry.get(refModelName);
          let targetTableName = '';

          if (targetModelItem) {
              targetTableName = targetModelItem.def.tableName;
              if (debug) console.log(`[Recursive Sync] Triggered by FK: ${def.modelName} -> ${refModelName}`);
              await this.execute(sql, targetModelItem.def, ctx, options);
          } else {
              targetTableName = refModelName.toLowerCase();
          }

          const fkName = `${def.tableName}_${k}_fkey`;
          let refSql = `REFERENCES ${schema}.${targetTableName} (${refColName})`;

          if (col.refActionUpdate) refSql += ` ON UPDATE ${col.refActionUpdate}`;
          else refSql += ` ON UPDATE CASCADE`;

          if (col.refActionDelete) refSql += ` ON DELETE ${col.refActionDelete}`;
          else refSql += ` ON DELETE CASCADE`;

          targetFKs.set(fkName, { col: k, sql: refSql, changed: col.changed });
      }

      const existFKs = new Set();
      if (targetFKs.size > 0 && schemaOid) {
          const names = Array.from(targetFKs.keys());
          const rows = await sql`
              SELECT conname FROM pg_constraint 
              WHERE connamespace = ${schemaOid} 
              AND contype = 'f' 
              AND conname IN ${sql(names)}
          `;
          rows.forEach(r => existFKs.add(r.conname));
      }

      for (const [fkName, conf] of targetFKs) {
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
      
      const idx = col.type.indexOf('(');
      const brackets = idx > 0 ? col.type.substring(idx).trim() : '';

      if (f.data_type.startsWith('character')) {
         return `${f.data_type}(${f.character_maximum_length})` === `${real_type}${brackets}`;
      }
      
      if (f.data_type === 'numeric' || f.data_type === 'decimal') {
         const p = f.numeric_precision;
         const s = f.numeric_scale;
         if (!p) return `${real_type}${brackets}` === real_type;
         return `${f.data_type}(${p},${s})` === `${real_type}${brackets}`;
      }

      return false;
  }

  static _checkColumnsExist(colsStr, def) {
      let parts;
      if (Array.isArray(colsStr)) {
        parts = colsStr;
      } else {
        parts = colsStr.split(',').map(x=>x.trim()).filter(x=>x);
      }

      for (const p of parts) {
          if (!def.columns[p]) return false;
      }
      return true;
  }

  static _parseRef(refstr, curColumn) {
      if (refstr.includes(':')) {
          const parts = refstr.split(':')
          const col = parts.pop()
          const model = parts.join(':')
          return [model, col]
      }
      return [refstr, curColumn]
  }
}

module.exports = SchemaSync
