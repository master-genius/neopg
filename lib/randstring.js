'use strict'

let saltArr = [
  'a','b','c','d','e','f','g',
  'h','i','j','k','l','m','n',
  'o','p','q','r','s','t','u',
  'v','w','x','y','z','1','2',
  '3','4','5','6','7','8','9'
]

module.exports = (length = 8, sarr = null) => {
  let saltstr = ''
  let ind = 0

  let arr = sarr || saltArr
  let alen = arr.length

  for(let i = 0; i < length; i++) {
    saltstr += arr[(Math.random() * alen) | 0]
  }

  return saltstr
}
