// index.js
const NeoPG = require('../lib/NeoPG.js')
const {dataTypes, ModelChain} = NeoPG

// 1. 初始化
const db = new NeoPG({
  host: '127.0.0.1',
  user: 'wy',
  database: 'wdata',
  schema: 'test'
});

// 2. 定义模型
const User = {
  modelName: 'User',
  tableName: 'users',
  primaryKey: 'id',

  column: {
    id : {
      type: dataTypes.UID
    },

    /**
     * @type {column}
     */
    username: {
      type: dataTypes.STRING(50)
    },

    mobile: {
      type: dataTypes.STRING(16)
    },

    mobile_state: {
      type: dataTypes.SMALLINT,
      default: 0
    },

    //真实姓名
    realname: {
      type: dataTypes.STRING(50),
      default: ''
    },

    sex: {
      type: dataTypes.SMALLINT,
      default: 0
    },

    //其他信息，以JSON格式存储
    info: {
      type: dataTypes.TEXT,
      default: ''
    },

    /**
     * @type {column}
     */
    passwd: {
      type: dataTypes.STRING(240)
    },

    //当验证失败，需要进行重复密码验证
    repasswd: {
      type: dataTypes.STRING(240)
    },

    //通过触摸手势或轨迹生成的密码
    touchpass: {
      type: dataTypes.STRING(300)
    },

    is_external: {
      type: dataTypes.SMALLINT,
      default: 0
    },

    /**
     * @type {column}
     */
    level: {
      type: 'smallint',
      default: 1,
      validate: v => {
        return v >= 0 && v < 99
      }
    },

    /**
     * @type {column}
     */
    email: {
      type: dataTypes.STRING(60),
      default: ''
    },

    email_state: {
      type: dataTypes.SMALLINT,
      default: 0
    },

    create_time: {
      type: dataTypes.BIGINT,
      default: 0,
      timestamp: 'insert'
    },

    update_time: {
      type: dataTypes.BIGINT,
      default: 0,
      timestamp: 'update'
    },

    failed_count: {
      type: dataTypes.INT,
      default: 0
    },

    failed_time: {
      type: dataTypes.BIGINT,
      default: 0
    },

    forbid: {
      type: dataTypes.SMALLINT,
      default: 0
    },

    is_root: {
      type: dataTypes.SMALLINT,
      default: 0
    }
  },

  //索引
  index: [
    'create_time',
    'level',
    'is_root'
  ],

  //唯一索引
  unique: [
    'username',
    'email',
    'mobile'
  ]
}

// 3. 注册
db.add(User);

;(async () => {
  await db.sync({force: true, debug: true})
  // 插入

  await db.model('User').insert({username: 'Neo', level: Math.floor((Math.random() * 101))})

  // 事务
  await db.transaction(async tx => {
    let data = {
      level: Math.floor(Math.random() * 101),
      info: `age=${Math.floor(Math.random() * 10 + 20)}`
    }

    console.log('update', data)
    await tx.model('User').where(tx.sql`level > 10`).update(data)

    // 嵌套
    /* await tx.transaction(async subTx => {
       await subTx.table('logs').insert({ msg: 'log' });
    }); */
  });

  db.close()
})();