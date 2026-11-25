// 回归：diag/_extract.mjs 的抽取器必须保留 `async`。
//
// 为什么单独钉这一条：抽取器是 diag/ 下所有"抽真实源码再断言"脚本的地基。
// 它一旦把 `async function foo(` 截成 `function foo(`，调用方拿到的是**同步副本** ——
// 断言照样全绿，测的却不是仓库里那份代码（assertSafeApiUrl 已经是 async，
// 将来谁抽它就会静默踩中）。这里用合成源码钉住，不依赖 lib/index.js 里恰好有 async 函数。
import { makeExtractor } from './_extract.mjs'

const SRC = [
  'async function fetchThing(a) {',
  '  return await a',
  '}',
  'function plain(b) {',
  '  return b',
  '}',
  'function outer() {',
  '  function inner() { return 1 }',
  '  return inner()',
  '}',
  '',
].join('\n')

const extractFn = makeExtractor(SRC)
let fail = 0
const ok = (name, cond, detail) => {
  if (!cond) fail++
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : ''))
}

const asyncFn = extractFn('fetchThing')
ok('async function 抽出来仍以 async 开头', /^async\s+function\s+fetchThing\s*\(/.test(asyncFn), asyncFn.split('\n')[0])
ok('async function 的函数体完整（到配对花括号）', asyncFn.includes('return await a') && asyncFn.trimEnd().endsWith('}'))

const plainFn = extractFn('plain')
ok('普通 function 不受影响', /^function\s+plain\s*\(/.test(plainFn), plainFn.split('\n')[0])

ok('嵌套函数按名字精确命中', extractFn('inner').includes('return 1'))

let threw = null
try { extractFn('nope') } catch (err) { threw = err }
ok('找不到函数时抛错（不静默返回空串）', threw !== null)

console.log('')
if (fail) { console.log('结果：' + fail + ' 项失败'); process.exit(1) }
console.log('结果：全部通过')
