#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

// JS 关键字列表，防止类名冲突
const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await', 
  'implements', 'interface', 'package', 'private', 'protected', 'public', 'arguments', 'eval'
]);

// 帮助信息
function showHelp() {
  console.log(`
Usage: neopg-model [options] [name1] [name2] ...

Options:
  --dir=<path>    指定模型文件保存目录 (默认: ./model)

Example:
  neopg-model user-log order_info
  neopg-model --dir=./src/models Product
  `);
}

// 解析参数
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    dir: './model',
    names: []
  };

  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  for (const arg of args) {
    if (arg.startsWith('--dir=')) {
      config.dir = arg.split('=')[1];
    } else if (!arg.startsWith('-')) {
      config.names.push(arg);
    }
  }

  return config;
}

// 验证名称合法性: 字母开头，只允许字母、数字、_、-
function isValidName(name) {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name);
}

// 处理命名规则
function processName(inputName) {
  // 1. 移除扩展名，但记录是否是 .mjs
  let isMjs = inputName.endsWith('.mjs');
  const cleanName = inputName.replace(/(\.js|\.mjs)$/, '');

  // 2. 验证合法性
  if (!isValidName(cleanName)) {
    console.error(`\x1b[31m[Error]\x1b[0m 名称 "${inputName}" 不合法。必须以字母开头，只能包含字母、数字、下划线和连字符。`);
    return null;
  }

  // 3. 生成 tableName: 全小写，- 替换为 _
  const tableName = cleanName.toLowerCase().replace(/-/g, '_');

  // 4. 生成 modelName:
  //    - 去掉 '-'
  //    - '-' 后面的字母大写 (驼峰)
  //    - '_' 保留，_ 后面的字母不做特殊处理
  //    - 首字母大写
  const parts = cleanName.split('-');
  const modelName = parts.map((p, index) => {
    // 每一部分的首字母大写
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join(''); // 直接连接，去掉了 -

  // 检查关键字
  if (JS_KEYWORDS.has(modelName)) {
    console.warn(`\x1b[33m[Warning]\x1b[0m 生成的类名 "${modelName}" 是 JavaScript 关键字，建议修改名称。`);
  }

  return {
    raw: cleanName,
    isMjs,
    tableName,
    modelName
  };
}

// 生成 CommonJS 模板
function generateCJS(info) {
  return `'use strict'\n\nconst { dataTypes, ModelChain } = require('neopg')

class ${info.modelName} extends ModelChain {
  static schema = {
    tableName: '${info.tableName}',
    modelName: '${info.modelName}',
    primaryKey: 'id',
    column: {
      id: {
        type: dataTypes.ID
      },
      name: {
        type: dataTypes.STRING(30),
        default: ''
      }
    },
    index: [],
    unique: []
  }
}

module.exports = ${info.modelName}
`;
}

// 生成 ESM 模板
function generateESM(info) {
  return `'use strict'\n\nimport { dataTypes, ModelChain } from 'neopg'

class ${info.modelName} extends ModelChain {
  static schema = {
    tableName: '${info.tableName}',
    modelName: '${info.modelName}',
    primaryKey: 'id',
    column: {
      id: {
        type: dataTypes.ID
      },
      name: {
        type: dataTypes.STRING(30),
        default: ''
      }
    },
    index: [],
    unique: []
  }
}

export default ${info.modelName}
`;
}

// 主逻辑
function main() {
  const config = parseArgs();
  
  // 1. 确保目录存在
  const targetDir = path.resolve(process.cwd(), config.dir);
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      console.log(`\x1b[32m[Info]\x1b[0m 创建目录: ${config.dir}`);
    } catch (err) {
      console.error(`\x1b[31m[Error]\x1b[0m 无法创建目录 ${targetDir}: ${err.message}`);
      process.exit(1);
    }
  }

  if (config.names.length === 0) {
    console.error('\x1b[31m[Error]\x1b[0m 未指定模型名称。');
    process.exit(1);
  }

  for (const name of config.names) {
    const info = processName(name);
    if (!info) continue;

    const ext = info.isMjs ? '.mjs' : '.js';
    const fileName = info.raw + ext;
    const filePath = path.join(targetDir, fileName);

    // 检查冲突：
    // 1. 检查完全同名的文件
    if (fs.existsSync(filePath)) {
      console.error(`\x1b[31m[Skip]\x1b[0m 文件已存在: ${fileName}`);
      continue;
    }

    // 2. 检查 ModelName 命名的文件 (可选，防止 user.js 和 User.js 在某些系统混淆)
    const modelNamePath = path.join(targetDir, info.modelName + ext);
    if (fs.existsSync(modelNamePath) && modelNamePath.toLowerCase() !== filePath.toLowerCase()) {
       console.warn(`\x1b[33m[Warning]\x1b[0m 存在同类名文件: ${info.modelName}${ext}，可能会导致混淆。`);
    }

    const content = info.isMjs ? generateESM(info) : generateCJS(info);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`\x1b[32m[Success]\x1b[0m 已创建模型: ${path.join(config.dir, fileName)} (Table: ${info.tableName}, Class: ${info.modelName})`);
    } catch (err) {
      console.error(`\x1b[31m[Error]\x1b[0m 写入文件失败 ${fileName}: ${err.message}`);
    }
  }
}

main();