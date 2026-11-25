// 单元验证：waitState 跨会话状态污染修复（v863）。
//
// 做法与 diag/ 下其它脚本一致：从 lib/index.js 里**按函数名/锚点抽取真实源码**（括号配对，
// 不复制粘贴），拼进一个带桩的作用域里跑。断言的是仓库里那份代码本身，不是测试里另写的一份。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')

// —— 从 `at` 处第一个 `{` 开始做括号配对，返回整段（含花括号）——
function braceBlock(at) {
  const open = SRC.indexOf('{', at)
  if (open < 0) throw new Error('no brace after offset ' + at)
  let depth = 0
  let inStr = null
  let inLine = false
  let inBlock = false
  for (let i = open; i < SRC.length; i++) {
    const c = SRC[i]
    const n = SRC[i + 1]
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
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(open, i + 1) }
  }
  throw new Error('unbalanced braces')
}

function extractFn(name) {
  const at = SRC.indexOf('function ' + name + '(')
  if (at < 0) throw new Error('function not found: ' + name)
  // braceBlock 返回的是从 `{` 起的那一段 ⇒ 结束位置 = 花括号起点 + 段长（不是 at + 段长）
  return SRC.slice(at, SRC.indexOf('{', at) + braceBlock(at).length)
}

// 状态声明（三行）也从源码里取，避免测试里另写一份常量
function extractDecl(re) {
  const m = SRC.match(re)
  if (!m) throw new Error('declaration not found: ' + re)
  return m[0]
}

const DECL_STATES = extractDecl(/^ {4}const waitStates = new Map\(\).*$/m)
const DECL_MAX = extractDecl(/^ {4}const WAIT_STATE_MAX = \d+.*$/m)
const DECL_ACTIVE = extractDecl(/^ {4}let waitActiveSid = ''.*$/m)
const DECL_TOOL = extractDecl(/^ {4}const WAIT_QUESTION_TOOL = .*$/m)
// v864：waitView / notePendingEvent 现在会读 subagentSessions（无挂起时不被子 agent 覆盖）
const DECL_SUBAGENTS = extractDecl(/^ {4}const subagentSessions = new Set\(\).*$/m)

const FN_NAMES = ['waitBucket', 'waitView', 'titleFromService', 'pickSessionName', 'eventCallId', 'notePendingEvent']
const body = FN_NAMES.map(extractFn).join('\n\n')

// wait.json 路由的 handler 也抽真实源码
const routeAt = SRC.indexOf("path: '/dsh-whale/wait.json'")
if (routeAt < 0) throw new Error('wait.json route not found')
const handlerAt = SRC.indexOf('handler: (req, res) =>', routeAt)
if (handlerAt < 0) throw new Error('wait.json handler not found')
const HANDLER_SRC = 'const waitJsonHandler = (req, res) => ' + braceBlock(handlerAt)

// session/disposed 的清理逻辑（内联箭头函数）也抽真实源码
const disposedAt = SRC.indexOf("ctx.on('session/disposed'")
if (disposedAt < 0) throw new Error('session/disposed listener not found')
const DISPOSED_SRC = 'const disposedHandler = (session) => ' + braceBlock(SRC.indexOf('(session) =>', disposedAt))

function build(opts) {
  const o = opts || {}
  const factory = new Function('ctx', 'turnAggs', 'JSON_HEADERS', `
${DECL_STATES}
${DECL_MAX}
${DECL_ACTIVE}
${DECL_TOOL}
${DECL_SUBAGENTS}
${body}
${HANDLER_SRC}
${DISPOSED_SRC}
return {
  notePendingEvent, waitView, waitBucket, waitStates, subagentSessions,
  getActiveSid: () => waitActiveSid,
  waitJsonHandler, disposedHandler,
}
`)
  return factory(
    { get: (k) => (k === 'sessionTitle' ? (o.titleService || null) : null) },
    new Map(),
    { 'content-type': 'application/json' },
  )
}

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

// 事件构造器
const sess = (id, name) => ({ id: id, name: name })
const question = (callId) => ({ type: 'tool/call', data: { name: 'ask_user_question', callId: callId } })
const turnStart = () => ({ type: 'turn/start', data: {} })
const turnEnd = () => ({ type: 'turn/end', data: {} })
const approvalAsked = (id) => ({ type: 'approval/asked', data: { id: id } })
const approvalDone = (id) => ({ type: 'approval/answered', data: { id: id } })

// 调 wait.json handler，返回解析后的 JSON
function waitJson(w) {
  let out = ''
  w.waitJsonHandler({}, { writeHead: () => {}, end: (s) => { out = s } })
  return JSON.parse(out)
}

console.log('\n[1] 主会话提问 + 子 agent 开始新一轮 → 主会话的挂起仍在（本次要修的 bug）')
{
  const w = build()
  w.notePendingEvent('main', question('q1'), sess('main', '主会话'))
  eq(waitJson(w).pending, { kind: 'question', id: 'q1', ts: w.waitStates.get('main').pending.ts, session: 'main' },
    '提问后：pending 是主会话的 q1')
  w.notePendingEvent('sub', turnStart(), sess('sub', '子agent'))
  const j = waitJson(w)
  eq(j.pending && j.pending.id, 'q1', '子 agent turn/start 后：主会话的 q1 仍在')
  eq(j.pending && j.pending.session, 'main', 'pending 归属仍是 main')
  eq(j.sessionName, '主会话', 'sessionName 仍是主会话（没被子 agent 覆盖）')
  // 旧实现下这两条都会挂：pending 变 null、sessionName 变 '子agent'
}

console.log('\n[2] 主会话提问 + 主会话自己 turn/end → pending 清除')
{
  const w = build()
  w.notePendingEvent('main', question('q1'), sess('main', '主会话'))
  ok(waitJson(w).pending !== null, '提问后 pending 存在')
  w.notePendingEvent('main', turnEnd(), sess('main', '主会话'))
  eq(waitJson(w).pending, null, '主会话 turn/end 后 pending 清除')
  eq(waitJson(w).sessionName, '主会话', 'sessionName 保留（清挂起不清名字）')
}

console.log('\n[3] 两个会话都有 pending → 返回最近的那一条')
{
  const w = build()
  w.notePendingEvent('main', approvalAsked('a1'), sess('main', '主会话'))
  // 让第二条的 ts 严格更大
  const t0 = Date.now()
  while (Date.now() <= t0) { /* 空转 1ms，保证 ts 单调 */ }
  w.notePendingEvent('sub', question('q2'), sess('sub', '子agent'))
  const j = waitJson(w)
  eq(j.pending && j.pending.id, 'q2', '返回最近的一条（子 agent 的 q2）')
  eq(j.sessionName, '子agent', 'sessionName 跟随被选中的会话')
  // 子 agent 的挂起不被 subagentMuteOn 静音：卡住等用户动手，必须让用户看见
  ok(j.pending !== null, '子 agent 的挂起照常上报（不静音）')
}

console.log('\n[4] 会话销毁后条目被清理（内存泄漏）')
{
  const w = build()
  w.notePendingEvent('main', question('q1'), sess('main', '主会话'))
  w.notePendingEvent('sub', turnStart(), sess('sub', '子agent'))
  ok(w.waitStates.size === 2, '销毁前两个桶', 'size=' + w.waitStates.size)
  w.disposedHandler({ id: 'sub' })
  ok(!w.waitStates.has('sub'), 'sub 的桶已删除')
  ok(w.waitStates.has('main'), 'main 的桶仍在')
  eq(waitJson(w).pending && waitJson(w).pending.id, 'q1', '主会话挂起不受影响')
  // 活跃会话被销毁 ⇒ activeSid 复位，不指向已删除的桶
  w.disposedHandler({ id: 'main' })
  ok(w.getActiveSid() === '', 'activeSid 复位为空')
  eq(waitJson(w).pending, null, '全部销毁后没有挂起')
  ok(w.waitStates.size === 0, '桶全部清空', 'size=' + w.waitStates.size)
}

console.log('\n[5] sessionName 不被其他会话覆盖')
{
  const w = build()
  w.notePendingEvent('main', turnStart(), sess('main', '主会话'))
  eq(waitJson(w).sessionName, '主会话', '主会话名字')
  w.notePendingEvent('sub', turnStart(), sess('sub', '子agent'))
  eq(waitJson(w).sessionName, '子agent', '无挂起时跟随最近活跃会话')
  w.notePendingEvent('main', question('q1'), sess('main', '主会话'))
  eq(waitJson(w).sessionName, '主会话', '主会话提问后名字回到主会话')
  w.notePendingEvent('sub', turnEnd(), sess('sub', '子agent'))
  eq(waitJson(w).sessionName, '主会话', '子 agent turn/end 不覆盖名字')
  eq(w.waitStates.get('sub').sessionName, '子agent', '子 agent 自己的桶里仍是自己的名字')
  eq(w.waitStates.get('main').sessionName, '主会话', '主会话桶里仍是主会话')
}

console.log('\n[6] session/title 事件按会话落桶')
{
  const w = build()
  w.notePendingEvent('main', { type: 'session/title', data: { title: '重构挂起状态' } }, sess('main', ''))
  w.notePendingEvent('sub', { type: 'session/title', data: { title: '子任务标题' } }, sess('sub', ''))
  eq(w.waitStates.get('main').sessionName, '重构挂起状态', 'main 桶的标题')
  eq(w.waitStates.get('sub').sessionName, '子任务标题', 'sub 桶的标题')
  eq(waitJson(w).sessionName, '子任务标题', '无挂起时显示最近活跃会话的标题')
}

console.log('\n[7] sessionTitle 服务优先于 session 对象字段（且按会话隔离）')
{
  const svc = { get: (s) => (s && s.id === 'main' ? { title: '服务给的标题' } : null) }
  const w = build({ titleService: svc })
  w.notePendingEvent('main', turnStart(), sess('main', '对象字段名'))
  eq(w.waitStates.get('main').sessionName, '服务给的标题', '服务标题覆盖对象字段')
  w.notePendingEvent('sub', turnStart(), sess('sub', '子agent'))
  eq(w.waitStates.get('sub').sessionName, '子agent', 'sub 走对象字段兜底')
  eq(w.waitStates.get('main').sessionName, '服务给的标题', 'main 的标题没被 sub 的事件改掉')
}

console.log('\n[8] 挂起解除的两条路径（tool/result 按 callId、approval 按 id）')
{
  const w = build()
  w.notePendingEvent('main', question('q1'), sess('main', '主会话'))
  w.notePendingEvent('main', { type: 'tool/result', data: { callId: 'other' } }, sess('main', '主会话'))
  ok(waitJson(w).pending !== null, 'callId 不匹配时不清（旧行为保留）')
  w.notePendingEvent('main', { type: 'tool/result', data: { callId: 'q1' } }, sess('main', '主会话'))
  eq(waitJson(w).pending, null, 'callId 匹配时清除')

  w.notePendingEvent('main', approvalAsked('a1'), sess('main', '主会话'))
  w.notePendingEvent('main', approvalDone('a1'), sess('main', '主会话'))
  eq(waitJson(w).pending, null, 'approval 按 id 解除')
}

console.log('\n[9] 跨会话互不干扰：子 agent 的 turn/end 不清主会话的授权挂起')
{
  const w = build()
  w.notePendingEvent('main', approvalAsked('a1'), sess('main', '主会话'))
  w.notePendingEvent('sub', turnStart(), sess('sub', '子agent'))
  w.notePendingEvent('sub', turnEnd(), sess('sub', '子agent'))
  const j = waitJson(w)
  eq(j.pending && j.pending.id, 'a1', '主会话的授权挂起仍在')
  eq(j.sessionName, '主会话', '名字仍是主会话')
}

console.log('\n[10] wait.json 返回结构兼容（前端只读 ok / pending / sessionName）')
{
  const w = build()
  const empty = waitJson(w)
  eq(Object.keys(empty).sort(), ['ok', 'pending', 'sessionName'], '空状态：键集合不变')
  eq(empty.ok, true, 'ok = true')
  eq(empty.pending, null, 'pending = null')
  eq(empty.sessionName, '', 'sessionName = 空串（不是 undefined）')
  w.notePendingEvent('main', question('q1'), sess('main', '主会话'))
  const full = waitJson(w)
  eq(Object.keys(full).sort(), ['ok', 'pending', 'sessionName'], '有挂起：键集合不变')
  ok(typeof full.pending.kind === 'string' && typeof full.pending.id === 'string', 'pending 带 kind/id（前端判 kind）')
}

console.log('\n[11] 桶数量上限：超限淘汰最旧的，新条目不被自己淘汰')
{
  const w = build()
  for (let i = 0; i < 260; i++) w.notePendingEvent('s' + i, turnStart(), sess('s' + i, 'n' + i))
  ok(w.waitStates.size <= 200, '桶数不超过 WAIT_STATE_MAX', 'size=' + w.waitStates.size)
  ok(w.waitStates.has('s259'), '最新会话仍在')
  ok(!w.waitStates.has('s0'), '最旧会话被淘汰')
}

console.log('\n[12] 无 sid 的事件落到 default 桶（不崩）')
{
  const w = build()
  w.notePendingEvent(undefined, question('q1'), null)
  ok(w.waitStates.has('default'), '落到 default 桶')
  eq(waitJson(w).pending && waitJson(w).pending.id, 'q1', 'default 桶的挂起照常上报')
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + `：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
