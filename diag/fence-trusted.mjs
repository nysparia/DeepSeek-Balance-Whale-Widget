// 第二轮对拍：专打"宿主已信任的非回环权威"这一态 —— 也就是 #136 修过的那条交界。
// 上一轮 10 个用例两种形态完全一致，因为都没触及 trustedHosts。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
const a = src.indexOf('const TRUSTED_AUTHORITIES')
const b = src.indexOf('// 统一注册入口')
const body = src.slice(a, b)

function buildFence(ctx, warns) {
  const factory = new Function('ctx', 'console', `
${body}
return { rejected, selfRejection, writeRejection, connectionFence }
`)
  return factory(ctx, { warn: (...args) => warns.push(args.join(' ')) })
}

const TRUSTED = 'harness.internal:3080'
const isTrusted = (host) => host === TRUSTED || /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)

// 旧形态：宿主自己知道 trustedHosts，requestRejection 放行它
const legacyTrusting = {
  requestRejection(req) {
    const host = String((req.headers && req.headers.host) || '')
    return isTrusted(host) ? undefined : 403
  },
}
// 新形态：admit 同样放行它，但插件认不出这个方法
const modernTrusting = {
  admit(request) {
    const host = String((request.headers && request.headers.host) || '')
    return isTrusted(host) ? { peer: { id: 'p' } } : { rejection: 403 }
  },
  allowsRemoteAuthorities: true,
}

function makeCtx(conn) {
  return { get: (k) => (k === 'connection' ? conn : undefined), connection: conn }
}
function req(method, host, extra = {}) {
  return { method, headers: { host, ...extra } }
}
function call(fence, r) {
  const res = { statusCode: 0, ended: false, end() { this.ended = true } }
  return fence.rejected(r, res) ? res.statusCode : 'PASS'
}

const cases = [
  ['GET  宿主已信任的非回环权威', req('GET', TRUSTED)],
  ['GET  同源 Origin + 已信任权威', req('GET', TRUSTED, { origin: 'http://' + TRUSTED })],
  ['POST 宿主已信任的非回环权威', req('POST', TRUSTED)],
  ['GET  未声明的非回环权威', req('GET', 'other.example.com')],
]

function run(conn, envTrusted) {
  const saved = process.env.DSHW_TRUSTED_HOSTS
  if (envTrusted === undefined) delete process.env.DSHW_TRUSTED_HOSTS
  else process.env.DSHW_TRUSTED_HOSTS = envTrusted
  const warns = []
  const fence = buildFence(makeCtx(conn), warns)
  const rows = cases.map(([n, r]) => [n, call(fence, r)])
  if (saved === undefined) delete process.env.DSHW_TRUSTED_HOSTS
  else process.env.DSHW_TRUSTED_HOSTS = saved
  return { rows, fenceAvailable: !!fence.connectionFence() }
}

const w = (s) => process.stdout.write(s + '\n')
const scenarios = [
  ['legacy 宿主，未设 DSHW_TRUSTED_HOSTS', legacyTrusting, undefined],
  ['modern 宿主，未设 DSHW_TRUSTED_HOSTS', modernTrusting, undefined],
  ['modern 宿主，设了 DSHW_TRUSTED_HOSTS', modernTrusting, TRUSTED],
]

const out = scenarios.map(([label, conn, env]) => [label, run(conn, env)])

w('=== 场景 ===')
for (const [label, r] of out) w(`${label}  → connectionFence=${r.fenceAvailable ? '可用' : 'null'}`)

w('\n=== 逐用例 ===')
const head = '用例'.padEnd(32)
w(head + out.map(([l]) => l.split('，')[0].padEnd(14)).join(''))
for (let i = 0; i < cases.length; i++) {
  const name = cases[i][0]
  const cells = out.map(([, r]) => String(r.rows[i][1]).padEnd(14))
  const vals = out.map(([, r]) => r.rows[i][1])
  const diverge = new Set(vals).size > 1 ? '   <-- 差异' : ''
  w(name.padEnd(32) + cells.join('') + diverge)
}
