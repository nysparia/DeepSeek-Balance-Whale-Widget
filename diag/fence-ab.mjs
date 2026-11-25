// 对拍：把 lib/index.js 里的信任栅栏原样抽出来，喂给不同形态的 connection 服务。
// 目的不是"复述代码"，而是量出在 DSH 0.2.3-alpha.2 上这层栅栏的实际行为。
//
// 每个用例都带**期望值**（PASS = 放行到路由；数字 = 拒绝码），不符即 exit 1。
// 为什么必须有断言：宿主没有栅栏时，这层自校验是**唯一**防线（伪造 Host 可读写、
// 跨站 POST 可改配置，而 api-models.json 连着 ctx.credentials）。把 selfRejection
// 整个换成 `return null` 时，只打印不断言的脚本照样 exit 0 —— 门禁等于没有。
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

// 期望值：两种宿主形态**相同** —— 这正是这轮对拍要钉的结论（栅栏语义一致）。
const cases = [
  ['GET  回环 Host', req('GET', '127.0.0.1:3080'), 'PASS'],
  ['GET  localhost', req('GET', 'localhost:3080'), 'PASS'],
  ['GET  伪造 Host（DNS 重绑定）', req('GET', 'evil.example.com'), 403],
  ['GET  跨站标记', req('GET', '127.0.0.1:3080', { 'sec-fetch-site': 'cross-site' }), 403],
  ['GET  跨源 Origin', req('GET', '127.0.0.1:3080', { origin: 'http://evil.example.com' }), 403],
  ['GET  同源 Origin', req('GET', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' }), 'PASS'],
  ['GET  畸形 Host', req('GET', ''), 403],
  ['POST 回环 Host（写配置）', req('POST', '127.0.0.1:3080'), 'PASS'],
  ['POST 局域网 Host（写配置）', req('POST', '192.168.1.20:3080'), 403],
  ['POST 伪造 Host', req('POST', 'evil.example.com'), 403],
]

// 宿主**没有**栅栏（connectionFence() === null）时，自校验是唯一防线：
// 伪造 Host / 跨站标记 / 跨源 Origin / 畸形 Host 必须仍然被拒（fail-closed）。
const noFenceCases = [
  ['GET  回环 Host', req('GET', '127.0.0.1:3080'), 'PASS'],
  ['GET  伪造 Host（DNS 重绑定）', req('GET', 'evil.example.com'), 403],
  ['GET  跨站标记', req('GET', '127.0.0.1:3080', { 'sec-fetch-site': 'cross-site' }), 403],
  ['GET  跨源 Origin', req('GET', '127.0.0.1:3080', { origin: 'http://evil.example.com' }), 403],
  ['GET  畸形 Host', req('GET', ''), 403],
  ['POST 回环 Host（写配置）', req('POST', '127.0.0.1:3080'), 'PASS'],
  ['POST 伪造 Host', req('POST', 'evil.example.com'), 403],
]

const w = (s) => process.stdout.write(s + '\n')
let fail = 0
const assert = (name, cond, detail) => {
  if (!cond) fail++
  w((cond ? '  OK   ' : '  FAIL ') + name + (detail ? '  ' + detail : ''))
}

// —— 三种宿主形态（第三种：connection 服务整个缺失）——
const warns = { legacy: [], modern: [], none: [] }
const fences = {
  legacy: buildFence(makeCtx(legacyConnection), warns.legacy),
  modern: buildFence(makeCtx(modernConnection), warns.modern),
  none: buildFence(makeCtx(null), warns.none),
}
const fenceState = (f) => (f.connectionFence() ? '可用' : 'null')
const loadWarn = (key) => warns[key].some((m) => m.includes('宿主信任栅栏不可用'))

w('=== 加载期 warn ===')
for (const [label, key] of [
  ['legacy (requestRejection)', 'legacy'],
  ['modern (admit)', 'modern'],
  ['无栅栏（connection 缺失）', 'none'],
]) {
  w(`${label}: connectionFence=${fenceState(fences[key])}  加载期 warn=${loadWarn(key) ? '有' : '无'}`)
  for (const m of warns[key]) w('   ' + m)
}
w('')
// 加载期 warn 只在"确实没有栅栏"时打：有栅栏却打是噪音，没栅栏却不打等于用户不知道自己在裸奔
assert('legacy 宿主：栅栏可用，且不打"栅栏不可用"warn', fenceState(fences.legacy) === '可用' && !loadWarn('legacy'))
assert('modern 宿主：栅栏可用，且不打"栅栏不可用"warn', fenceState(fences.modern) === '可用' && !loadWarn('modern'))
assert('无栅栏：connectionFence() === null，且加载期就打 warn', fenceState(fences.none) === 'null' && loadWarn('none'))

w('\n=== 逐用例（PASS = 放行到路由；数字 = 拒绝码）===')
w('用例'.padEnd(34) + 'legacy'.padEnd(12) + 'modern'.padEnd(12) + '期望'.padEnd(12) + '结果')
for (const [name, r, expected] of cases) {
  const l = call(fences.legacy, r)
  const m = call(fences.modern, r)
  const ok = l === expected && m === expected
  if (!ok) fail++
  w(name.padEnd(34) + String(l).padEnd(12) + String(m).padEnd(12) + String(expected).padEnd(12) + (ok ? 'OK' : 'FAIL'))
}

w('\n=== 宿主无栅栏（connectionFence() === null）：自校验必须独立挡住 ===')
w('用例'.padEnd(34) + '实际'.padEnd(12) + '期望'.padEnd(12) + '结果')
for (const [name, r, expected] of noFenceCases) {
  const got = call(fences.none, r)
  const ok = got === expected
  if (!ok) fail++
  w(name.padEnd(34) + String(got).padEnd(12) + String(expected).padEnd(12) + (ok ? 'OK' : 'FAIL'))
}

w('')
w(fail === 0 ? '全部通过（' + (cases.length * 2 + noFenceCases.length + 3) + ' 项）' : fail + ' 项不符')
process.exitCode = fail === 0 ? 0 : 1
