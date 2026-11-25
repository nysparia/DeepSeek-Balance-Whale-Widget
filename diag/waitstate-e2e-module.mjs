// 端到端（模块级）：**加载真实插件模块**（lib/index.js 的默认导出），用桩 Cordis 上下文跑
// 真实的 apply() → 真实的 session/event 监听器 → 真实的 /dsh-whale/wait.json 路由 handler。
//
// 与 diag/waitstate-check.mjs 的区别：那个脚本抽取函数源码；这个脚本走的是**模块真实的注册路径**
// （root.inject → ctx.on → ctx.webServer.register），验证的是"装进宿主之后真的这样跑"。
// 仍然不是真宿主（没有真会话、没有模型），所以它证明的是接线与行为，不是真机双会话。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(here, '..', 'lib', 'index.js')

// —— 桩 Cordis 上下文 ——
const routes = new Map() // path -> route
const listeners = new Map() // event -> [handler]
const disposers = []

const webServer = {
  register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) },
  tapIndex: () => () => {}, // 注入行（桌面端通道），本测试不关心
}
const ctx = {
  webServer, // 插件用属性访问（ctx.webServer.register），不是 ctx.get('webServer')
  get(name) {
    if (name === 'webServer') return webServer
    return null // connection / credentials / sessionTitle 一律缺失 ⇒ 走插件的兜底路径
  },
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
    return () => {}
  },
  effect(fn) { try { const d = fn(); if (typeof d === 'function') disposers.push(d) } catch (err) {} },
}

const root = {
  effect(fn) { ctx.effect(fn) },
  on(event, handler) { return ctx.on(event, handler) },
  inject(deps, cb) { cb(ctx) },
}

const mod = await import(pathToFileURL(PLUGIN).href)
mod.default.apply(root)

// —— 断言工具 ——
let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')) }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)) }

// 触发真实的 session/event 监听器（插件注册的那个）
function fire(session, event) {
  for (const h of listeners.get('session/event') || []) h(session, event)
}
function fireDisposed(session) {
  for (const h of listeners.get('session/disposed') || []) h(session)
}
// 调真实的 wait.json 路由 handler（含 rejected() 栅栏）
function waitJson() {
  const route = routes.get('/dsh-whale/wait.json')
  if (!route) throw new Error('wait.json route not registered')
  let out = ''
  let status = 0
  const req = { method: 'GET', url: '/dsh-whale/wait.json', headers: { host: '127.0.0.1:31888' } }
  const res = {
    writeHead: (code) => { status = code },
    end: (s) => { out = s },
    setHeader: () => {},
    getHeader: () => undefined,
  }
  route.handler(req, res)
  return { status, body: out ? JSON.parse(out) : null }
}

const sess = (id, name) => ({ id, name })
const question = (callId) => ({ type: 'tool/call', data: { name: 'ask_user_question', callId } })

console.log('\n[E2E-0] 真实模块加载后，wait.json 路由已注册')
ok(routes.has('/dsh-whale/wait.json'), '路由已注册到 ctx.webServer')
ok((listeners.get('session/event') || []).length >= 1, 'session/event 监听器已注册')
ok((listeners.get('session/disposed') || []).length >= 1, 'session/disposed 监听器已注册')

console.log('\n[E2E-1] 空状态：接口结构与 HTTP 码')
{
  const r = waitJson()
  eq(r.status, 200, 'HTTP 200')
  eq(Object.keys(r.body).sort(), ['ok', 'pending', 'sessionName'], '键集合 = ok/pending/sessionName')
  eq(r.body.ok, true, 'ok = true')
  eq(r.body.pending, null, 'pending = null')
  eq(r.body.sessionName, '', 'sessionName = 空串')
}

console.log('\n[E2E-2] 真实监听器：主会话提问 → 子 agent 开新一轮（bug 复现场景）')
{
  fire(sess('main', '主会话'), question('q1'))
  const a = waitJson()
  eq(a.body.pending && a.body.pending.id, 'q1', '提问后 pending = q1')
  eq(a.body.sessionName, '主会话', 'sessionName = 主会话')

  fire(sess('sub', '子agent'), { type: 'turn/start', data: {} })
  const b = waitJson()
  eq(b.body.pending && b.body.pending.id, 'q1', '子 agent turn/start 后：q1 仍在（修复点）')
  eq(b.body.sessionName, '主会话', 'sessionName 未被覆盖（修复点）')
  eq(b.body.pending && b.body.pending.session, 'main', 'pending 归属仍是 main')
}

console.log('\n[E2E-3] 主会话自己 turn/end → 清除')
{
  fire(sess('main', '主会话'), { type: 'turn/end', data: {} })
  const r = waitJson()
  eq(r.body.pending, null, 'pending 清除')
  eq(r.body.sessionName, '主会话', 'sessionName 保留')
}

console.log('\n[E2E-4] 会话销毁 → 条目清理，接口不崩')
{
  fire(sess('main', '主会话'), question('q2'))
  fire(sess('sub', '子agent'), { type: 'approval/asked', data: { id: 'a1' } })
  fireDisposed({ id: 'sub' })
  const r = waitJson()
  eq(r.status, 200, '销毁后接口仍 200')
  eq(r.body.pending && r.body.pending.id, 'q2', '主会话的 q2 不受子会话销毁影响')
  fireDisposed({ id: 'main' })
  const r2 = waitJson()
  eq(r2.body.pending, null, '全部销毁后无挂起')
  eq(r2.status, 200, '仍 200')
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + `：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
