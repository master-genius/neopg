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
    'email'
  ]
}

// 3. 注册
db.add(User);

;(async () => {
  await db.sync({force: true, debug: true})
  // 插入

  await db.model('User').where('1=1').delete()

  try {
    console.log(
      await db.model('User')
              .returning(['id', 'username', 'level', 'create_time'])
              .insert([
                {
                  username: 'Neo',
                  email: '123@w.com',
                  sex: 1,
                  level: Math.floor((Math.random() * 105))
                },
                {
                  username: 'PG',
                  email: '1234@w.com',
                  sex: 2,
                  level: Math.floor((Math.random() * 100))
                },

                {
                  username: 'NPG',
                  email: '1235@w.com',
                  sex: 3,
                  level: 3
                }
            ])
    )
  } catch(err) {
    console.error('\x1b[7;5m随机测试：让level超过99，validate验证失败\x1b[0m')
  }

  // 事务
  await db.transaction(async tx => {
    let data = {
      level: Math.floor(Math.random() * 100),
      info: `age=${Math.floor(Math.random() * 10 + 20)};delete from users;`
    }

    console.log('update', data)

    let result = await tx.model('User').where(tx.sql`level > 10`).returning('*').update(data)
    console.log(result)

    let sex = 3
    console.log(
      'test condition or',
      await tx.model('User').where(tx.sql`(sex = ${sex} or level > 10)`).select(['id', 'level', 'username', 'sex']).find()
    )

    console.log(
      'test avg',
      await tx.model('User').avg('level')
    )

    console.log(
      'test max',
      await tx.model('User').max('level')
    )

    console.log(
      'test min',
      await tx.model('User').min('username')
    )

    let n = Math.floor(Math.random() * 10)

    if (n > 7) {
      console.error('\x1b[7;5m随机测试：将会让事物执行失败\x1b[0m')
      await tx.model('User').insert({username: 'Neo'})
    }

    console.log('test count',
      await tx.model('User').where('level', '<', 10).count()
    )

    // 嵌套
    /* await tx.transaction(async subTx => {
       await subTx.table('logs').insert({ msg: 'log' });
    }); */
  }).catch(err => {
    console.error(err)
  })

  db.close()
})();