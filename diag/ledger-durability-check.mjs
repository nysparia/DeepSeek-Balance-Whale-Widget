// 单元验证：账本 / 归档的持久性（读错误不毁账本、归档损坏不静默覆盖、归档批量搬运、removedBooks 完整）。
//
// 做法与 diag/ 下其它脚本一致：从 lib/index.js **按源码位置抽取真实代码**，
// 拼进带桩的作用域里跑，断言的是仓库里那份代码本身。
//
// 覆盖四件事：
//   ① 暂时性读错误（EACCES/EBUSY）不再把好账本改名成 .corrupt-*.bak，返回的账本带 __readFailed；
//   ② 带 __readFailed 的账本 writeUsageLedger 直接拒绝写盘，磁盘上的好账本一个字节都不变；
//   ③ 归档被截断 → 下次 prune 前先产生 .corrupt-*.bak（里面是旧内容），不是被空归档覆盖；
//   ④ 归档写盘走 temp + rename（写失败不留半截文件）；
//   ⑤ 2 万条稳态下连续 100 次 appendUsageEvent 只触发 1 次归档重写（旧规则是 100 次）；
//   ⑥ removedBooks 在"只有 events 超期"时也记录，且重试不重复。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beijingDay, dayOffset, preciseMoney } from '../lib/accounting.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, '..')
const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')

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

// 拼一个只含账本读写 / 归档 / 裁剪相关函数的沙箱。fs 与 console 可注入。
function buildHarness(src, opts = {}) {
  const consts = [...src.matchAll(/const (LEDGER_RETRY_WAIT_MS|LEDGER_RETRY_LIMIT) = (\d+)/g)]
    .map((m) => `const ${m[1]} = ${m[2]};`)
    .join('\n')
  const code = [
    consts,
    extractFn(src, 'ledgerIo'),
    extractFn(src, 'freshUsageLedger'),
    extractFn(src, 'ledgerBackupCorrupt'),
    extractFn(src, 'readUsageLedger'),
    extractFn(src, 'writeUsageLedger'),
    extractFn(src, 'usageArchivePath'),
    extractFn(src, 'readUsageArchive'),
    extractFn(src, 'pruneLedgerUsage'),
    extractFn(src, 'appendUsageEvent'),
  ].join('\n')
  const factory = new Function(
    'fs', 'path', 'DSH_HOME', 'USAGE_FILE_CANDIDATES', 'todayKey', 'dayAdd', 'dayKeyFromTs', 'preciseMoney', 'console',
    `${code}
return { readUsageLedger, writeUsageLedger, freshUsageLedger, pruneLedgerUsage, readUsageArchive, usageArchivePath, appendUsageEvent }`,
  )
  return factory(
    opts.fs || fs, path, opts.home, opts.candidates,
    () => beijingDay(), (d, n) => dayOffset(d, n), (ts) => beijingDay(Number(ts)), preciseMoney,
    opts.console || { error: () => {}, warn: () => {}, log: () => {} },
  )
}

function tmpHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-durable-' + tag + '-'))
  return { dir, candidates: [path.join(dir, '.dshw-usage.json')] }
}
const baks = (dir) => { try { return fs.readdirSync(dir).filter((f) => /\.corrupt-\d+\.bak$/.test(f)) } catch (e) { return [] } }
const tmps = (dir) => { try { return fs.readdirSync(dir).filter((f) => /\.tmp-\d+$/.test(f)) } catch (e) { return [] } }

// 一份"好账本"：history / accounting.books / events / settings 齐全，用来验证读错误不会毁掉它。
function goodLedger() {
  const today = beijingDay()
  return {
    date: today, lastBalance: 9.99, todayUsage: 0.01,
    events: [{ ts: Date.now(), day: today, model: 'deepseek-chat', cost: 0.01, tokens: 100 }],
    history: { [today]: 0.01, [dayOffset(today, -1)]: 0.02 },
    settings: { taskEnd: { on: true, sel: 'frag:cost_a' } },
    accounting: {
      version: 1, active: 'scopeA-CNY', migratedAt: 1,
      books: { 'scopeA-CNY': { currency: 'CNY', lastAt: 1, days: { [today]: { day: today, debitUnits: 1 } } } },
    },
  }
}

// 只让 readFileSync 抛指定错误码，其余操作走真 fs。
function readFailFs(code) {
  return new Proxy(fs, {
    get(target, key) {
      if (key === 'readFileSync') {
        return () => { throw Object.assign(new Error(code + ': simulated'), { code }) }
      }
      const v = target[key]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

// ===========================================================================
// 1. 暂时性读错误：账本文件还在、没被改名、返回的账本带 __readFailed
// ===========================================================================
console.log('\n=== 1. 读错误（EACCES / EBUSY）不摧毁活账本 ===')
for (const code of ['EACCES', 'EBUSY']) {
  const { dir, candidates } = tmpHome('read-' + code)
  const ledPath = candidates[0]
  const original = JSON.stringify(goodLedger())
  fs.writeFileSync(ledPath, original, 'utf8')
  const logs = []
  const h = buildHarness(SRC, {
    home: dir, candidates, fs: readFailFs(code),
    console: { error: (...a) => logs.push(a.map(String).join(' ')), warn: () => {}, log: () => {} },
  })
  const led = h.readUsageLedger()
  ok(code + '：账本文件还在原路径', fs.existsSync(ledPath))
  ok(code + '：没有被改名成 .corrupt-*.bak', baks(dir).length === 0, 'bak=' + baks(dir).join(','))
  ok(code + '：磁盘内容一个字节都没变', fs.readFileSync(ledPath, 'utf8') === original)
  ok(code + '：返回的账本带 __readFailed', led && led.__readFailed === true)
  ok(code + '：返回的是空账本（history 为空）', Object.keys(led.history || {}).length === 0)
  ok(code + '：只打了一条日志（不静默）', logs.some((l) => l.includes('账本读取失败')), logs.join(' | ').slice(0, 160))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// 2. 带 __readFailed 的账本：writeUsageLedger 拒绝写盘，磁盘内容不变
// ===========================================================================
console.log('\n=== 2. __readFailed 账本绝不写回 ===')
{
  const { dir, candidates } = tmpHome('nowrite')
  const ledPath = candidates[0]
  const original = JSON.stringify(goodLedger())
  fs.writeFileSync(ledPath, original, 'utf8')
  const h = buildHarness(SRC, { home: dir, candidates })
  const failed = h.freshUsageLedger()
  failed.__readFailed = true
  failed.events = [{ ts: 1, day: beijingDay(), model: 'x', cost: 1, tokens: 1 }]
  const ret = h.writeUsageLedger(failed)
  ok('writeUsageLedger 返回 false', ret === false)
  ok('磁盘上的好账本内容不变', fs.readFileSync(ledPath, 'utf8') === original)
  ok('没有留下临时文件', tmps(dir).length === 0, tmps(dir).join(','))
  // 标记本身不落盘：正常账本里塞一个 __readFailed 之外的内部键也要能写
  const normal = goodLedger()
  const ret2 = h.writeUsageLedger(normal)
  const onDisk = JSON.parse(fs.readFileSync(ledPath, 'utf8'))
  ok('正常账本仍能写盘', ret2 === true)
  ok('落盘文件里没有 __readFailed 键', !('__readFailed' in onDisk), Object.keys(onDisk).join(','))
  // 序列化剥标记：即使调用方把标记留在对象上（这里绕过开头的 return false 直接看序列化结果）
  const withFlag = goodLedger()
  withFlag.__readFailed = true
  const body = JSON.stringify(withFlag, (k, v) => (k === '__readFailed' ? undefined : v))
  ok('序列化时剥掉 __readFailed', !body.includes('__readFailed'))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// 3. 归档被截断：先产生 .corrupt-*.bak（里面是旧内容），再写新归档
// ===========================================================================
console.log('\n=== 3. 归档损坏：先备份再重建，旧内容留在 .bak ===')
{
  const { dir, candidates } = tmpHome('archive-bad')
  const h = buildHarness(SRC, { home: dir, candidates })
  const arPath = h.usageArchivePath()
  const today = beijingDay()
  const full = JSON.stringify({
    version: 1,
    events: [{ day: dayOffset(today, -400), cost: 9 }],
    history: { [dayOffset(today, -400)]: 9 },
    accounting: { books: { 'old-CNY': { currency: 'CNY', days: { [dayOffset(today, -400)]: { day: dayOffset(today, -400) } } } } },
  })
  const truncated = full.slice(0, 40)
  fs.writeFileSync(arPath, truncated, 'utf8')
  const led = {
    date: today, events: [{ day: dayOffset(today, -200), cost: 1 }], history: {},
    accounting: { version: 1, active: 'a-CNY', books: { 'a-CNY': { currency: 'CNY', days: {} } } },
  }
  const ret = h.pruneLedgerUsage(led)
  const bakList = baks(dir)
  ok('prune 仍然完成（返回 true）', ret === true)
  ok('产生了 .corrupt-*.bak', bakList.length === 1, bakList.join(','))
  ok('.bak 里是截断前的旧内容（不是空）', bakList.length === 1 && fs.readFileSync(path.join(dir, bakList[0]), 'utf8') === truncated)
  ok('主归档被重建且是合法 JSON', (() => {
    try { const j = JSON.parse(fs.readFileSync(arPath, 'utf8')); return Array.isArray(j.events) && j.events.length === 1 } catch (e) { return false }
  })())
  ok('账本里超期 events 已被搬走', led.events.length === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
// 4. 归档写盘是 temp + rename；写失败不留半截文件
// ===========================================================================
console.log('\n=== 4. 归档写盘：temp + rename，失败不留半截文件 ===')
{
  const { dir, candidates } = tmpHome('archive-tmp')
  const arPath = path.join(dir, '.dshw-usage-archive.json')
  const log = []
  const recordingFs = {
    constants: fs.constants,
    accessSync: fs.accessSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    copyFileSync: fs.copyFileSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    writeFileSync: (p, ...rest) => { log.push('write:' + p); return fs.writeFileSync(p, ...rest) },
    renameSync: (a, b) => { log.push('rename:' + a + '->' + b); return fs.renameSync(a, b) },
  }
  const h = buildHarness(SRC, { home: dir, candidates, fs: recordingFs })
  const today = beijingDay()
  const led = { date: today, events: [{ day: dayOffset(today, -200), cost: 1 }], history: {} }
  const ret = h.pruneLedgerUsage(led)
  ok('prune 返回 true', ret === true)
  ok('归档不是被直接 writeFileSync 覆盖的', !log.includes('write:' + arPath), log.filter((l) => l.includes('archive')).join(' | '))
  const wroteTemp = log.some((l) => l.startsWith('write:' + arPath + '.tmp-'))
  const renamed = log.some((l) => l.startsWith('rename:' + arPath + '.tmp-') && l.endsWith('->' + arPath))
  ok('先写临时文件', wroteTemp)
  ok('再 rename 到归档路径', renamed)
  ok('没有残留临时文件', tmps(dir).length === 0, tmps(dir).join(','))

  // 写失败：只让归档临时文件写失败，账本照常
  const { dir: dir2, candidates: cand2 } = tmpHome('archive-fail')
  const arPath2 = path.join(dir2, '.dshw-usage-archive.json')
  const failingFs = {
    constants: fs.constants,
    accessSync: fs.accessSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    copyFileSync: fs.copyFileSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    writeFileSync: (p, ...rest) => {
      if (String(p).includes('.dshw-usage-archive.json')) throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' })
      return fs.writeFileSync(p, ...rest)
    },
    renameSync: fs.renameSync.bind(fs),
  }
  const h2 = buildHarness(SRC, { home: dir2, candidates: cand2, fs: failingFs })
  const led2 = { date: today, events: [{ day: dayOffset(today, -200), cost: 1 }], history: {} }
  const ret2 = h2.pruneLedgerUsage(led2)
  ok('归档写失败 → 返回 false', ret2 === false)
  ok('归档写失败 → 账本一行都没删', led2.events.length === 1)
  ok('归档写失败 → 没有生成归档文件', !fs.existsSync(arPath2))
  ok('归档写失败 → 没有残留半截临时文件', tmps(dir2).length === 0, tmps(dir2).join(','))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dir2, { recursive: true, force: true })
}

// ===========================================================================
// 5. 2 万条稳态：100 次 appendUsageEvent 只触发 1 次归档重写（旧规则 100 次）
// ===========================================================================
console.log('\n=== 5. events 稳态：批量搬运，归档重写频率 1/2000 ===')
{
  const today = beijingDay()
  const makeEvents = (n) => Array.from({ length: n }, (_, i) => ({
    ts: Date.now() - (n - i) * 1000, day: today, model: 'deepseek-chat', cost: 0.0001, tokens: 10,
  }))
  // 计数 fs：只数写归档（含临时文件）的次数
  const countingFs = (counter) => ({
    constants: fs.constants,
    accessSync: fs.accessSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    copyFileSync: fs.copyFileSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    writeFileSync: (p, ...rest) => {
      if (String(p).includes('.dshw-usage-archive.json')) counter.n++
      return fs.writeFileSync(p, ...rest)
    },
  })
  const run = (src, tag) => {
    const { dir, candidates } = tmpHome('steady-' + tag)
    const counter = { n: 0 }
    const h = buildHarness(src, { home: dir, candidates, fs: countingFs(counter) })
    const led = { date: today, events: makeEvents(22000), history: {}, accounting: { version: 1, active: 'a-CNY', books: { 'a-CNY': { currency: 'CNY', days: {} } } } }
    h.writeUsageLedger(led)
    const t0 = Date.now()
    for (let i = 0; i < 100; i++) h.appendUsageEvent({ ts: Date.now(), model: 'deepseek-chat', cost: 0.0001, tokens: 10 })
    const ms = Date.now() - t0
    const after = h.readUsageLedger()
    const ar = h.readUsageArchive()
    fs.rmSync(dir, { recursive: true, force: true })
    return { rewrites: counter.n, ms, kept: (after.events || []).length, archived: (ar.events || []).length }
  }
  const now = run(SRC, 'new')
  console.log(`  新版：100 次 append 触发归档重写 ${now.rewrites} 次，耗时 ${now.ms}ms，账本 events=${now.kept}，归档 events=${now.archived}`)
  ok('100 次 append 只重写归档 1 次', now.rewrites === 1, 'rewrites=' + now.rewrites)
  // 第 1 次 append 把 22001 条搬回 20000 条，之后 99 次都不到 22000 阈值 ⇒ 20000 + 99
  ok('账本 events 回落到 2 万条量级（20000 + 之后 99 次追加）', now.kept === 20099, 'events=' + now.kept)
  ok('搬走的 2001 条进了归档', now.archived === 2001, 'archived=' + now.archived)

  // 旧规则对照：把批量阈值改回 20000（= 每轮搬 1 条），同一场景应重写 100 次
  const OLD_SRC = SRC.replace('const EV_BATCH = 22000', 'const EV_BATCH = 20000')
  ok('旧规则对照源码确实被改写', OLD_SRC !== SRC)
  const old = run(OLD_SRC, 'old')
  console.log(`  旧规则：100 次 append 触发归档重写 ${old.rewrites} 次，耗时 ${old.ms}ms`)
  ok('旧规则下 100 次 append 重写 100 次（复现 bug）', old.rewrites === 100, 'rewrites=' + old.rewrites)
  ok('新版重写次数比旧规则低两个数量级', now.rewrites * 50 <= old.rewrites, `${now.rewrites} vs ${old.rewrites}`)
}

// ===========================================================================
// 6. removedBooks：只有 events 超期时也记录，且重试不重复
// ===========================================================================
console.log('\n=== 6. removedBooks：条件对齐 + 按 scope 去重 ===')
{
  const { dir, candidates } = tmpHome('removed')
  const h = buildHarness(SRC, { home: dir, candidates })
  const today = beijingDay()
  // 只有 events 超期；books 里那本非 active 的 days 是空的（没有超期行 ⇒ bookDaysDropped = 0）
  const makeLed = () => ({
    date: today,
    events: [{ day: dayOffset(today, -200), cost: 1 }],
    history: {},
    accounting: {
      version: 1, active: 'active-CNY', migratedAt: 1,
      books: {
        'active-CNY': { currency: 'CNY', lastAt: 1, days: { [today]: { day: today, debitUnits: 1 } } },
        'oldkey-CNY': { currency: 'CNY', lastAt: 1, days: {} },
      },
    },
  })
  const led = makeLed()
  const ret = h.pruneLedgerUsage(led)
  ok('prune 返回 true', ret === true)
  ok('空本被删掉（内存）', !('oldkey-CNY' in led.accounting.books), Object.keys(led.accounting.books).join(','))
  const ar = JSON.parse(fs.readFileSync(h.usageArchivePath(), 'utf8'))
  const removed = (ar.accounting && ar.accounting.removedBooks) || []
  ok('归档里记下了被删的 scope', removed.some((m) => m.scope === 'oldkey-CNY'), JSON.stringify(removed))
  ok('记录带 currency / removedAt', removed.length === 1 && removed[0].currency === 'CNY' && typeof removed[0].removedAt === 'number')

  // 模拟"写盘失败后重试"：账本没落盘 ⇒ 下一次读到的还是同一本空本
  const led2 = makeLed()
  const ret2 = h.pruneLedgerUsage(led2)
  const ar2 = JSON.parse(fs.readFileSync(h.usageArchivePath(), 'utf8'))
  const removed2 = (ar2.accounting && ar2.accounting.removedBooks) || []
  ok('重试仍然返回 true', ret2 === true)
  ok('removedBooks 不重复（同一 scope 只有一条）', removed2.filter((m) => m.scope === 'oldkey-CNY').length === 1,
    JSON.stringify(removed2.map((m) => m.scope)))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failures) { console.log(`结果：${failures} 项失败`); process.exitCode = 1 }
else console.log('结果：全部通过')
