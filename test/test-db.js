// index.js
const NeoPG = require('../lib/NeoPG.js')
const ModelChain = NeoPG.ModelChain

// 1. 初始化
const db = new NeoPG({
  host: '127.0.0.1',
  database: 'eoms',
  schema: 'ai' // 全局默认 Schema
});

// 2. 定义模型
const UserSchema = {
  modelName: 'User',
  tableName: 'sys_users',
  column: {
    id: { type: 'varchar', primaryKey: true },
    name: { type: 'varchar', notNull: true },
    age: { type: 'int', default: 18 }
  }
};

// 3. 注册
db.add(UserSchema);

;(async () => {
  // 插入
  await db.model('User').insert({ name: 'Neo' });

  // 动态切换 Schema
  await db.model('User', 'tenant_a').select();
  
  // 链式切换
  await db.model('User').schema('tenant_b').where({ age: 20 }).select();

  // 事务
  await db.transaction(async tx => {
    await tx.model('User').update({ age: 99 });
    // 嵌套
    await tx.transaction(async subTx => {
       await subTx.table('logs').insert({ msg: 'log' });
    });
  });
})();