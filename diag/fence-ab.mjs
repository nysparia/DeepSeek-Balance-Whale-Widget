// 对拍：把 lib/index.js 里的信任栅栏原样抽出来，喂给不同形态的 connection 服务。
// 目的不是"复述代码"，而是量出在 DSH 0.2.3-alpha.2 上这层栅栏的实际行为。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')

const a = src.indexOf('const TRUSTED_AUTHORITIES')
const b = src.indexOf('// 统一注册入口')
if (a < 0 || b < 0) throw new Error('boundaries not found')
const body = src.slice(a, b)

// 用 Function 构造，把抽出的片段放进一个带 ctx 的作用域里。
// console 被替换成收集器，这样加载期的 warn 能被断言。
function buildFence(ctx, warns) {
  const factory = new Function('ctx', 'console', `
${body}
return { rejected, selfRejection, writeRejection, connectionFence, isLoopbackHostname }
`)
  return factory(ctx, { warn: (...args) => warns.push(args.join(' ')) })
}

// —— 两种 connection 服务形态 ——
// 旧 DSH（<= 0.2.1）：有 requestRejection(req) -> number|undefined
const legacyConnection = {
  requestRejection(req) {
    const host = String((req.headers && req.headers.host) || '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return 403
    return undefined
  },
}

// 新 DSH（>= 0.2.2-rc.2）：只有 admit(request) -> { peer } | { rejection }
const modernConnection = {
  admit(request) {
    const host = String((request.headers && request.headers.host) || '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return { rejection: 403 }
    return { peer: { id: 'p' } }
  },
  allowsRemoteAuthorities: false,
}

function makeCtx(conn) {
  return { get: (k) => (k === 'connection' ? conn : undefined), connection: conn }
}

function req(method, host, extra = {}) {
  return { method, headers: { host, ...extra } }
}

function call(fence, r) {
  const res = { statusCode: 0, ended: false, end() { this.ended = true } }
  const denied = fence.rejected(r, res)
  return denied ? res.statusCode : 'PASS'
}

const cases = [
  ['GET  回环 Host', req('GET', '127.0.0.1:3080')],
  ['GET  localhost', req('GET', 'localhost:3080')],
  ['GET  伪造 Host（DNS 重绑定）', req('GET', 'evil.example.com')],
  ['GET  跨站标记', req('GET', '127.0.0.1:3080', { 'sec-fetch-site': 'cross-site' })],
  ['GET  跨源 Origin', req('GET', '127.0.0.1:3080', { origin: 'http://evil.example.com' })],
  ['GET  同源 Origin', req('GET', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' })],
  ['GET  畸形 Host', req('GET', '')],
  ['POST 回环 Host（写配置）', req('POST', '127.0.0.1:3080')],
  ['POST 局域网 Host（写配置）', req('POST', '192.168.1.20:3080')],
  ['POST 伪造 Host', req('POST', 'evil.example.com')],
]

const results = {}
for (const [label, conn] of [['legacy (requestRejection)', legacyConnection], ['modern (admit)', modernConnection]]) {
  const warns = []
  const fence = buildFence(makeCtx(conn), warns)
  const rows = cases.map(([name, r]) => [name, call(fence, r)])
  results[label] = { rows, warns, fenceAvailable: !!fence.connectionFence() }
}

// —— 输出 ——
const w = (s) => process.stdout.write(s + '\n')
w('=== 加载期 warn ===')
for (const [label, r] of Object.entries(results)) {
  w(`${label}: connectionFence=${r.fenceAvailable ? '可用' : 'null'}  warn=${r.warns.length ? '有' : '无'}`)
  for (const m of r.warns) w('   ' + m)
}

w('\n=== 逐用例（PASS = 放行到路由；数字 = 拒绝码）===')
w('用例'.padEnd(34) + 'legacy'.padEnd(12) + 'modern')
for (let i = 0; i < cases.length; i++) {
  const name = cases[i][0]
  const l = results['legacy (requestRejection)'].rows[i][1]
  const m = results['modern (admit)'].rows[i][1]
  const flag = l === m ? '' : '   <-- 行为差异'
  w(name.padEnd(34) + String(l).padEnd(12) + String(m) + flag)
}
