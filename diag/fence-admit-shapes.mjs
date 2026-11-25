// 第四轮：admit 的三种返回形态 + owner 检查。
// 这是 roost / dsh-remote-ssh 都处理了、而我第一版补丁漏掉的边界。
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
  ['admit → { peer: owner }', { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, 'PASS'],
  ['admit → { peer: 非 owner }', { admit: () => ({ peer: { principal: { kind: 'guest' } } }) }, 403],
  ['admit → { peer: 无 principal }', { admit: () => ({ peer: { id: 'p' } }) }, 'PASS'],
  ['admit → { rejection: 401 }', { admit: () => ({ rejection: 401 }) }, 401],
  ['admit → { rejection: 403 }', { admit: () => ({ rejection: 403 }) }, 403],
  ['admit → { rejection: 503 }', { admit: () => ({ rejection: 503 }) }, 503],
  ['admit → undefined（不认这次请求）', { admit: () => undefined }, 403],
  ['admit → null', { admit: () => null }, 403],
  ['admit 抛异常', { admit: () => { throw new Error('boom') } }, 403],
  ['requestRejection → undefined（放行）', { requestRejection: () => undefined }, 'PASS'],
  ['requestRejection → 401', { requestRejection: () => 401 }, 401],
  ['requestRejection 抛异常', { requestRejection: () => { throw new Error('boom') } }, 403],
  ['两者都有，优先 requestRejection', {
    requestRejection: () => 401,
    admit: () => ({ peer: { principal: { kind: 'owner' } } }),
  }, 401],
]

const w = (s) => process.stdout.write(s + '\n')
w('用例'.padEnd(38) + '实际'.padEnd(10) + '期望'.padEnd(10) + '结果')
let fail = 0
for (const [label, conn, expected] of scenarios) {
  const warns = []
  const fence = buildFence(makeCtx(conn), warns)
  const got = call(fence, req('GET', '127.0.0.1:3080'))
  const ok = got === expected
  if (!ok) fail++
  w(label.padEnd(38) + String(got).padEnd(10) + String(expected).padEnd(10) + (ok ? 'OK' : 'FAIL'))
}
w('\n' + (fail === 0 ? `全部通过（${scenarios.length} 项）` : fail + ' 项不符'))
process.exitCode = fail === 0 ? 0 : 1
