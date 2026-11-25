// 单元验证：两个性能/资源 bug 的修复。
//
//   Bug A  ledgerIo 用 Atomics.wait 同步阻塞事件循环
//   Bug B  update-check.json 无 in-flight 去重，并发时打爆上游
//
// 做法与 diag/ 下其它脚本一致：从 lib/index.js **按源码位置抽取真实代码**，
// 拼进带桩的作用域里跑，断言的是仓库里那份代码本身。
// 同时从 `git show HEAD:lib/index.js` 抽旧版做 before/after 对照。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, '..')
const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')

// "旧版"基线：**不能写死 HEAD** —— 修复提交之后 HEAD 里已经是新版，拿它当基线
// 会让下面的旧版抽取直接失败。这里沿 lib/index.js 的历史往回找，取**最近一个
// 仍含旧退避代码**的版本（即修复前的上游 0.4.2）。
function findOldBaseline() {
  const revs = execFileSync('git', ['rev-list', 'HEAD', '--', 'lib/index.js'], { cwd: REPO, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  for (const rev of revs) {
    const src = execFileSync('git', ['show', rev + ':lib/index.js'], { cwd: REPO, encoding: 'utf8' })
    // 判据用**代码行**而不是片段：新版注释里也提到了 `20 * (attempt + 1)`，
    // 用裸片段会把修复后的版本误判成基线。
    if (src.includes('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))')
      && src.includes('let updateCheckCache = null')) return { rev, src }
  }
  throw new Error('找不到修复前的 lib/index.js 基线')
}
const baseline = findOldBaseline()
const OLD = baseline.src
console.log('旧版基线：' + baseline.rev.slice(0, 7))

let failures = 0
function ok(name, cond, detail) {
  if (cond) { console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { failures++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// —— 按函数名抽取源码（从 `function NAME(` 到配对的花括号）——
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(')
  if (at < 0) throw new Error('function not found: ' + name)
  const open = src.indexOf('{', at)
  let depth = 0
  let inStr = null
  let inLine = false
  let inBlock = false
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++ } continue }
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue }
    if (c === '/' && n === '*') { inBlock = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// ===========================================================================
// Bug A：ledgerIo 重试期间事件循环是否被阻塞
// ===========================================================================
console.log('\n=== Bug A: ledgerIo 重试期间的事件循环阻塞 ===')

// 抽取 ledgerIo 及其上方的常量（LEDGER_RETRY_WAIT_MS / LEDGER_RETRY_LIMIT）。
// 旧版没有常量，直接抽函数体即可。
function buildLedgerIo(src, label) {
  const fn = extractFn(src, 'ledgerIo')
  const consts = [...src.matchAll(/const (LEDGER_RETRY_WAIT_MS|LEDGER_RETRY_LIMIT) = (\d+)/g)]
    .map((m) => `const ${m[1]} = ${m[2]};`)
    .join('\n')
  const factory = new Function(`
${consts}
${fn}
return ledgerIo
`)
  return { fn: factory(), label }
}

// 让 operation 永远抛 EBUSY ⇒ 走满全部重试。
function alwaysBusy() {
  const err = new Error('EBUSY: resource busy or locked')
  err.code = 'EBUSY'
  throw err
}

// 在 ledgerIo 执行期间数 setInterval(1ms) 的触发次数。
// 阻塞越久，触发次数越少；不阻塞时应该能触发很多次。
async function measureBlocking(ledgerIo) {
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 1)
  // 先让 interval 跑起来，确认它本身是活的（否则"0 次"没有说服力）
  await new Promise((r) => setTimeout(r, 20))
  const ticksBefore = ticks
  const t0 = process.hrtime.bigint()
  let threw = null
  try { ledgerIo(alwaysBusy) } catch (err) { threw = err }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6
  // 关键：在阻塞结束的**同一 tick** 立刻快照，不把之后的 tick 算进来
  const ticksDuring = ticks - ticksBefore
  clearInterval(timer)
  return { elapsedMs, ticksDuring, ticksBefore, threw }
}

const newIo = buildLedgerIo(SRC, 'new')
const oldIo = buildLedgerIo(OLD, 'old')

const oldRes = await measureBlocking(oldIo.fn)
const newRes = await measureBlocking(newIo.fn)

console.log(`  旧版（20*(attempt+1)）: 阻塞 ${oldRes.elapsedMs.toFixed(1)}ms，期间 setInterval(1ms) 触发 ${oldRes.ticksDuring} 次（阻塞前已跑 ${oldRes.ticksBefore} 次，证明计时器本身是活的）`)
console.log(`  新版（固定 5ms）      : 阻塞 ${newRes.elapsedMs.toFixed(1)}ms，期间 setInterval(1ms) 触发 ${newRes.ticksDuring} 次（阻塞前已跑 ${newRes.ticksBefore} 次）`)

ok('旧版确实阻塞事件循环（复现 bug）', oldRes.elapsedMs > 250 && oldRes.ticksDuring === 0,
  `elapsed=${oldRes.elapsedMs.toFixed(1)}ms ticksDuring=${oldRes.ticksDuring}`)
ok('新版最坏阻塞 < 40ms', newRes.elapsedMs < 40, `elapsed=${newRes.elapsedMs.toFixed(1)}ms`)
ok('新版阻塞时间比旧版缩短 85% 以上',
  newRes.elapsedMs < oldRes.elapsedMs * 0.15,
  `${oldRes.elapsedMs.toFixed(1)}ms → ${newRes.elapsedMs.toFixed(1)}ms（缩短 ${(100 - newRes.elapsedMs / oldRes.elapsedMs * 100).toFixed(1)}%）`)
ok('两版最终都抛出 EBUSY（重试耗尽后不吞错）',
  oldRes.threw && oldRes.threw.code === 'EBUSY' && newRes.threw && newRes.threw.code === 'EBUSY')

// 重试次数不变：仍然试 6 次（1 次原始 + 5 次重试）
function countAttempts(ledgerIo) {
  let n = 0
  try { ledgerIo(() => { n++; alwaysBusy() }) } catch (err) {}
  return n
}
const oldAttempts = countAttempts(oldIo.fn)
const newAttempts = countAttempts(newIo.fn)
ok('重试次数与旧版一致（不牺牲重试次数，只缩短等待）',
  newAttempts === oldAttempts, `old=${oldAttempts} new=${newAttempts}`)

// 非重试类错误必须立刻抛出，不等待
function measureNonRetryable(ledgerIo) {
  const t0 = process.hrtime.bigint()
  let threw = null
  try { ledgerIo(() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }) } catch (err) { threw = err }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, threw }
}
const nr = measureNonRetryable(newIo.fn)
ok('ENOENT 等非重试错误立即抛出（不等待）', nr.threw && nr.threw.code === 'ENOENT' && nr.ms < 5,
  `${nr.ms.toFixed(2)}ms`)

// 成功路径：第一次就成功，不等待
function measureSuccess(ledgerIo) {
  const t0 = process.hrtime.bigint()
  const v = ledgerIo(() => 42)
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, v }
}
const sc = measureSuccess(newIo.fn)
ok('成功路径零等待', sc.v === 42 && sc.ms < 2, `${sc.ms.toFixed(2)}ms`)

// ===========================================================================
// Bug B：update-check.json 的 in-flight 去重
// ===========================================================================
console.log('\n=== Bug B: update-check.json 并发去重 ===')

// 抽取从 `let updateCheckCache = null` 到 runUpdateCheck 结束的整段。
// 新版以 `updateCheckInFlight = null\n      }\n    }` 收尾；旧版以 handler 的 `}))` 收尾。
function extractUpdateBlock(src, isNew) {
  const start = src.indexOf('let updateCheckCache = null')
  if (start < 0) throw new Error('updateCheckCache not found')
  if (isNew) {
    const marker = 'updateCheckInFlight = null\n      }\n    }'
    const at = src.indexOf(marker, start)
    if (at < 0) throw new Error('new tail marker not found')
    return src.slice(start, at + marker.length)
  }
  const marker = 'res.end(JSON.stringify(payload))\n      },\n    }))'
  const at = src.indexOf(marker, start)
  if (at < 0) throw new Error('old tail marker not found')
  return src.slice(start, at + marker.length)
}

// 桩：registerRoute 收集 handler；httpsGetJson / npmCliVersion 计数并延迟返回。
function buildUpdateHarness(src, isNew) {
  const block = extractUpdateBlock(src, isNew)
  const factory = new Function(
    'registerRoute', 'disposers', 'UPDATE_SOURCES', 'httpsGetJson', 'npmCliVersion',
    'BUILD_VERSION', 'BUILD_CHANNEL', 'JSON_HEADERS', 'console', '__routes',
    `
${block}
return {
  handler: __routes[0],
  cache: () => updateCheckCache,
  inFlight: () => (typeof updateCheckInFlight === 'undefined' ? undefined : updateCheckInFlight),
}
`
  )
  const __routes = []
  const stats = { https: 0, cli: 0 }
  const registerRoute = (r) => { __routes.push(r.handler); return () => {} }
  const disposers = []
  const UPDATE_SOURCES = [
    { name: 'npmmirror', url: 'https://a/latest' },
    { name: 'jsdelivr', url: 'https://b/package.json' },
    { name: 'unpkg', url: 'https://c/package.json' },
    { name: 'npmjs', url: 'https://d/latest' },
    { name: 'npm-cli', cli: true },
  ]
  const httpsGetJson = async () => {
    stats.https++
    await new Promise((r) => setTimeout(r, 25))
    return { version: '9.9.9' }
  }
  const npmCliVersion = async () => {
    stats.cli++
    await new Promise((r) => setTimeout(r, 25))
    return '9.9.9'
  }
  const api = factory(registerRoute, disposers, UPDATE_SOURCES, httpsGetJson, npmCliVersion,
    '0.4.2', 'stable', { 'content-type': 'application/json' }, console, __routes)
  return { api, stats }
}

// 假 req/res：res.end 记录 body，resolve 一个 promise 便于并发等待
function fakeRes() {
  const r = { statusCode: null, body: null, done: null }
  r.promise = new Promise((resolve) => { r.done = resolve })
  r.writeHead = (code) => { r.statusCode = code }
  r.end = (body) => { r.body = body; r.done() }
  return r
}

async function hammer(handler, n) {
  const resList = Array.from({ length: n }, () => fakeRes())
  await Promise.all(resList.map((res) => handler({ url: '/dsh-whale/update-check.json', headers: {} }, res)))
  return resList
}

// —— 旧版：8 并发 ⇒ 8 轮上游 ——
{
  const { api, stats } = buildUpdateHarness(OLD, false)
  const resList = await hammer(api.handler, 8)
  const all200 = resList.every((r) => r.statusCode === 200)
  console.log(`  旧版 8 并发: https=${stats.https} cli=${stats.cli} 全部200=${all200}`)
  ok('旧版复现 bug：8 并发发起 8 轮上游（40 次外部请求）',
    stats.https === 32 && stats.cli === 8, `https=${stats.https} cli=${stats.cli}`)
}

// —— 新版：8 并发 ⇒ 1 轮上游 ——
{
  const { api, stats } = buildUpdateHarness(SRC, true)
  const resList = await hammer(api.handler, 8)
  const all200 = resList.every((r) => r.statusCode === 200)
  const bodies = resList.map((r) => JSON.parse(r.body))
  const allSame = bodies.every((b) => b.latest === '9.9.9' && b.ok === true)
  console.log(`  新版 8 并发: https=${stats.https} cli=${stats.cli} 全部200=${all200}`)
  ok('新版 8 并发只发起 1 轮上游（4 https + 1 cli）',
    stats.https === 4 && stats.cli === 1, `https=${stats.https} cli=${stats.cli}`)
  ok('8 个并发请求全部 200 且拿到同一份 payload', all200 && allSame)
  ok('in-flight 已清空（promise 自己负责清空）', api.inFlight() === null)
  ok('缓存已写入', api.cache() && api.cache().payload.latest === '9.9.9')

  // 缓存命中：再来 8 个并发，不应再打上游
  const before = { ...stats }
  const resList2 = await hammer(api.handler, 8)
  ok('缓存命中后 8 并发不再打上游',
    stats.https === before.https && stats.cli === before.cli,
    `https=${stats.https} cli=${stats.cli}`)
  ok('缓存命中请求仍全部 200', resList2.every((r) => r.statusCode === 200))
}

// —— 竞态：请求在 in-flight 期间陆续到达（不是同一 tick 全到）——
{
  const { api, stats } = buildUpdateHarness(SRC, true)
  const resList = []
  // 每 5ms 发一个，共 8 个；上游要 25ms，所以前几个必然落在 in-flight 窗口里
  for (let i = 0; i < 8; i++) {
    const res = fakeRes()
    resList.push(res)
    api.handler({ url: '/dsh-whale/update-check.json', headers: {} }, res)
    await new Promise((r) => setTimeout(r, 5))
  }
  await Promise.all(resList.map((r) => r.promise))
  console.log(`  新版错峰 8 请求(间隔5ms): https=${stats.https} cli=${stats.cli}`)
  ok('错峰到达的请求复用同一 in-flight（不重复打上游）',
    stats.https === 4 && stats.cli === 1, `https=${stats.https} cli=${stats.cli}`)
  ok('错峰请求全部 200', resList.every((r) => r.statusCode === 200))
}

// —— 上游全失败：payload 仍要返回，且 in-flight 要清空（否则永久卡死）——
{
  const block = extractUpdateBlock(SRC, true)
  const __routes = []
  const factory = new Function(
    'registerRoute', 'disposers', 'UPDATE_SOURCES', 'httpsGetJson', 'npmCliVersion',
    'BUILD_VERSION', 'BUILD_CHANNEL', 'JSON_HEADERS', 'console', '__routes',
    `
${block}
return { handler: __routes[0], inFlight: () => updateCheckInFlight, cache: () => updateCheckCache }
`
  )
  const api = factory(
    (r) => { __routes.push(r.handler); return () => {} }, [],
    [{ name: 'x', url: 'https://x' }, { name: 'y', cli: true }],
    async () => { throw new Error('超时') },
    async () => { throw new Error('超时') },
    '0.4.2', 'stable', {}, console, __routes
  )
  const resList = await hammer(api.handler, 4)
  const b = JSON.parse(resList[0].body)
  ok('上游全失败时仍返回 200 + ok:false（不抛给宿主）',
    resList.every((r) => r.statusCode === 200) && b.ok === false && /x：/.test(b.error))
  ok('上游全失败后 in-flight 已清空（不会永久卡死）', api.inFlight() === null)
  // 失败结果也进缓存（与旧版行为一致），所以这里只断言不卡死
}

// —— 真实文件系统：只读目录下写文件 ⇒ EACCES ⇒ 走满重试 ——
// 这一条不用桩，直接拿真实 fs 触发真实 EACCES，测的是"真会发生的那个场景"。
{
  const os = await import('node:os')
  const roDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-ro-'))
  fs.chmodSync(roDir, 0o555)
  const target = path.join(roDir, 'x.json')
  const realFs = fs
  const run = (ledgerIo) => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 1)
    const t0 = process.hrtime.bigint()
    let threw = null
    try { ledgerIo(() => realFs.writeFileSync(target, 'x', 'utf8')) } catch (err) { threw = err }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    clearInterval(timer)
    return { ms, threw, ticks }
  }
  const oldRo = run(oldIo.fn)
  const newRo = run(newIo.fn)
  fs.chmodSync(roDir, 0o755)
  fs.rmSync(roDir, { recursive: true, force: true })
  console.log(`  真实只读目录 EACCES: 旧版阻塞 ${oldRo.ms.toFixed(1)}ms / 新版阻塞 ${newRo.ms.toFixed(1)}ms`)
  ok('真实 EACCES 场景下新版阻塞 < 40ms', newRo.ms < 40 && newRo.threw && newRo.threw.code === 'EACCES',
    `${newRo.ms.toFixed(1)}ms code=${newRo.threw && newRo.threw.code}`)
  ok('真实 EACCES 场景下旧版阻塞 > 250ms（复现）', oldRo.ms > 250, `${oldRo.ms.toFixed(1)}ms`)
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
