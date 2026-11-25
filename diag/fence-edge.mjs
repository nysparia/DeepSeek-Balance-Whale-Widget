// 第三轮：补两条边界 —— 栅栏返回 401（未认证）应原样透出；栅栏抛异常应 fail-closed。
// 这两条是 #136 修过的路径，改 connectionFence 时不能碰坏。
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
return { rejected, connectionFence }
`)
  return factory(ctx, { warn: (...args) => warns.push(args.join(' ')) })
}
const makeCtx = (conn) => ({ get: (k) => (k === 'connection' ? conn : undefined), connection: conn })
const req = (method, host) => ({ method, headers: { host } })
function call(fence, r) {
  const res = { statusCode: 0, ended: false, end() { this.ended = true } }
  return fence.rejected(r, res) ? res.statusCode : 'PASS'
}

const scenarios = [
  ['admit 返回 401（未认证）', { admit: () => ({ rejection: 401 }) }, 401],
  ['admit 返回 503（验证失败）', { admit: () => ({ rejection: 503 }) }, 503],
  ['admit 抛异常', { admit: () => { throw new Error('boom') } }, 403],
  ['admit 放行', { admit: () => ({ peer: { id: 'p' } }) }, 'PASS'],
  ['requestRejection 返回 401', { requestRejection: () => 401 }, 401],
  ['requestRejection 抛异常', { requestRejection: () => { throw new Error('boom') } }, 403],
]

const w = (s) => process.stdout.write(s + '\n')
w('用例'.padEnd(30) + '实际'.padEnd(10) + '期望'.padEnd(10) + '结果')
let fail = 0
for (const [label, conn, expected] of scenarios) {
  const warns = []
  const fence = buildFence(makeCtx(conn), warns)
  const got = call(fence, req('GET', '127.0.0.1:3080'))
  const ok = got === expected
  if (!ok) fail++
  w(label.padEnd(30) + String(got).padEnd(10) + String(expected).padEnd(10) + (ok ? 'OK' : 'FAIL'))
  for (const m of warns) w('    warn: ' + m.slice(0, 90))
}
w('\n' + (fail === 0 ? '全部通过' : fail + ' 项不符'))
process.exitCode = fail === 0 ? 0 : 1
