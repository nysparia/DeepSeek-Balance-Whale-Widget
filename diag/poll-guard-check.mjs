// 单元验证：轮询守卫三件事（后台降频 / in-flight 超时 / 光标矩形过渡期不缓存）。
//
// 做法与 diag/ 下其它脚本一致：从 assets/whale-widget.js 里**按源码位置抽取真实源码**，
// 拼进一个带桩的作用域里跑。断言的是仓库里那份代码本身，不是测试里另写的一份。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeExtractor } from './_extract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'assets', 'whale-widget.js'), 'utf8')

// —— 从 `at` 处第一个 `{` 开始做括号配对，返回整段（含花括号）——
function braceBlock(src, at) {
  const open = src.indexOf('{', at)
  if (open < 0) throw new Error('no brace after offset ' + at)
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
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
  }
  throw new Error('unbalanced braces')
}

function anchor(text, from) {
  const at = SRC.indexOf(text, from || 0)
  if (at < 0) throw new Error('anchor not found: ' + text)
  return at
}

// —— ① 轮询区：从 LAST_TURN_URL 声明到每秒 tick 那一行（含），外加 visibilitychange 补一次 ——
const POLL_START = anchor("var LAST_TURN_URL = '/dsh-whale/last-turn.json'")
const TICK_LINE = 'setInterval(function () { pollLastTurn(); pollWaitState() }, 1000)'
const TICK_AT = anchor(TICK_LINE, POLL_START)
const POLL_SRC = SRC.slice(POLL_START, SRC.indexOf('\n', TICK_AT))

const VIS_AT = anchor("document.addEventListener('visibilitychange', function () {", TICK_AT)
const VIS_TRY_AT = SRC.lastIndexOf('try {', VIS_AT)
const VIS_SRC = 'try ' + braceBlock(SRC, VIS_TRY_AT) + ' catch (err) {}'

// —— ② 光标矩形区：缓存声明到 cursorImgRect 结束，外加四个过渡监听 ——
const CUR_START = anchor('var cursorRectCache = null')
const CUR_FN_AT = anchor('function cursorImgRect()', CUR_START)
const CUR_END = SRC.indexOf('{', CUR_FN_AT) + braceBlock(SRC, CUR_FN_AT).length
const CUR_SRC = SRC.slice(CUR_START, CUR_END)

const TR_ANCHOR = "try { root.addEventListener('transitionrun', cursorRectFreeze) } catch (err) {}"
const TR_SRC = SRC.slice(anchor(TR_ANCHOR)).split('\n').slice(0, 4).join('\n')

// —— 断言工具 ——
let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')) }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(a === e, label, 'got ' + a + ', want ' + e)
}
// 冲掉 fetch 的 .then 链（3 跳微任务）
const flush = () => new Promise((r) => setImmediate(r))

// —— 轮询沙箱：假 document.hidden / 假 fetch / 假 setInterval / 假时钟 ——
function buildPoll(opts) {
  const o = opts || {}
  const st = {
    hidden: !!o.hidden,
    now: o.now === undefined ? 1000000 : o.now,
    calls: [],
    tickFn: null,
    tickMs: 0,
    listeners: {},
    storage: {},
    sounds: [],
    bubbles: [],
  }
  const documentStub = {
    get hidden() { return st.hidden },
    addEventListener(type, fn) { (st.listeners[type] = st.listeners[type] || []).push(fn) },
  }
  const fetchStub = function (url, init) {
    st.calls.push({ url: url, init: init || {} })
    if (o.fetch) return o.fetch(url, init, st)
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
  }
  const setIntervalStub = function (fn, ms) { st.tickFn = fn; st.tickMs = ms; return 1 }
  const DateStub = { now: () => st.now }
  const localStorageStub = {
    getItem: (k) => (k in st.storage ? st.storage[k] : null),
    setItem: (k, v) => { st.storage[k] = String(v) },
  }
  const factory = new Function(
    'document', 'fetch', 'setInterval', 'Date', 'localStorage',
    'usageSet', 'playBindingSound', 'showWaitBubble', 'hideWaitBubble', 'playTaskEndSound', 'showCostBubble',
    'waitSessionName', 'waitPendingId', 'waitDismissedId',
    `
${POLL_SRC}
${VIS_SRC}
return { pollWaitState, pollLastTurn }
`,
  )
  const api = factory(
    documentStub, fetchStub, setIntervalStub, DateStub, localStorageStub,
    {}, function () { st.sounds.push('binding') }, function () { st.bubbles.push('show') },
    function () { st.bubbles.push('hide') }, function () { st.sounds.push('taskEnd') },
    function () { st.sounds.push('cost') },
    '', '', '',
  )
  return { st: st, pollWaitState: api.pollWaitState, pollLastTurn: api.pollLastTurn }
}

// 永不 settle，但**尊重** signal：abort 时 reject（真实 fetch 的行为）
function hangingFetch(url, init) {
  return new Promise(function (resolve, reject) {
    if (init && init.signal) {
      init.signal.addEventListener('abort', function () { reject(new Error('aborted')) })
    }
  })
}
// 永不 settle 且**无视** signal：模拟 abort 本身不生效的极端情况
function deafFetch() { return new Promise(function () {}) }

// —— 光标沙箱：假 img.getBoundingClientRect / 假 root.addEventListener / 假 setTimeout ——
function buildCursor() {
  const st = {
    rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
    timers: [],
    listeners: {},
  }
  const img = { getBoundingClientRect: () => Object.assign({}, st.rect) }
  const root = { addEventListener(type, fn) { (st.listeners[type] = st.listeners[type] || []).push(fn) } }
  const setTimeoutStub = function (fn, ms) { st.timers.push({ fn: fn, ms: ms }); return st.timers.length }
  const factory = new Function('img', 'root', 'setTimeout', `
${CUR_SRC}
${TR_SRC}
return {
  cursorImgRect, invalidateCursorRect, invalidateCursorRectSoon, cursorRectFreeze, cursorRectThaw,
  isFrozen: () => cursorRectFrozen,
  cache: () => cursorRectCache,
}
`)
  const api = factory(img, root, setTimeoutStub)
  return {
    st: st,
    cursorImgRect: api.cursorImgRect,
    invalidateCursorRect: api.invalidateCursorRect,
    invalidateCursorRectSoon: api.invalidateCursorRectSoon,
    isFrozen: api.isFrozen,
    cache: api.cache,
    fire: (type) => { (st.listeners[type] || []).forEach((fn) => fn()) },
  }
}

// ===========================================================================
// 一、后台降频（P1）
// ===========================================================================
console.log('\n[1] 后台（hidden=true）且距上次后台轮询 >10s → 仍然发请求（降频不是停）')
{
  const p = buildPoll({ hidden: true, now: 1000000 })
  p.pollLastTurn()
  p.pollWaitState()
  await flush()
  eq(p.st.calls.map((c) => c.url), ['/dsh-whale/last-turn.json', '/dsh-whale/wait.json'],
    '后台两个 poll 各发一次（任务结束音 / 提问音 / 授权音的唯一触发源）')
  ok(p.st.calls.every((c) => c.init.cache === 'no-store'), '仍带 cache: no-store')
}

console.log('\n[2] 后台且距上次后台轮询不足 10s → 不发（降频生效）')
{
  const p = buildPoll({ hidden: true, now: 1000000 })
  p.pollWaitState()
  await flush()
  ok(p.st.calls.length === 1, '第一次发')
  p.st.now += 5000
  p.pollWaitState()
  await flush()
  ok(p.st.calls.length === 1, '5s 后不发', 'calls=' + p.st.calls.length)
  p.st.now += 4999
  p.pollWaitState()
  await flush()
  ok(p.st.calls.length === 1, '9999ms 仍不发', 'calls=' + p.st.calls.length)
  p.st.now += 1
  p.pollWaitState()
  await flush()
  ok(p.st.calls.length === 2, '满 10s 再发', 'calls=' + p.st.calls.length)
}

console.log('\n[2b] 后台 + 有轮次在跑（busy:true）→ 1 秒就发，不等 10s')
{
  const p = buildPoll({
    hidden: true, now: 1000000,
    fetch: (url) => Promise.resolve({ json: () => Promise.resolve(url.indexOf('last-turn') >= 0 ? { ok: true, seq: 1, busy: true } : { ok: true }) }),
  })
  p.pollLastTurn()
  await flush()
  eq(p.st.calls.length, 1, '第一次发')
  p.st.now += 1000
  p.pollLastTurn()
  await flush()
  eq(p.st.calls.length, 2, '1 秒后再发（busy 生效）')
}

console.log('\n[2c] 后台 + 有挂起在等（pending）→ 1 秒就发')
{
  const p = buildPoll({
    hidden: true, now: 1000000,
    fetch: (url) => Promise.resolve({ json: () => Promise.resolve(url.indexOf('wait') >= 0 ? { ok: true, pending: { kind: 'question', id: 'q1' } } : { ok: true }) }),
  })
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 1, '第一次发')
  p.st.now += 1000
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 2, '1 秒后再发（pending 生效）')
}

console.log('\n[2d] 后台空闲（busy:false、无挂起）→ 仍按 10s 降频')
{
  const p = buildPoll({
    hidden: true, now: 1000000,
    fetch: (url) => Promise.resolve({ json: () => Promise.resolve(url.indexOf('last-turn') >= 0 ? { ok: true, seq: 1, busy: false } : { ok: true }) }),
  })
  p.pollLastTurn()
  await flush()
  p.st.now += 5000
  p.pollLastTurn()
  await flush()
  eq(p.st.calls.length, 1, '5 秒内不发（空闲不抢请求）')
}

console.log('\n[2e] 一轮结束（busy 翻回 false）后，后台回到 10s 降频')
{
  let busy = true
  const p = buildPoll({
    hidden: true, now: 1000000,
    fetch: (url) => Promise.resolve({ json: () => Promise.resolve(url.indexOf('last-turn') >= 0 ? { ok: true, seq: 1, busy: busy } : { ok: true }) }),
  })
  p.pollLastTurn()
  await flush()
  p.st.now += 1000
  p.pollLastTurn()
  await flush()
  eq(p.st.calls.length, 2, 'busy 期间 1 秒一次')
  busy = false
  p.st.now += 1000
  p.pollLastTurn()
  await flush()
  eq(p.st.calls.length, 3, '这一轮结束的那次仍发（拿到 busy:false）')
  p.st.now += 1000
  p.pollLastTurn()
  await flush()
  eq(p.st.calls.length, 3, '之后回到 10s 降频')
}

console.log('\n[3] 两个 poll 的后台时间戳互不干扰（共用一份会让 wait.json 永远不查）')
{
  const p = buildPoll({ hidden: true, now: 1000000 })
  p.pollLastTurn()
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 2, '同一 tick 里两个 poll 都发了')
  p.st.now += 10000
  p.pollLastTurn()
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 4, '下一个 10s 窗口两个都再发')
}

console.log('\n[4] 前台行为与改动前一致：每秒发一次')
{
  const p = buildPoll({ hidden: false, now: 1000000 })
  for (let i = 0; i < 3; i++) {
    p.pollWaitState()
    await flush()
    p.st.now += 1000
  }
  eq(p.st.calls.length, 3, '3 秒 3 次（前台不降频）')
  eq(p.st.tickMs, 1000, 'tick 周期仍是 1000ms')
}

console.log('\n[5] 回到前台立刻补一次（visibilitychange 逻辑保留）')
{
  const p = buildPoll({ hidden: true, now: 1000000 })
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 1, '后台先发一次')
  p.st.hidden = false
  p.st.listeners['visibilitychange'].forEach((fn) => fn())
  await flush()
  eq(p.st.calls.length, 3, '回前台补发两个 poll（不等 10s 窗口）')
}

// ===========================================================================
// 二、in-flight 守卫超时（P2）
// ===========================================================================
console.log('\n[6] 永不 settle 的 fetch → 5 秒后 abort、busy 释放、下一次 tick 能再发')
{
  const p = buildPoll({ hidden: false, now: 1000000, fetch: hangingFetch })
  p.pollWaitState()
  ok(p.st.calls.length === 1, '第一次发')
  ok(p.st.calls[0].init.signal instanceof AbortSignal, 'fetch 带了 AbortSignal（超时用）')
  p.pollWaitState()
  ok(p.st.calls.length === 1, 'in-flight 期间不重复发（守卫仍在）')
  // 真等 5 秒：验证的是 AbortSignal.timeout(5000) 真的会 abort，不是测试里自己掐表
  await new Promise((r) => setTimeout(r, 5300))
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 2, 'abort 后 busy 已释放，下一次 tick 能再发')
}

console.log('\n[7] 看门狗：abort 不生效（fetch 无视 signal）时，busy 超过 15s 无条件清零')
{
  const p = buildPoll({ hidden: false, now: 1000000, fetch: deafFetch })
  p.pollWaitState()
  ok(p.st.calls.length === 1, '第一次发')
  p.st.now += 14999
  p.pollWaitState()
  ok(p.st.calls.length === 1, '14.999s 仍被 busy 挡住')
  p.st.now += 1
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 2, '满 15s 看门狗清零，能再发')
}

console.log('\n[8] 正常 reject → busy 释放（回归）')
{
  const p = buildPoll({ hidden: false, now: 1000000, fetch: () => Promise.reject(new Error('boom')) })
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 1, '第一次发')
  p.pollWaitState()
  await flush()
  eq(p.st.calls.length, 2, 'reject 后 busy 释放，下一次照常发')
}

console.log('\n[9] 正常 resolve → busy 释放，且 pollLastTurn 的 seq 逻辑照旧')
{
  let seq = 1
  const p = buildPoll({
    hidden: false,
    now: 1000000,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, seq: seq, turn: 1, amount: 0.5 }) }),
  })
  p.pollLastTurn()
  await flush()
  eq(p.st.calls.length, 1, '第一次发')
  p.pollLastTurn()
  await flush()
  eq(p.st.calls.length, 2, 'busy 已释放')
  seq = 2
  p.pollLastTurn()
  await flush()
  ok(p.st.sounds.indexOf('taskEnd') >= 0, '新 seq 触发任务结束音（后台降频后仍能响）')
}

// ===========================================================================
// 三、光标矩形过渡期不缓存（P2）
// ===========================================================================
console.log('\n[10] 非过渡期：矩形缓存生效（性能路径没被改坏）')
{
  const c = buildCursor()
  const r1 = c.cursorImgRect()
  c.st.rect = { left: 50, top: 50, right: 150, bottom: 150, width: 100, height: 100 }
  const r2 = c.cursorImgRect()
  eq(r2.left, r1.left, '第二次读缓存（矩形变了但缓存没失效）')
  ok(c.cache() !== null, '缓存已写入')
}

console.log('\n[11] 过渡期间（frozen）不写缓存，每次都现取')
{
  const c = buildCursor()
  c.cursorImgRect()
  c.fire('transitionrun')
  ok(c.isFrozen() === true, 'transitionrun 置 frozen')
  ok(c.cache() === null, '冻结时顺带失效')
  c.st.rect = { left: 62.6, top: 0, right: 162.6, bottom: 100, width: 100, height: 100 }
  eq(c.cursorImgRect().left, 62.6, 'frozen 期间现取（拿到过渡中途的真实值）')
  ok(c.cache() === null, 'frozen 期间不写缓存')
  c.st.rect = { left: 120, top: 0, right: 220, bottom: 100, width: 100, height: 100 }
  eq(c.cursorImgRect().left, 120, 'frozen 期间再变还是现取（没有停在上一帧）')
  ok(c.cache() === null, '缓存始终为空')
}

console.log('\n[12] transitionend / transitioncancel 解冻并失效')
{
  const c = buildCursor()
  c.fire('transitionrun')
  c.st.rect = { left: 250, top: 0, right: 350, bottom: 100, width: 100, height: 100 }
  c.cursorImgRect()
  c.fire('transitionend')
  ok(c.isFrozen() === false, 'transitionend 解冻')
  eq(c.cursorImgRect().left, 250, '解冻后拿到真实矩形')
  ok(c.cache() !== null, '解冻后重新开始缓存')
  c.st.rect = { left: 999, top: 0, right: 1099, bottom: 100, width: 100, height: 100 }
  eq(c.cursorImgRect().left, 250, '解冻后缓存生效（不再每帧现取）')

  const c2 = buildCursor()
  c2.fire('transitionstart')
  ok(c2.isFrozen() === true, 'transitionstart 也置 frozen')
  c2.fire('transitioncancel')
  ok(c2.isFrozen() === false, 'transitioncancel 解冻')
}

console.log('\n[13] 回归场景：过渡中途的矩形不会被缓存（旧实现缓存的是 62.6px 那个）')
{
  const c = buildCursor()
  // t=0：express() 触发失效 + 过渡开始
  c.invalidateCursorRectSoon()
  c.fire('transitionrun')
  // t=16ms：第一帧 pointermove —— 矩形在过渡中途
  c.st.rect = { left: 62.6, top: 0, right: 312.6, bottom: 250, width: 250, height: 250 }
  c.cursorImgRect()
  // t=300ms：过渡结束，真实矩形
  c.fire('transitionend')
  c.st.rect = { left: 250, top: 0, right: 500, bottom: 250, width: 250, height: 250 }
  eq(c.cursorImgRect().left, 250, '过渡结束后拿到真实矩形（不是中途缓存的 62.6）')
}

console.log('\n[14] 原有失效点保留：invalidateCursorRectSoon 立刻失效 + 260ms 兜底再失效')
{
  const c = buildCursor()
  c.cursorImgRect()
  ok(c.cache() !== null, '先缓存一次')
  c.invalidateCursorRectSoon()
  ok(c.cache() === null, '立刻失效')
  c.cursorImgRect()
  ok(c.cache() !== null, '重新缓存')
  const t = c.st.timers[c.st.timers.length - 1]
  eq(t.ms, 260, '兜底定时器 260ms')
  t.fn()
  ok(c.cache() === null, '260ms 兜底再次失效')
  // 已有定时器时不重复排（原行为）：兜底跑完后 cursorRectTimer 归零，第一次重新排、第二次被挡
  const before = c.st.timers.length
  c.invalidateCursorRectSoon()
  c.invalidateCursorRectSoon()
  eq(c.st.timers.length, before + 1, '定时器已在排时不重复排')
}

// ===========================================================================
// 四、宿主侧 busy 信号（last-turn.json 的 busy 字段）
// ===========================================================================
console.log('\n[15] 宿主 turnBusy：turn/start 置位、turn/end 清位、多会话互不影响')
{
  const HOST_SRC = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
  const extractFn = makeExtractor(HOST_SRC)
  const decl = HOST_SRC.match(/const turnBusy = new Set\(\)/)[0]
  const factory = new Function(`${decl}
${extractFn('noteTurnBusy')}
${extractFn('turnBusyNow')}
return { noteTurnBusy, turnBusyNow }`)
  const h = factory()
  ok(h.turnBusyNow() === false, '初始空闲')
  h.noteTurnBusy('s1', 'turn/start')
  ok(h.turnBusyNow() === true, 'turn/start 后 busy')
  h.noteTurnBusy('s2', 'turn/start')
  h.noteTurnBusy('s1', 'turn/end')
  ok(h.turnBusyNow() === true, '另一个会话还在跑 → 仍 busy')
  h.noteTurnBusy('s2', 'turn/end')
  ok(h.turnBusyNow() === false, '全部结束 → 空闲')
  ok(HOST_SRC.indexOf('busy: turnBusyNow()') >= 0, 'last-turn.json 的响应里带 busy 字段')
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + `：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1
