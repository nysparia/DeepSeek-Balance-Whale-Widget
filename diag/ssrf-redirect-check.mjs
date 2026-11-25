// F1/F2/F3 回归：SSRF 预检被 302 绕过、`Origin: null` 被当成"没有 Origin"、IPv6/IPv4 保留段漏判。
// 做法与 diag/fence-edge.mjs 一致：按源码位置从 lib/index.js 抽出**真实函数**，拼进带桩作用域里跑真断言。
// 全程不联网：只在 127.0.0.1 上起临时 http server（端口由内核分配）。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')

function slice(from, to) {
  const a = src.indexOf(from)
  const b = src.indexOf(to)
  if (a < 0 || b < 0 || b <= a) throw new Error('抽取失败：' + from + ' … ' + to)
  return src.slice(a, b)
}

// ① SSRF 判定 + apiFetchJson：从 ipv4Parts 一直到 apiFetchJson 结束。
//    dns 用桩（本脚本只用 IP 字面量，域名分支不该被走到）；fetch 用真的（只连 127.0.0.1）。
const ssrfBody = slice('function ipv4Parts', '// 测试连通性：优先模板的 probeUrl')
const dnsStub = { promises: { lookup: async () => { throw new Error('测试脚本不解析域名') } } }
const quiet = { warn() {}, log() {}, error() {} }
const ssrf = new Function('dns', 'fetch', 'AbortSignal', 'URL', 'console', `
${ssrfBody}
return { assertSafeIp, assertSafeApiUrl, apiFetchJson, ipv4Class, ipv6Class, ipv6Groups }
`)(dnsStub, fetch, AbortSignal, URL, quiet)

// ② 插件自带的信任栅栏：从 TRUSTED_AUTHORITIES 到统一注册入口（与 fence-edge.mjs 同一段）。
const fenceBody = slice('const TRUSTED_AUTHORITIES', '// 统一注册入口')
const fence = new Function('ctx', 'console', `
${fenceBody}
return { selfRejection }
`)({ get: () => undefined }, quiet)

const w = (s) => process.stdout.write(s + '\n')
const rows = []
function check(label, ok, detail) {
  rows.push({ label, ok, detail: detail === undefined ? '' : String(detail) })
}
async function expectThrow(label, fn, needle) {
  try {
    const v = await fn()
    check(label, false, '未抛错，返回 ' + JSON.stringify(v))
  } catch (err) {
    const msg = String((err && err.message) || err)
    check(label, needle ? msg.indexOf(needle) >= 0 : true, msg)
  }
}

// —— 临时 server 工具 ——
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}
function closeServer(server) {
  try { server.closeAllConnections() } catch (err) {}
  return new Promise((resolve) => server.close(() => resolve()))
}
const readBody = (req) => new Promise((resolve) => {
  let s = ''
  req.on('data', (c) => { s += c })
  req.on('end', () => resolve(s))
})

async function main() {
  // ===== 目标服务 B1：只用来证明"零连接" =====
  let connB1 = 0
  const b1 = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"secret":"内网元数据"}')
  })
  b1.on('connection', () => { connB1++ })
  const portB1 = await listen(b1)

  // ===== 目标服务 B2：记录收到的头/方法/body，返回 JSON =====
  const seenB2 = []
  const b2 = http.createServer(async (req, res) => {
    seenB2.push({ url: req.url, method: req.method, headers: req.headers, body: await readBody(req) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true,"from":"B2"}')
  })
  const portB2 = await listen(b2)

  // ===== 重定向服务 A：所有跳转场景 =====
  const seenA = []
  const a = http.createServer(async (req, res) => {
    const u = req.url
    seenA.push({ url: u, method: req.method, headers: req.headers, body: await readBody(req) })
    const redirect = (code, location) => {
      const h = { 'content-type': 'text/plain' }
      if (location !== undefined) h.Location = location
      res.writeHead(code, h)
      res.end('redirect')
    }
    if (u === '/to-zero') return redirect(302, 'http://0.0.0.0:' + portB1 + '/latest/meta-data/')
    if (u === '/to-meta') return redirect(302, 'http://169.254.169.254/latest/meta-data/')
    if (u === '/cross') return redirect(302, 'http://127.0.0.1:' + portB2 + '/ok')
    if (u === '/post-cross') return redirect(307, 'http://127.0.0.1:' + portB2 + '/echo')
    if (u === '/same-start') return redirect(302, '/same-final')
    if (u === '/same-final') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true,"from":"A"}')
    }
    if (u === '/noloc') return redirect(302, undefined)
    // 4 跳链（超过上限）与 3 跳链（正好在上限内）
    if (/^\/r[0-3]$/.test(u)) return redirect(302, '/r' + (Number(u.slice(2)) + 1))
    if (u === '/r4') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true,"from":"r4"}')
    }
    if (/^\/s[0-2]$/.test(u)) return redirect(302, '/s' + (Number(u.slice(2)) + 1))
    if (u === '/s3') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true,"from":"s3"}')
    }
    res.writeHead(404)
    res.end()
  })
  const portA = await listen(a)
  const A = 'http://127.0.0.1:' + portA

  try {
    // ===== 1. 302 到被禁止的目标：必须抛错，且目标服务零连接 =====
    await expectThrow('302→0.0.0.0（内网）抛错', () => ssrf.apiFetchJson(A + '/to-zero', 'Bearer {key}', 'SECRET', { allowLoopback: true }), '内网/保留')
    check('302→0.0.0.0 目标零连接', connB1 === 0, 'connections=' + connB1)
    // 对照：证明 0.0.0.0 确实能打到 B1 —— 否则"零连接"什么也证明不了
    const ctl = await fetch('http://0.0.0.0:' + portB1 + '/latest/meta-data/')
    await ctl.text()
    check('对照：直连 0.0.0.0 能打到 B1', ctl.status === 200 && connB1 === 1, 'status=' + ctl.status + ' connections=' + connB1)
    await expectThrow('302→169.254.169.254（云元数据）抛错', () => ssrf.apiFetchJson(A + '/to-meta', 'Bearer {key}', 'SECRET', { allowLoopback: true }), '内网/保留')

    // ===== 2. 302 到公网等价目标（allowLoopback:true）：正常返回 JSON =====
    const okJson = await ssrf.apiFetchJson(A + '/cross', 'Bearer {key}', 'SECRET', { allowLoopback: true })
    check('302→公网等价目标返回 JSON', okJson && okJson.ok === true && okJson.from === 'B2', JSON.stringify(okJson))

    // ===== 3. 跨源跳转剥凭据；同源跳转保留 =====
    const crossSeen = seenB2.find((r) => r.url === '/ok')
    check('跨源跳转不转发 Authorization', !!crossSeen && !('authorization' in crossSeen.headers),
      crossSeen ? 'headers=' + Object.keys(crossSeen.headers).join(',') : '未收到请求')
    const sameJson = await ssrf.apiFetchJson(A + '/same-start', 'Bearer {key}', 'SECRET', { allowLoopback: true })
    check('同源跳转正常返回 JSON', sameJson && sameJson.from === 'A', JSON.stringify(sameJson))
    const sameSeen = seenA.find((r) => r.url === '/same-final')
    check('同源跳转保留 Authorization', !!sameSeen && sameSeen.headers.authorization === 'Bearer SECRET',
      sameSeen ? 'authorization=' + String(sameSeen.headers.authorization) : '未收到请求')

    // 307 跨源：method 保留但 body 不转发（盲写原语被掐掉）
    await ssrf.apiFetchJson(A + '/post-cross', 'Bearer {key}', 'SECRET', { allowLoopback: true, method: 'POST', body: '{"uuid":"{key}"}' })
    const echoSeen = seenB2.find((r) => r.url === '/echo')
    check('307 跨源不转发 body', !!echoSeen && echoSeen.body === '', echoSeen ? 'method=' + echoSeen.method + ' body=' + JSON.stringify(echoSeen.body) : '未收到请求')

    // ===== 4. 跳数上限 =====
    await expectThrow('4 跳链抛错', () => ssrf.apiFetchJson(A + '/r0', 'Bearer {key}', 'SECRET', { allowLoopback: true }), '重定向次数过多')
    const three = await ssrf.apiFetchJson(A + '/s0', 'Bearer {key}', 'SECRET', { allowLoopback: true })
    check('3 跳链仍放行', three && three.from === 's3', JSON.stringify(three))
    await expectThrow('3xx 无 Location 抛错', () => ssrf.apiFetchJson(A + '/noloc', 'Bearer {key}', 'SECRET', { allowLoopback: true }), '缺少 Location')

    // ===== 5. Origin: null 必须拒 =====
    const host = '127.0.0.1:3080'
    const rej = (headers) => fence.selfRejection({ method: 'GET', headers }, {})
    check('Origin: null → 403', rej({ host, origin: 'null' }) === 403, String(rej({ host, origin: 'null' })))
    check('Origin: NULL（大写）→ 403', rej({ host, origin: 'NULL' }) === 403, String(rej({ host, origin: 'NULL' })))
    check('同源 Origin 放行', rej({ host, origin: 'http://' + host }) === null, String(rej({ host, origin: 'http://' + host })))
    check('无 Origin 放行', rej({ host }) === null, String(rej({ host })))
    check('跨源 Origin → 403', rej({ host, origin: 'http://evil.test' }) === 403, String(rej({ host, origin: 'http://evil.test' })))

    // ===== 6. IPv6 / IPv4 保留段字面量 =====
    const blocked = [
      ['::ffff:0:127.0.0.1', 'IPv4-translated ::ffff:0:0:0/96'],
      ['2002:7f00:1::', '6to4 2002::/16（内嵌 127.0.0.1）'],
      ['64:ff9b:1::1', '本地 NAT64 64:ff9b:1::/48'],
      ['::127.0.0.1', 'IPv4-compatible ::a.b.c.d'],
      ['ff02::1', '组播 ff00::/8'],
      ['240.0.0.1', '240/4'],
      ['198.18.0.1', '198.18/15'],
      ['192.0.0.1', '192.0.0/24'],
      ['255.255.255.255', '广播 255.255.255.255'],
    ]
    for (const [lit, why] of blocked) {
      const url = 'http://[' + lit + ']/'
      let ipThrew = false
      let urlThrew = false
      try { ssrf.assertSafeIp(lit, false) } catch (err) { ipThrew = true }
      try { await ssrf.assertSafeApiUrl(url, { allowLoopback: false }) } catch (err) { urlThrew = true }
      check('拒绝 ' + lit, ipThrew && urlThrew, why + '；assertSafeIp=' + ipThrew + ' assertSafeApiUrl=' + urlThrew)
    }
    // 不误伤：公网地址与 allowLoopback 语义不变
    const allowed = ['8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8', '2002:0808:0808::']
    for (const lit of allowed) {
      let threw = ''
      try { ssrf.assertSafeIp(lit, false) } catch (err) { threw = String(err.message) }
      check('放行公网 ' + lit, threw === '', threw)
    }
    let lb = ''
    try { ssrf.assertSafeIp('127.0.0.1', true); ssrf.assertSafeIp('::1', true); ssrf.assertSafeIp('::ffff:127.0.0.1', true) } catch (err) { lb = String(err.message) }
    check('allowLoopback:true 仍放行回环', lb === '', lb)
    let lbOff = 0
    for (const lit of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      try { ssrf.assertSafeIp(lit, false) } catch (err) { lbOff++ }
    }
    check('allowLoopback:false 仍拒回环', lbOff === 3, '拒绝 ' + lbOff + '/3')
  } finally {
    await closeServer(a)
    await closeServer(b2)
    await closeServer(b1)
  }
}

await main()

w('用例'.padEnd(46) + '结果'.padEnd(8) + '细节')
let fail = 0
for (const r of rows) {
  if (!r.ok) fail++
  w(r.label.padEnd(46) + (r.ok ? 'OK' : 'FAIL').padEnd(8) + r.detail.slice(0, 110))
}
w('\n' + (fail === 0 ? '全部通过（' + rows.length + ' 项）' : fail + ' 项不符（共 ' + rows.length + ' 项）'))
process.exitCode = fail === 0 ? 0 : 1
