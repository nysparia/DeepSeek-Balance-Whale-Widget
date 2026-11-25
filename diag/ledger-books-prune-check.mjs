// 单元验证：账本 accounting.books[*].days 无限增长（pruneLedgerUsage 只清 events/history）。
//
// 做法与 diag/ 下其它脚本一致：从 lib/index.js **按源码位置抽取真实代码**，
// 拼进带桩的作用域里跑，断言的是仓库里那份代码本身。
// 同时从 `git show <修复前>:lib/index.js` 抽旧版做 before/after 对照。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beijingDay, dayOffset } from '../lib/accounting.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, '..')
const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')

// "旧版"基线：沿 lib/index.js 的历史往回找，取最近一个**仍只清 events/history** 的版本。
function findOldBaseline() {
  const revs = execFileSync('git', ['rev-list', 'HEAD', '--', 'lib/index.js'], { cwd: REPO, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  for (const rev of revs) {
    const src = execFileSync('git', ['show', rev + ':lib/index.js'], { cwd: REPO, encoding: 'utf8' })
    if (src.includes('function pruneLedgerUsage(led)')
      && !src.includes('bookDaysDropped')
      && src.includes('ar.history = Object.assign({}, ar.history || {}, dropHist)')) return { rev, src }
  }
  throw new Error('找不到修复前的 lib/index.js 基线')
}
const baseline = findOldBaseline()
const OLD = baseline.src
console.log('旧版基线：' + baseline.rev.slice(0, 7))

let failures = 0
function ok(name, cond, detail) {
  if (cond) { console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { failures++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// —— 按函数名抽取源码（从 `function NAME(` 到配对的花括号）——
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(')
  if (at < 0) throw new Error('function not found: ' + name)
  const open = src.indexOf('{', at)
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
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// 拼一个只含账本保留策略相关函数的沙箱。fs 可注入（用来模拟归档写盘失败）。
function buildHarness(src, opts = {}) {
  const code = [
    extractFn(src, 'usageArchivePath'),
    extractFn(src, 'readUsageArchive'),
    extractFn(src, 'pruneLedgerUsage'),
  ].join('\n')
  const factory = new Function(
    'fs', 'path', 'DSH_HOME', 'USAGE_FILE_CANDIDATES', 'todayKey', 'dayAdd', 'console',
    `${code}
return { pruneLedgerUsage, usageArchivePath, readUsageArchive }`,
  )
  return factory(
    opts.fs || fs, path, opts.home, opts.candidates,
    () => beijingDay(), (d, n) => dayOffset(d, n), opts.console || console,
  )
}

function tmpHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-books-' + tag + '-'))
  return { dir, candidates: [path.join(dir, '.dshw-usage.json')] }
}

// 构造一个带 accounting.books 的账本：days 从 today-399 到 today，共 400 天。
function makeLedger(days = 400, scopes = ['scopeA-CNY']) {
  const today = beijingDay()
  const books = {}
  for (const scope of scopes) {
    const d = {}
    for (let i = days - 1; i >= 0; i--) {
      const day = dayOffset(today, -i)
      d[day] = {
        day, firstAt: Date.parse(day + 'T00:00:00+08:00') + 60000,
        lastAt: Date.parse(day + 'T00:00:00+08:00') + 3600000,
        openingUnits: 1000000000, lastUnits: 999000000,
        debitUnits: 1000000, creditUnits: 0, revision: 0, correction: null,
      }
    }
    books[scope] = { currency: 'CNY', days: d, lastAt: Date.parse(today + 'T00:00:00+08:00') + 3600000 }
  }
  const history = {}
  for (let i = days - 1; i >= 0; i--) history[dayOffset(today, -i)] = 0.01
  return {
    date: today, dayStart: 10, lastBalance: 9.99, todayUsage: 0.01,
    events: [], history, accounting: { version: 1, active: scopes[0], books, migratedAt: 1, legacyHistory: { '2000-01-01': 1 } },
  }
}

const countDays = (led) => Object.values(led.accounting.books).reduce((n, b) => n + Object.keys(b.days || {}).length, 0)
const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8')

// ===========================================================================
// 1. 400 天账本 → prune 后只剩 365 天内的行
// ===========================================================================
console.log('\n=== 1. 400 天账本：books[*].days 是否被裁剪 ===')
{
  const { dir, candidates } = tmpHome('main')
  const oldH = buildHarness(OLD, { home: dir, candidates })
  const newH = buildHarness(SRC, { home: dir, candidates })

  const ledOld = makeLedger(400)
  const beforeOld = countDays(ledOld)
  const retOld = oldH.pruneLedgerUsage(ledOld)
  const afterOld = countDays(ledOld)
  console.log(`  旧版：books.days ${beforeOld} → ${afterOld}，history ${Object.keys(ledOld.history).length}，返回 ${retOld}`)
  ok('旧版确实不清 books.days（复现 bug）', beforeOld === 400 && afterOld === 400,
    `books.days=${afterOld}`)
  ok('旧版 history 被清了（对照：说明 prune 本身跑到了）', Object.keys(ledOld.history).length === 366,
    `history=${Object.keys(ledOld.history).length}`)

  const led = makeLedger(400)
  const before = countDays(led)
  const beforeBytes = bytes(led)
  const ret = newH.pruneLedgerUsage(led)
  const after = countDays(led)
  const afterBytes = bytes(led)
  console.log(`  新版：books.days ${before} → ${after}，history ${Object.keys(led.history).length}，返回 ${ret}`)
  console.log(`  账本 JSON：${beforeBytes} 字节 → ${afterBytes} 字节（省 ${beforeBytes - afterBytes}）`)
  // 口径：cutoff = today-365，删 day < cutoff ⇒ 保留 [today-365, today] 共 366 个日历日（含首尾）。
  // 这与 history 的既有口径逐字一致（下面那条断言就是在钉这一点）。
  ok('新版把 books.days 裁到 365 天窗口内（366 个日历日，含首尾）', after === 366, `books.days=${after}`)
  ok('新版返回 true（调用方会写盘）', ret === true)
  ok('保留的日期都在 365 天内', Object.values(led.accounting.books).every((b) => Object.keys(b.days).every((d) => d >= dayOffset(beijingDay(), -365))))
  ok('history 与 books.days 的裁剪口径一致（都是 365 天）',
    Object.keys(led.history).length === after, `history=${Object.keys(led.history).length} books.days=${after}`)
  ok('账本体积确实变小', afterBytes < beforeBytes, `${beforeBytes} → ${afterBytes}`)

  // 归档
  const arPath = newH.usageArchivePath()
  ok('归档文件已生成', fs.existsSync(arPath), arPath)
  const ar = JSON.parse(fs.readFileSync(arPath, 'utf8'))
  const arcDays = ar.accounting && ar.accounting.books && ar.accounting.books['scopeA-CNY']
    ? Object.keys(ar.accounting.books['scopeA-CNY'].days).length : 0
  ok('归档里能看到被删的 34 行', arcDays === 34, `ar.accounting.books[scopeA-CNY].days=${arcDays}`)
  ok('归档行内容完整（不是只留日期）',
    ar.accounting.books['scopeA-CNY'].days[dayOffset(beijingDay(), -399)]?.debitUnits === 1000000)
  ok('归档 note 写清了归档了什么', typeof ar.note === 'string' && ar.note.includes('books'), ar.note)
  ok('归档保留了 events / history 字段结构',
    Array.isArray(ar.events) && ar.history && typeof ar.history === 'object')
  ok('归档 history 也收到 34 天', Object.keys(ar.history).length === 34, `ar.history=${Object.keys(ar.history).length}`)
  ok('legacyHistory 原样保留（不参与裁剪）', led.accounting.legacyHistory['2000-01-01'] === 1)

  // 幂等：再跑一次不该再删
  const ret2 = newH.pruneLedgerUsage(led)
  ok('第二次 prune 无事可做，返回 false', ret2 === false && countDays(led) === 366, `ret=${ret2} books.days=${countDays(led)}`)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// 2. 空 book：非 active 整本删掉，active 保留
// ===========================================================================
console.log('\n=== 2. 清空后的 book：非 active 删整本，active 保留 ===')
{
  const { dir, candidates } = tmpHome('empty')
  const h = buildHarness(SRC, { home: dir, candidates })
  const today = beijingDay()
  // 两本都只有 400 天前的旧行（全部超期）⇒ 清空后一本 active、一本不是
  const stale = (n) => {
    const d = {}
    for (let i = 0; i < n; i++) {
      const day = dayOffset(today, -400 - i)
      d[day] = { day, firstAt: 1, lastAt: 2, openingUnits: 1, lastUnits: 1, debitUnits: 0, creditUnits: 0, revision: 0, correction: null }
    }
    return d
  }
  const led = {
    date: today, events: [], history: {},
    accounting: {
      version: 1, active: 'active-CNY', migratedAt: 1,
      books: {
        'active-CNY': { currency: 'CNY', days: stale(3), lastAt: 1 },
        'oldkey-CNY': { currency: 'CNY', days: stale(5), lastAt: 1 },
      },
    },
  }
  const ret = h.pruneLedgerUsage(led)
  ok('prune 返回 true', ret === true)
  ok('非 active 的空 book 被整本删掉', !('oldkey-CNY' in led.accounting.books),
    'books=' + Object.keys(led.accounting.books).join(','))
  ok('active 的 book 即使 days 空了也保留', 'active-CNY' in led.accounting.books)
  ok('active 的 days 现在是空对象', Object.keys(led.accounting.books['active-CNY'].days).length === 0)
  const ar = JSON.parse(fs.readFileSync(h.usageArchivePath(), 'utf8'))
  ok('被删整本的 scope 记进归档 removedBooks',
    Array.isArray(ar.accounting.removedBooks) && ar.accounting.removedBooks.some((m) => m.scope === 'oldkey-CNY'),
    JSON.stringify(ar.accounting.removedBooks))
  ok('被删整本的日行也归档了（5 行）',
    Object.keys(ar.accounting.books['oldkey-CNY'].days).length === 5)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// 3. 结构异常：不抛错、不误删
// ===========================================================================
console.log('\n=== 3. 结构异常 / 缺失：跳过，不抛错 ===')
{
  const { dir, candidates } = tmpHome('bad')
  const h = buildHarness(SRC, { home: dir, candidates })
  const today = beijingDay()
  const cases = [
    ['led.accounting 缺失', { date: today, events: [], history: {} }],
    ['accounting 版本不对', { date: today, events: [], history: {}, accounting: { version: 2, active: 'x', books: { x: { days: { '2000-01-01': {} } } } } }],
    ['books 不是对象（数组）', { date: today, events: [], history: {}, accounting: { version: 1, active: 'x', books: [1, 2] } }],
    ['books 是字符串', { date: today, events: [], history: {}, accounting: { version: 1, active: 'x', books: 'nope' } }],
    ['某本 days 不是对象', { date: today, events: [], history: {}, accounting: { version: 1, active: 'x', books: { x: { days: 'nope' }, y: { days: null } } } }],
    ['某本本身是 null', { date: today, events: [], history: {}, accounting: { version: 1, active: 'x', books: { x: null, y: 5 } } }],
    ['accounting 是 null', { date: today, events: [], history: {}, accounting: null }],
  ]
  for (const [label, led] of cases) {
    let threw = null
    let ret
    try { ret = h.pruneLedgerUsage(led) } catch (err) { threw = err }
    ok(label + ' → 不抛错', threw === null, threw ? threw.message : '')
    ok(label + ' → 返回 false（没东西可清）', ret === false, 'ret=' + ret)
  }
  // 结构异常但 events 超期：仍然只清 events，不因 books 异常整体失败
  const led2 = { date: today, events: [{ day: '2000-01-01', cost: 1 }], history: {}, accounting: { version: 1, active: 'x', books: 'nope' } }
  const ret2 = h.pruneLedgerUsage(led2)
  ok('books 异常时 events 仍被正常清理（不整体放弃）', ret2 === true && led2.events.length === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// 4. 归档写盘失败 → 不删数据
// ===========================================================================
console.log('\n=== 4. 归档写盘失败：返回 false 且一行都不删 ===')
{
  const { dir, candidates } = tmpHome('fail')
  const failingFs = {
    accessSync: () => {},
    readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    writeFileSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
  }
  const h = buildHarness(SRC, { home: dir, candidates, fs: failingFs })
  const led = makeLedger(400)
  const beforeDays = countDays(led)
  const beforeHist = Object.keys(led.history).length
  const beforeEv = led.events.length
  const ret = h.pruneLedgerUsage(led)
  ok('归档写失败 → 返回 false', ret === false)
  ok('books.days 一行都没删', countDays(led) === beforeDays, `${beforeDays} → ${countDays(led)}`)
  ok('history 一行都没删', Object.keys(led.history).length === beforeHist, `${beforeHist} → ${Object.keys(led.history).length}`)
  ok('events 一条都没删', led.events.length === beforeEv)
  ok('没有生成归档文件', !fs.existsSync(path.join(dir, '.dshw-usage-archive.json')))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// 5. 归档已有内容不被破坏
// ===========================================================================
console.log('\n=== 5. 已有归档：events / history / accounting 都保留 ===')
{
  const { dir, candidates } = tmpHome('merge')
  const h = buildHarness(SRC, { home: dir, candidates })
  const arPath = h.usageArchivePath()
  fs.writeFileSync(arPath, JSON.stringify({
    version: 1, events: [{ day: '1999-01-01', cost: 9 }], history: { '1999-01-01': 9 },
    accounting: { books: { 'scopeA-CNY': { currency: 'CNY', days: { '1998-01-01': { day: '1998-01-01' } } } } },
    note: '旧 note',
  }), 'utf8')
  const led = makeLedger(400)
  h.pruneLedgerUsage(led)
  const ar = JSON.parse(fs.readFileSync(arPath, 'utf8'))
  ok('旧 events 保留', ar.events.some((e) => e.day === '1999-01-01'))
  ok('旧 history 保留', ar.history['1999-01-01'] === 9)
  ok('旧 accounting.books 日行保留', !!ar.accounting.books['scopeA-CNY'].days['1998-01-01'])
  ok('新归档的 34 行合并进来（34 + 旧 1 = 35）', Object.keys(ar.accounting.books['scopeA-CNY'].days).length === 35,
    String(Object.keys(ar.accounting.books['scopeA-CNY'].days).length))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// 6. 多本 × 多年：增长量实测
// ===========================================================================
console.log('\n=== 6. 增长量实测（单日行字节数 / 多本多年体积）===')
{
  const { dir, candidates } = tmpHome('size')
  const h = buildHarness(SRC, { home: dir, candidates })
  const one = makeLedger(1)
  const rowBytes = bytes(one.accounting.books['scopeA-CNY'].days[beijingDay()])
  console.log(`  单日行 JSON：${rowBytes} 字节`)
  for (const [years, scopes] of [[1, 1], [3, 1], [5, 1], [5, 4]]) {
    const led = makeLedger(years * 365, Array.from({ length: scopes }, (_, i) => 'scope' + i + '-CNY'))
    const b = bytes(led)
    h.pruneLedgerUsage(led)
    const a = bytes(led)
    console.log(`  ${years} 年 × ${scopes} 本：${(b / 1024).toFixed(1)}KB → ${(a / 1024).toFixed(1)}KB（books.days ${years * 365 * scopes} → ${countDays(led)}）`)
    const expect = Math.min(years * 365, 366) * scopes
    ok(`${years} 年 × ${scopes} 本：prune 后体积收敛到 365 天量级`, countDays(led) === expect,
      `books.days=${countDays(led)}（期望 ${expect}）`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failures) { console.log(`结果：${failures} 项失败`); process.exit(1) }
console.log('结果：全部通过')
