// 单元验证：v864 的六条修复（四份配置的读错误 / 子 agent 覆盖对话名 / 更新检查硬截止 /
// 账本重复 parse）。
//
// 做法与 diag/ 下其它脚本一致：从 lib/index.js **按函数名/锚点抽取真实源码**（括号配对，
// 不复制粘贴），拼进带桩的作用域里跑。断言的是仓库里那份代码本身，不是测试里另写的一份。
//
// 覆盖：
//   [1] 读错误（EACCES）→ 文件还在、没被改名、返回默认结构（四份配置）
//   [2] 坏 JSON → 仍然备份成 .corrupt-*.bak（回归，别改坏）
//   [3] 写盘是 temp + rename（写失败不留半截文件）
//   [4] waitView 无挂起时不被子 agent 覆盖
//   [5] updateCheckInFlight 上游永不 settle → 截止时间内返回 {ok:false} 且 inFlight 清空
//   [6] aboutPayload 只读一次账本（桩计数，并与修复前的版本对照）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, '..')
const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')

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

// —— 按函数名抽取源码（从 `function NAME(` 到配对的花括号）——
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(')
  if (at < 0) throw new Error('function not found: ' + name)
  return src.slice(at, src.indexOf('{', at) + braceBlockAt(src, at).length)
}
// 从 `at` 之后第一个 `{` 起做括号配对，返回整段（含花括号）
function braceBlockAt(src, at) {
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
function extractDecl(src, re) {
  const m = src.match(re)
  if (!m) throw new Error('declaration not found: ' + re)
  return m[0]
}

// ===========================================================================
// [1][2][3] 四份配置的读 / 写
// ===========================================================================
const CONFIG_FNS = [
  'ledgerIo', 'readConfigText', 'writeConfigJson', 'backupCorruptFile',
  'readRolesIndex', 'defaultRolesIndex', 'writeRolesIndex',
  'readAudioIndex', 'defaultAudioIndex', 'writeAudioIndex',
  'readBubbleImgIndex', 'defaultBubbleImgIndex', 'writeBubbleImgIndex',
  'loadBubbleConfig',
]
const CONFIG_BODY = CONFIG_FNS.map((n) => extractFn(SRC, n)).join('\n\n')
const LEDGER_CONSTS = [...SRC.matchAll(/const (LEDGER_RETRY_WAIT_MS|LEDGER_RETRY_LIMIT) = (\d+)/g)]
  .map((m) => `const ${m[1]} = ${m[2]};`).join('\n')
if (!LEDGER_CONSTS) throw new Error('LEDGER_RETRY_* not found')

// 目录桩：把 pick*Dir 固定到测试目录；常量按仓库真实值给。
function buildConfigApi(dirs, logs, fsImpl) {
  const factory = new Function('fs', 'path', 'console', 'DIRS', 'ROLE_INDEX_NAME', 'AUDIO_INDEX_NAME',
    'BUBBLE_IMG_INDEX_NAME', 'ROLE_DEFAULT_ID', 'BUBBLE_FILE_CANDIDATES', `
const pickRoleDir = () => DIRS.roles
const pickAudioDir = () => DIRS.audio
const pickBubbleImgDir = () => DIRS.imgs
${LEDGER_CONSTS}
${CONFIG_BODY}
return { readRolesIndex, readAudioIndex, readBubbleImgIndex, loadBubbleConfig,
  writeRolesIndex, writeAudioIndex, writeBubbleImgIndex }
`)
  return factory(fsImpl || fs, path, { error: (...a) => logs.push(a.map(String).join(' ')), warn: () => {} },
    dirs, 'roles.json', 'audio.json', 'bubble-imgs.json', 'default', dirs.bubbleCandidates)
}
function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cfg-'))
}
function makeDirs(root) {
  const dirs = {
    roles: path.join(root, 'whale-roles'),
    audio: path.join(root, 'whale-audio'),
    imgs: path.join(root, 'whale-bubble-imgs'),
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  dirs.bubbleCandidates = [path.join(root, '.dshw-bubble.json')]
  return dirs
}
function baks(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.corrupt-\d+\.bak$/.test(f)) } catch (e) { return [] }
}
function temps(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.tmp-\d+$/.test(f)) } catch (e) { return [] }
}
const BAD = '{"broken":'

// 四份配置的「文件 / 读函数 / 默认结构里那个数组键 / 写函数」
function configTargets(dirs, api) {
  return [
    { label: '角色索引 roles.json', file: path.join(dirs.roles, 'roles.json'), read: () => api.readRolesIndex(), key: 'roles', write: (v) => api.writeRolesIndex(v), good: { version: 1, roles: [{ id: 'default', name: 'x' }] } },
    { label: '音效索引 audio.json', file: path.join(dirs.audio, 'audio.json'), read: () => api.readAudioIndex(), key: 'groups', write: (v) => api.writeAudioIndex(v), good: { version: 1, groups: [], fragments: [] } },
    { label: '泡泡图库 bubble-imgs.json', file: path.join(dirs.imgs, 'bubble-imgs.json'), read: () => api.readBubbleImgIndex(), key: 'images', write: (v) => api.writeBubbleImgIndex(v), good: { version: 1, images: [{ id: 'a' }] } },
    { label: '泡泡配置 .dshw-bubble.json', file: dirs.bubbleCandidates[0], read: () => api.loadBubbleConfig(), key: null, write: null, good: { v: 1, items: [], lib: [] } },
  ]
}

console.log('\n[1] 读错误（EACCES）→ 文件还在、没被改名、返回默认结构')
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const api = buildConfigApi(dirs, logs)
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  for (const t of configTargets(dirs, api)) {
    fs.writeFileSync(t.file, JSON.stringify(t.good), 'utf8')
    fs.chmodSync(t.file, 0o000)
    let result = null
    let threw = null
    try { result = t.read() } catch (err) { threw = err }
    fs.chmodSync(t.file, 0o644)
    ok(threw === null, t.label + '：读错误不抛错', threw && threw.message)
    ok(fs.existsSync(t.file), t.label + '：文件**还在**（没被改名搬走）')
    ok(baks(path.dirname(t.file)).length === 0, t.label + '：没有生成 .corrupt-*.bak', baks(path.dirname(t.file)).join(','))
    if (t.key === null) ok(result === null, t.label + '：返回默认结构（null）', JSON.stringify(result))
    else ok(result && Array.isArray(result[t.key]), t.label + '：返回默认结构（' + t.key + ' 是数组）', JSON.stringify(result))
    if (isRoot) console.log('      （以 root 运行：chmod 000 不阻止读取，本条只验证"不抛错、不改名"）')
  }
  ok(logs.some((l) => l.includes('配置文件读取失败')), '日志里留下了读取失败的原因')
  console.log('      日志样例：' + (logs.find((l) => l.includes('配置文件读取失败')) || '(无)'))
  ok(!logs.some((l) => l.includes('配置文件损坏')), '读错误**没有**被当成"损坏"')
}

console.log('\n[1b] 泡泡配置多候选：第一份读不到时**不**回落到更旧的一份')
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const second = path.join(root, 'second', '.dshw-bubble.json')
  fs.mkdirSync(path.dirname(second), { recursive: true })
  dirs.bubbleCandidates = [path.join(root, '.dshw-bubble.json'), second]
  const api = buildConfigApi(dirs, logs)
  fs.writeFileSync(dirs.bubbleCandidates[0], JSON.stringify({ v: 1, items: [{ id: 'new' }], lib: [] }), 'utf8')
  fs.writeFileSync(second, JSON.stringify({ v: 1, items: [{ id: 'old' }], lib: [] }), 'utf8')
  fs.chmodSync(dirs.bubbleCandidates[0], 0o000)
  const cfg = api.loadBubbleConfig()
  fs.chmodSync(dirs.bubbleCandidates[0], 0o644)
  ok(cfg === null, '返回默认（null），没有静默回落到更旧的一份', JSON.stringify(cfg))
  ok(fs.existsSync(dirs.bubbleCandidates[0]), '第一份文件还在')
  ok(baks(root).length === 0, '第一份文件没被备份')
}

console.log('\n[2] 坏 JSON → 仍然备份成 .corrupt-*.bak（回归）')
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const api = buildConfigApi(dirs, logs)
  for (const t of configTargets(dirs, api)) {
    fs.writeFileSync(t.file, BAD, 'utf8')
    const before = baks(path.dirname(t.file)).length
    t.read()
    const after = baks(path.dirname(t.file))
    ok(after.length === before + 1, t.label + '：生成了 1 个备份', '实际 ' + (after.length - before))
    const bak = after.find((f) => f.startsWith(path.basename(t.file) + '.corrupt-'))
    ok(!!bak, t.label + '：备份文件名以 <原文件名>.corrupt- 开头', after.join(','))
    if (bak) ok(fs.readFileSync(path.join(path.dirname(t.file), bak), 'utf8') === BAD, t.label + '：备份内容与坏文件一致')
    ok(!fs.existsSync(t.file), t.label + '：坏文件已改名（原路径不再存在）')
  }
  ok(logs.some((l) => l.includes('bad-json')), '日志里标了 bad-json')
}

console.log('\n[3] 写盘是 temp + rename（写失败不留半截文件）')
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const calls = []
  // 记录写 / 改名的目标路径，直接断言"先写临时文件、再 rename 到正式路径"
  const spyFs = {
    readFileSync: (...a) => fs.readFileSync(...a),
    writeFileSync: (p, data, enc) => { calls.push(['write', p]); return fs.writeFileSync(p, data, enc) },
    renameSync: (a, b) => { calls.push(['rename', a, b]); return fs.renameSync(a, b) },
    existsSync: (p) => fs.existsSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
  }
  const api = buildConfigApi(dirs, logs, spyFs)
  for (const t of configTargets(dirs, api)) {
    if (!t.write) continue
    calls.length = 0
    const wrote = t.write(t.good)
    ok(wrote === true, t.label + '：写盘成功', String(wrote))
    const w = calls.find((c) => c[0] === 'write')
    const r = calls.find((c) => c[0] === 'rename')
    ok(!!w && /\.tmp-\d+$/.test(w[1]), t.label + '：先写临时文件（*.tmp-<pid>）', w && w[1])
    ok(!!r && r[1] === (w && w[1]) && r[2] === t.file, t.label + '：再 rename 到正式路径', r && r.join(' → '))
    ok(temps(path.dirname(t.file)).length === 0, t.label + '：没有残留临时文件', temps(path.dirname(t.file)).join(','))
    const back = t.read()
    eq(back, t.good, t.label + '：读回内容与写入一致')
  }

  // 写失败：正式路径被一个**目录**占住 ⇒ rename 失败 ⇒ 返回 false，且临时文件被清掉
  const t = configTargets(dirs, api)[0]
  fs.rmSync(t.file, { force: true })
  fs.mkdirSync(t.file, { recursive: true })
  const wrote = t.write({ version: 1, roles: [] })
  ok(wrote === false, 'rename 失败时返回 false（不抛给调用方）', String(wrote))
  ok(temps(path.dirname(t.file)).length === 0, '失败后没有残留临时文件（不会留下半截文件）', temps(path.dirname(t.file)).join(','))
  ok(fs.statSync(t.file).isDirectory(), '正式路径上的目录没被破坏')
}

// ===========================================================================
// [4] waitView 无挂起时不被子 agent 覆盖
// ===========================================================================
console.log('\n[4] waitView 无挂起时不被子 agent 覆盖')
{
  const DECL_STATES = extractDecl(SRC, /^ {4}const waitStates = new Map\(\).*$/m)
  const DECL_MAX = extractDecl(SRC, /^ {4}const WAIT_STATE_MAX = \d+.*$/m)
  const DECL_ACTIVE = extractDecl(SRC, /^ {4}let waitActiveSid = ''.*$/m)
  const DECL_TOOL = extractDecl(SRC, /^ {4}const WAIT_QUESTION_TOOL = .*$/m)
  const DECL_SUBAGENTS = extractDecl(SRC, /^ {4}const subagentSessions = new Set\(\).*$/m)
  const body = ['waitBucket', 'waitView', 'titleFromService', 'pickSessionName', 'eventCallId', 'notePendingEvent']
    .map((n) => extractFn(SRC, n)).join('\n\n')
  const factory = new Function('ctx', `
${DECL_STATES}
${DECL_MAX}
${DECL_ACTIVE}
${DECL_TOOL}
${DECL_SUBAGENTS}
${body}
return { notePendingEvent, waitView, waitStates, subagentSessions, getActiveSid: () => waitActiveSid }
`)
  const w = factory({ get: () => null })
  const sess = (id, name) => ({ id: id, name: name })
  const turnStart = () => ({ type: 'turn/start', data: {} })
  const question = (callId) => ({ type: 'tool/call', data: { name: 'ask_user_question', callId: callId } })

  // 主会话先说话，子 agent 随后开跑（subagent/start 已登记）
  w.notePendingEvent('main', turnStart(), sess('main', '主会话'))
  w.subagentSessions.add('sub')
  w.notePendingEvent('sub', turnStart(), sess('sub', '子agent'))
  eq(w.waitView().sessionName, '主会话', '子 agent 开跑后 sessionName 仍是主会话')
  eq(w.getActiveSid(), 'main', 'waitActiveSid 没被子 agent 顶掉')

  // 主会话挂起 → 解除 → 子 agent 还在跑：名字不能变
  w.notePendingEvent('main', question('q1'), sess('main', '主会话'))
  eq(w.waitView().pending && w.waitView().pending.id, 'q1', '主会话挂起被上报')
  w.notePendingEvent('main', { type: 'tool/result', data: { callId: 'q1' } }, sess('main', '主会话'))
  w.notePendingEvent('sub', turnStart(), sess('sub', '子agent'))
  eq(w.waitView().pending, null, '挂起已解除')
  eq(w.waitView().sessionName, '主会话', '挂起解除后名字仍是主会话（本次要修的 bug）')

  // 子 agent 自己有挂起时，仍然要被选中（不能被"过滤子 agent"误伤）
  w.notePendingEvent('sub', { type: 'approval/asked', data: { id: 'a1' } }, sess('sub', '子agent'))
  eq(w.waitView().pending && w.waitView().pending.id, 'a1', '子 agent 自己的挂起照常上报')
  eq(w.waitView().sessionName, '子agent', 'sessionName 跟随被选中的子 agent')

  // 子 agent 的 session/title 事件也不改 waitActiveSid
  const w2 = factory({ get: () => null })
  w2.notePendingEvent('main', turnStart(), sess('main', '主会话'))
  w2.subagentSessions.add('sub')
  w2.notePendingEvent('sub', { type: 'session/title', data: { title: '子任务标题' } }, sess('sub', ''))
  eq(w2.waitView().sessionName, '主会话', '子 agent 的 session/title 不覆盖名字')
  eq(w2.waitStates.get('sub').sessionName, '子任务标题', '子 agent 自己的桶里仍是自己的标题')
}

// ===========================================================================
// [5] updateCheckInFlight：上游永不 settle 时的硬截止
// ===========================================================================
console.log('\n[5] updateCheckInFlight：上游永不 settle → 截止时间内返回 {ok:false} 且清空')
{
  const DEADLINE_MS = Number((SRC.match(/const UPDATE_CHECK_DEADLINE_MS = (\d+)/) || [])[1])
  ok(DEADLINE_MS === 15000, '生产截止时间是 15s', String(DEADLINE_MS))

  // 抽取 `let updateCheckCache = null` 到 runUpdateCheck 结束的整段（与 ledger-updatecheck-check 同一锚点）
  const start = SRC.indexOf('let updateCheckCache = null')
  if (start < 0) throw new Error('updateCheckCache not found')
  const marker = 'updateCheckInFlight = null\n      }\n    }'
  const at = SRC.indexOf(marker, start)
  if (at < 0) throw new Error('update-check tail marker not found')
  const block = SRC.slice(start, at + marker.length)

  const __routes = []
  const stats = { https: 0, cli: 0 }
  const factory = new Function(
    'registerRoute', 'disposers', 'UPDATE_SOURCES', 'httpsGetJson', 'npmCliVersion',
    'BUILD_VERSION', 'BUILD_CHANNEL', 'JSON_HEADERS', 'console', '__routes', 'UPDATE_CHECK_DEADLINE_MS',
    `
${block}
return { handler: __routes[0], inFlight: () => updateCheckInFlight, cache: () => updateCheckCache }
`
  )
  const api = factory(
    (r) => { __routes.push(r.handler); return () => {} }, [],
    [{ name: 'a', url: 'https://a' }, { name: 'b', url: 'https://b' }, { name: 'c', url: 'https://c' }, { name: 'd', url: 'https://d' }, { name: 'cli', cli: true }],
    // 上游**永不 settle**（DNS 卡住 / 子进程不退出）
    () => { stats.https++; return new Promise(() => {}) },
    () => { stats.cli++; return new Promise(() => {}) },
    '0.4.2', 'stable', {}, console, __routes,
    60 // 注入 60ms 截止，不必真等 15 秒
  )
  const fakeRes = () => {
    const r = { statusCode: null, body: null }
    r.promise = new Promise((resolve) => { r.done = resolve })
    r.writeHead = (code) => { r.statusCode = code }
    r.end = (body) => { r.body = body; r.done() }
    return r
  }

  const t0 = Date.now()
  const res = fakeRes()
  // 截止计时器是 unref 的（不拖住宿主进程退出）⇒ 探针自己撑住事件循环，否则 Node 会在
  // 计时器到点前就因为"没有待办"而退出（生产里宿主进程一直在跑，不存在这个问题）。
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await api.handler({ url: '/dsh-whale/update-check.json', headers: {} }, res)
  } finally { clearInterval(keepAlive) }
  const elapsed = Date.now() - t0
  const payload = JSON.parse(res.body)
  ok(res.statusCode === 200, '仍然回 200（不把超时抛给宿主）', String(res.statusCode))
  ok(payload.ok === false, 'payload.ok === false', JSON.stringify(payload))
  eq(payload.error, '更新检查超时', 'payload.error 说明是超时')
  eq(payload.current, '0.4.2', 'payload.current 仍是当前版本')
  ok(elapsed < 1000, '在截止时间附近返回（没有永久挂起）', elapsed + 'ms')
  ok(api.inFlight() === null, 'in-flight 已清空（不会让端点永久挂起）')
  ok(api.cache() === null, '超时结果**不**写缓存（下一次请求会重新发起一轮）')

  // 超时之后新请求能重新发起一轮（不是永久卡死）
  const before = stats.https
  const res2 = fakeRes()
  const keepAlive2 = setInterval(() => {}, 1000)
  try {
    await api.handler({ url: '/dsh-whale/update-check.json', headers: {} }, res2)
  } finally { clearInterval(keepAlive2) }
  ok(stats.https > before, '超时后新请求重新发起了一轮上游', 'https ' + before + ' → ' + stats.https)
  ok(api.inFlight() === null, '第二轮结束后 in-flight 同样清空')
}

// ===========================================================================
// [6] aboutPayload 只读一次账本
// ===========================================================================
console.log('\n[6] aboutPayload 只读一次账本（桩计数）')
{
  // 抽取内置模型分支（`const p = await getBalance()` 所在的那个 try 块）
  function extractBuiltinBranch(src) {
    const at = src.indexOf('const p = await getBalance()')
    if (at < 0) throw new Error('getBalance branch not found')
    const tryAt = src.lastIndexOf('try {', at)
    if (tryAt < 0) throw new Error('try block not found')
    return braceBlockAt(src, tryAt)
  }
  async function countReads(branch) {
    let reads = 0
    const entry = {}
    const fn = new Function('entry', 'getBalance', 'readUsageLedger', 'daySummary', 'balanceSummary', 'todayKey',
      `return (async () => ${branch})()`)
    await fn(entry,
      async () => ({ ok: true, totalBalance: 12.5, currency: 'CNY' }),
      () => { reads++; return { date: '2026-11-25' } },
      () => ({ amount: 1, currency: 'CNY', source: 'ledger', label: '今日' }),
      () => ({ version: 1 }),
      () => '2026-11-25')
    return { reads, entry }
  }

  const now = await countReads(extractBuiltinBranch(SRC))
  ok(now.reads === 1, '新版：一次 aboutPayload 只读 1 次账本', 'reads=' + now.reads)
  eq(now.entry.balance, 12.5, '余额仍被写入 entry')
  eq(now.entry.todayUsage, 1, '今日已用仍被写入 entry')
  ok(now.entry.accounting && now.entry.accounting.version === 1, 'accounting 仍被写入 entry')

  // 与修复前的版本对照：沿 lib/index.js 历史往回找"读两次"的那一版
  let old = null
  try {
    const revs = execFileSync('git', ['rev-list', 'HEAD', '--', 'lib/index.js'], { cwd: REPO, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    for (const rev of revs) {
      const src = execFileSync('git', ['show', rev + ':lib/index.js'], { cwd: REPO, encoding: 'utf8' })
      if (src.includes('daySummary(readUsageLedger(), todayKey())')) { old = { rev, src }; break }
    }
  } catch (err) { old = null }
  if (old) {
    const before = await countReads(extractBuiltinBranch(old.src))
    ok(before.reads === 2, '旧版（' + old.rev.slice(0, 7) + '）：同一段读 2 次账本（复现）', 'reads=' + before.reads)
  } else {
    console.log('      （git 历史里找不到修复前的版本，跳过 before/after 对照）')
  }
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败')
process.exitCode = fail === 0 ? 0 : 1
