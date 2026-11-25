// 第二轮对拍：专打"宿主已信任的非回环权威"这一态 —— 也就是 #136 修过的那条交界。
// 上一轮 10 个用例两种形态完全一致，因为都没触及 trustedHosts。
//
// 每个用例都带**期望值**（PASS = 放行到路由；数字 = 拒绝码），不符即 exit 1。
// 最后一组是"宿主没有栅栏"：此时 DSHW_TRUSTED_HOSTS 是唯一的放行依据，
// 而写请求（POST）仍然只认回环 —— 这两条都不能靠"打印出来看看"来守。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
const a = src.indexOf('const TRUSTED_AUTHORITIES')
const b = src.indexOf('// 统一注册入口')
if (a < 0 || b < 0) throw new Error('boundaries not found')
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
  return { rows, warns, fenceAvailable: !!fence.connectionFence() }
}

// 期望值逐场景给出：前三个场景宿主栅栏可用（非回环权威交给它判），
// 后两个场景宿主没有栅栏（只剩自校验 + DSHW_TRUSTED_HOSTS）。
// 无论哪种场景，POST 到非回环权威都必须 403 —— 写配置等于决定"把凭据发往哪里"。
const scenarios = [
  { label: 'legacy 宿主，未设 DSHW_TRUSTED_HOSTS', conn: legacyTrusting, env: undefined, expect: ['PASS', 'PASS', 403, 403] },
  { label: 'modern 宿主，未设 DSHW_TRUSTED_HOSTS', conn: modernTrusting, env: undefined, expect: ['PASS', 'PASS', 403, 403] },
  { label: 'modern 宿主，设了 DSHW_TRUSTED_HOSTS', conn: modernTrusting, env: TRUSTED, expect: ['PASS', 'PASS', 403, 403] },
  { label: '无栅栏，设了 DSHW_TRUSTED_HOSTS', conn: null, env: TRUSTED, expect: ['PASS', 'PASS', 403, 403] },
  { label: '无栅栏，未设 DSHW_TRUSTED_HOSTS', conn: null, env: undefined, expect: [403, 403, 403, 403] },
]

const w = (s) => process.stdout.write(s + '\n')
let fail = 0

w('=== 场景 ===')
const out = scenarios.map((s) => [s, run(s.conn, s.env)])
for (const [s, r] of out) {
  const wantFence = s.conn !== null
  const fenceOk = r.fenceAvailable === wantFence
  const loadWarn = r.warns.some((m) => m.includes('宿主信任栅栏不可用'))
  // 加载期 warn 只在"确实没有栅栏"时打
  const warnOk = loadWarn === !wantFence
  if (!fenceOk || !warnOk) fail++
  w(`${s.label}  → connectionFence=${r.fenceAvailable ? '可用' : 'null'}`
    + `  加载期 warn=${loadWarn ? '有' : '无'}  ${fenceOk && warnOk ? 'OK' : 'FAIL'}`)
}

for (const [s, r] of out) {
  w('\n=== ' + s.label + '（connectionFence=' + (r.fenceAvailable ? '可用' : 'null') + '）===')
  w('用例'.padEnd(32) + '实际'.padEnd(12) + '期望'.padEnd(12) + '结果')
  for (let i = 0; i < cases.length; i++) {
    const got = r.rows[i][1]
    const expected = s.expect[i]
    const ok = got === expected
    if (!ok) fail++
    w(cases[i][0].padEnd(32) + String(got).padEnd(12) + String(expected).padEnd(12) + (ok ? 'OK' : 'FAIL'))
  }
}

w('')
w(fail === 0 ? '全部通过（' + (scenarios.length * (cases.length + 1)) + ' 项）' : fail + ' 项不符')
process.exitCode = fail === 0 ? 0 : 1
