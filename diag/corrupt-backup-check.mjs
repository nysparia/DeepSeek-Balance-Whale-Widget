// 单元验证：四份 JSON 配置（泡泡配置 / 角色索引 / 音效索引 / 泡泡图库索引）的损坏备份。
//
// 做法：从 lib/index.js 里**按函数名抽取真实源码**（括号配对，不复制粘贴），
// 拼进一个带 fs/path 与目录桩的作用域里跑。这样断言的是仓库里那份代码本身，
// 而不是测试里另写的一份"应该长这样"。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeExtractor } from './_extract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')

// —— 按函数名抽取源码（从 `function NAME(` 到配对的花括号）——
// 抽取器在 diag/_extract.mjs（共用；`async function` 不会被截掉 async）。
const extractFn = makeExtractor(SRC)

const FN_NAMES = [
  'backupCorruptFile',
  'readRolesIndex', 'defaultRolesIndex',
  'readAudioIndex', 'defaultAudioIndex',
  'readBubbleImgIndex', 'defaultBubbleImgIndex',
  'loadBubbleConfig',
]
const body = FN_NAMES.map(extractFn).join('\n\n')

// 目录桩：把 pick*Dir 固定到测试目录；常量按仓库真实值给。
function build(dirs, logs) {
  const factory = new Function('fs', 'path', 'console', 'DIRS', 'ROLE_INDEX_NAME', 'AUDIO_INDEX_NAME',
    'BUBBLE_IMG_INDEX_NAME', 'ROLE_DEFAULT_ID', 'BUBBLE_FILE_CANDIDATES', `
const pickRoleDir = () => DIRS.roles
const pickAudioDir = () => DIRS.audio
const pickBubbleImgDir = () => DIRS.imgs
${body}
return { backupCorruptFile, readRolesIndex, readAudioIndex, readBubbleImgIndex, loadBubbleConfig }
`)
  return factory(fs, path, { error: (...a) => logs.push(a.map(String).join(' ')), warn: () => {} },
    dirs, 'roles.json', 'audio.json', 'bubble-imgs.json', 'default', dirs.bubbleCandidates)
}

// —— 断言工具 ——
let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')) }
}
function baks(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.corrupt-\d+\.bak$/.test(f)) } catch (e) { return [] }
}
function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-corrupt-'))
}
function makeDirs(root) {
  const dirs = {
    roles: path.join(root, 'whale-roles'),
    audio: path.join(root, 'whale-audio'),
    imgs: path.join(root, 'whale-bubble-imgs'),
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  dirs.bubbleCandidates = [path.join(root, '.dshw-bubble.json')]
  return dirs
}

const BAD = '{"broken":'

// ===========================================================================
console.log('\n[1] 坏 JSON → 生成 .corrupt-<ts>.bak，内容与坏文件一致')
// ===========================================================================
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const api = build(dirs, logs)

  const targets = [
    ['角色索引 roles.json', path.join(dirs.roles, 'roles.json'), () => api.readRolesIndex(), 'roles'],
    ['音效索引 audio.json', path.join(dirs.audio, 'audio.json'), () => api.readAudioIndex(), 'groups'],
    ['泡泡图库 bubble-imgs.json', path.join(dirs.imgs, 'bubble-imgs.json'), () => api.readBubbleImgIndex(), 'images'],
    ['泡泡配置 .dshw-bubble.json', dirs.bubbleCandidates[0], () => api.loadBubbleConfig(), null],
  ]
  for (const [label, file, call, key] of targets) {
    const dir = path.dirname(file)
    fs.writeFileSync(file, BAD, 'utf8')
    const before = baks(dir).length
    const result = call()
    const after = baks(dir)
    ok(after.length === before + 1, label + '：生成了 1 个备份', '实际 ' + (after.length - before))
    const bak = after.find((f) => f.startsWith(path.basename(file) + '.corrupt-'))
    ok(!!bak, label + '：备份文件名以 <原文件名>.corrupt- 开头', after.join(','))
    if (bak) {
      const content = fs.readFileSync(path.join(dir, bak), 'utf8')
      ok(content === BAD, label + '：备份内容与坏文件逐字节一致', JSON.stringify(content))
      console.log('      备份文件：' + path.join(dir, bak))
    }
    ok(!fs.existsSync(file), label + '：坏文件已改名（原路径不再存在）')
    // 返回默认结构，不抛错
    if (key === null) ok(result === null, label + '：返回 null（默认）', JSON.stringify(result))
    else ok(result && Array.isArray(result[key]), label + '：返回默认结构（' + key + ' 是数组）', JSON.stringify(result))
  }
  ok(logs.some((l) => l.includes('配置文件损坏') && l.includes('bad-json')), '控制台留下了损坏 message')
  console.log('      日志样例：' + (logs.find((l) => l.includes('bad-json')) || '(无)'))
}

// ===========================================================================
console.log('\n[2] 文件不存在（ENOENT）→ 不生成备份')
// ===========================================================================
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const api = build(dirs, logs)
  api.readRolesIndex(); api.readAudioIndex(); api.readBubbleImgIndex(); api.loadBubbleConfig()
  ok(baks(dirs.roles).length === 0, 'roles：无备份')
  ok(baks(dirs.audio).length === 0, 'audio：无备份')
  ok(baks(dirs.imgs).length === 0, 'bubble-imgs：无备份')
  ok(baks(root).length === 0, 'bubble 配置：无备份')
  ok(logs.length === 0, 'ENOENT 不产生任何日志', logs.join(' | '))
}

// ===========================================================================
console.log('\n[3] 结构不对（能解析但形状错）→ 也备份')
// ===========================================================================
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const api = build(dirs, logs)
  const cases = [
    ['roles', path.join(dirs.roles, 'roles.json'), '{"roles":"not-an-array"}', () => api.readRolesIndex()],
    ['audio', path.join(dirs.audio, 'audio.json'), '{"groups":[]}', () => api.readAudioIndex()],
    ['imgs', path.join(dirs.imgs, 'bubble-imgs.json'), '{"images":{}}', () => api.readBubbleImgIndex()],
    ['bubble', dirs.bubbleCandidates[0], '{"v":2,"items":[]}', () => api.loadBubbleConfig()],
  ]
  for (const [label, file, content, call] of cases) {
    fs.writeFileSync(file, content, 'utf8')
    call()
    const dir = path.dirname(file)
    const bak = baks(dir).find((f) => f.startsWith(path.basename(file) + '.corrupt-'))
    ok(!!bak, label + '：结构错也备份了', baks(dir).join(','))
    if (bak) ok(fs.readFileSync(path.join(dir, bak), 'utf8') === content, label + '：备份内容一致')
  }
  ok(logs.some((l) => l.includes('bad-structure')), '日志里标了 bad-structure')
}

// ===========================================================================
console.log('\n[4] 备份失败（目录只读）→ 不抛错，仍返回默认结构')
// ===========================================================================
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const api = build(dirs, logs)
  const file = path.join(dirs.roles, 'roles.json')
  fs.writeFileSync(file, BAD, 'utf8')
  // 目录改成只读：rename 会 EACCES（root 用户下不生效，故同时断言"要么备份成功要么优雅降级"）
  fs.chmodSync(dirs.roles, 0o555)
  let threw = null
  let result = null
  try { result = api.readRolesIndex() } catch (err) { threw = err }
  fs.chmodSync(dirs.roles, 0o755)
  ok(threw === null, '只读目录下不抛错', threw && threw.message)
  ok(result && Array.isArray(result.roles), '仍返回默认结构', JSON.stringify(result))
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (isRoot) {
    console.log('      （以 root 运行：chmod 不阻止 rename，本条只验证"不抛错"）')
  } else {
    ok(baks(dirs.roles).length === 0, '备份确实失败（没生成 .bak）', baks(dirs.roles).join(','))
    ok(logs.some((l) => l.includes('备份失败')), '日志里标了备份失败')
    console.log('      日志样例：' + (logs.find((l) => l.includes('备份失败')) || '(无)'))
  }
}

// ===========================================================================
console.log('\n[5] 好文件 → 原样返回，不备份')
// ===========================================================================
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const api = build(dirs, logs)
  fs.writeFileSync(path.join(dirs.roles, 'roles.json'), JSON.stringify({ version: 1, roles: [{ id: 'default', name: 'x' }, { id: 'r2', name: 'y' }] }), 'utf8')
  fs.writeFileSync(path.join(dirs.audio, 'audio.json'), JSON.stringify({ version: 1, groups: [], fragments: [] }), 'utf8')
  fs.writeFileSync(path.join(dirs.imgs, 'bubble-imgs.json'), JSON.stringify({ version: 1, images: [{ id: 'a' }] }), 'utf8')
  fs.writeFileSync(dirs.bubbleCandidates[0], JSON.stringify({ v: 1, items: [], lib: [] }), 'utf8')
  const r = api.readRolesIndex()
  ok(r.roles.length === 2, 'roles 原样返回（未插入默认角色）', JSON.stringify(r.roles.map((x) => x.id)))
  ok(api.readAudioIndex().version === 1, 'audio 原样返回')
  ok(api.readBubbleImgIndex().images.length === 1, 'bubble-imgs 原样返回')
  ok(api.loadBubbleConfig().v === 1, 'bubble 配置原样返回')
  ok(baks(dirs.roles).length + baks(dirs.audio).length + baks(dirs.imgs).length + baks(root).length === 0, '好文件不产生备份')
  ok(logs.length === 0, '好文件不产生日志')
}

// ===========================================================================
console.log('\n[6] 泡泡配置多候选：坏的第一份被备份，继续用后面能用的那份')
// ===========================================================================
{
  const root = freshRoot()
  const dirs = makeDirs(root)
  const logs = []
  const second = path.join(root, 'second', '.dshw-bubble.json')
  fs.mkdirSync(path.dirname(second), { recursive: true })
  dirs.bubbleCandidates = [path.join(root, '.dshw-bubble.json'), second]
  const api = build(dirs, logs)
  fs.writeFileSync(dirs.bubbleCandidates[0], BAD, 'utf8')
  fs.writeFileSync(second, JSON.stringify({ v: 1, items: [{ id: 'keep' }], lib: [] }), 'utf8')
  const cfg = api.loadBubbleConfig()
  ok(cfg && cfg.v === 1 && cfg.items[0].id === 'keep', '回落到第二份可用配置', JSON.stringify(cfg))
  ok(baks(root).length === 1, '第一份坏文件被备份', baks(root).join(','))
  ok(baks(path.dirname(second)).length === 0, '第二份好文件没被备份')
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
