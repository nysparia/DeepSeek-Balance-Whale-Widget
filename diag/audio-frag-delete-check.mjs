// 单元验证：删音频片段这条链上的四处断点（缓存 / 草稿 / 保存校验 / 客户端 frag: 引用）。
//
// 做法与 diag/ 下其它脚本一致：从 lib/index.js 与 assets/whale-widget.js **按源码位置抽取真实代码**，
// 拼进带桩的作用域里跑，断言的是仓库里那份代码本身（不是复述一遍逻辑的副本）。
//
// 覆盖：
//   ① 组 press=X, release=X → 删 X → 后端两个槽都置空、affectedGroups 两条
//   ② 前端草稿两个槽都被清空（不是只清"被删的那个槽"）
//   ③ 保存带失效 id 的组 → 400，不落 duck
//   ④ 保存空串 → 合法（静音）
//   ⑤ frag:<已删 id> 在 fillSoundSelect 里被置空，而不是改写/留幽灵项
//   ⑥ 资源窗口 meta 用片段名、空槽显示"留空"
//   ⑦ 删片段后按 URL 精确清掉该片段的解码缓存（不误伤同前缀的别的片段）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, '..')
const HOST = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
const FRONT = fs.readFileSync(path.join(REPO, 'assets', 'whale-widget.js'), 'utf8')

let failures = 0
function ok(name, cond, detail) {
  if (cond) { console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { failures++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

// —— 按函数名抽取源码（从 `function NAME(` 到配对的花括号）——
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(')
  if (at < 0) throw new Error('function not found: ' + name)
  return sliceBraced(src, at, name)
}
// —— 按 `if (action === 'xxx') {` 抽取一个分支块（含 if 与配对花括号）——
function extractBranch(src, marker) {
  const at = src.indexOf(marker)
  if (at < 0) throw new Error('branch not found: ' + marker)
  return sliceBraced(src, at, marker)
}
// 从 start 起，到 start 之后第一个配对闭合的花括号为止
function sliceBraced(src, start, label) {
  const open = src.indexOf('{', start)
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
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces in ' + label)
}

// ===========================================================================
// 后端：delete-fragment / save-group 两个分支（真跑，桩掉 res / 索引读写）
// ===========================================================================
const SAVE_GROUP = extractBranch(HOST, "if (action === 'save-group') {")
const DEL_FRAG = extractBranch(HOST, "if (action === 'delete-fragment') {")

function buildBackend() {
  const factory = new Function('state', 'parsed', 'res', 'index', `
    const PRESET_GROUPS = state.PRESET_GROUPS
    const PRESET_FRAGMENTS = state.PRESET_FRAGMENTS
    const JSON_HEADERS = state.JSON_HEADERS
    const audioFragmentsPayload = state.audioFragmentsPayload
    const audioGroupsPayload = state.audioGroupsPayload
    const writeAudioIndex = state.writeAudioIndex
    const audioFragmentPath = state.audioFragmentPath
    const fs = state.fs
    const action = parsed.action
    ${SAVE_GROUP}
    ${DEL_FRAG}
    return { status: 0, body: { ok: false, error: 'no branch matched' } }
  `)
  return factory
}
const makeBackend = buildBackend()

function makeRes() {
  const out = { status: 0, body: null }
  return {
    out,
    writeHead(code) { out.status = code },
    end(s) { try { out.body = JSON.parse(s) } catch (e) { out.body = s } },
  }
}
// 一个最小可用的 audio.json 索引 + 桩
function makeState(index, fragments) {
  const writes = []
  return {
    index,
    writes,
    PRESET_GROUPS: { duck: { press: 'ya1', release: 'ya2' }, fx1: { press: 'd1', release: 'd2' } },
    PRESET_FRAGMENTS: { ya1: 1, ya2: 1, d1: 1, d2: 1 },
    JSON_HEADERS: { 'Content-Type': 'application/json' },
    audioFragmentsPayload: () => fragments.map((f) => ({ id: f.id, name: f.name, preset: !!f.preset })),
    audioGroupsPayload: () => index.groups.map((g) => Object.assign({}, g)),
    writeAudioIndex: () => { writes.push(JSON.parse(JSON.stringify(index))) },
    audioFragmentPath: (id) => '/tmp/dshwv-test/' + id + '.wav',
    fs: { unlinkSync: () => {} },
  }
}
function call(state, parsed) {
  const res = makeRes()
  const ret = makeBackend(state, parsed, res, state.index)
  return { status: res.out.status, body: res.out.body, ret }
}

// ===========================================================================
// 1. 组 press=X, release=X → 删 X → 两个槽都置空、affectedGroups 两条
// ===========================================================================
console.log('\n=== 1. 两槽同片段：删片段后后端把两个槽都置空 ===')
{
  const index = {
    fragments: [{ id: 'audio_x', name: 'X' }, { id: 'audio_keep', name: 'KEEP' }],
    groups: [
      { id: 'group_1', name: '我的组', press: 'audio_x', release: 'audio_x' },
      { id: 'group_2', name: '别的组', press: 'audio_keep', release: 'audio_x' },
      { id: 'group_3', name: '无关组', press: 'audio_keep', release: 'audio_keep' },
    ],
  }
  const state = makeState(index, index.fragments)
  const r = call(state, { action: 'delete-fragment', id: 'audio_x' })
  ok('HTTP 200', r.status === 200, 'status=' + r.status)
  ok('响应 ok:true', !!(r.body && r.body.ok === true))
  const g1 = index.groups.find((g) => g.id === 'group_1')
  ok('group_1 的 press 被置空', g1.press === '', JSON.stringify(g1.press))
  ok('group_1 的 release 也被置空（不是只清一个槽）', g1.release === '', JSON.stringify(g1.release))
  const g2 = index.groups.find((g) => g.id === 'group_2')
  ok('group_2 只清引用它的那个槽', g2.press === 'audio_keep' && g2.release === '', JSON.stringify([g2.press, g2.release]))
  const g3 = index.groups.find((g) => g.id === 'group_3')
  ok('无关组一个槽都不动', g3.press === 'audio_keep' && g3.release === 'audio_keep')
  const aff = (r.body && r.body.affectedGroups) || []
  ok('affectedGroups 共 3 条（group_1 两条 + group_2 一条）', aff.length === 3, 'len=' + aff.length)
  const g1slots = aff.filter((a) => a.id === 'group_1').map((a) => a.slot).sort()
  ok('group_1 的两条分别是 press / release', JSON.stringify(g1slots) === '["press","release"]', JSON.stringify(g1slots))
  ok('affectedGroups 带组名（前端提示要用）', aff.every((a) => typeof a.name === 'string' && a.name.length > 0))
  ok('片段已从索引里删掉', !index.fragments.some((f) => f.id === 'audio_x'))
  ok('响应里的 groups 也反映了置空', (r.body.groups || []).find((g) => g.id === 'group_1').press === '')
  ok('索引被写回一次', state.writes.length === 1, 'writes=' + state.writes.length)
}

// ===========================================================================
// 2. 前端草稿：两个槽都按 id 检查
// ===========================================================================
console.log('\n=== 2. 前端草稿：删片段后两个槽都被清空 ===')
{
  const fn = extractFn(FRONT, 'audioEditDropFragmentDraft')
  const factory = new Function('btnP', 'btnR', 'audioSlotBtnText', `
    var audioEditPressVal = ''
    var audioEditReleaseVal = ''
    var audioEditPressBtn = btnP
    var audioEditReleaseBtn = btnR
    ${fn}
    return {
      drop: audioEditDropFragmentDraft,
      get: function () { return { press: audioEditPressVal, release: audioEditReleaseVal } },
      set: function (p, r) { audioEditPressVal = p; audioEditReleaseVal = r },
    }
  `)
  const h = factory({}, {}, function () {})

  h.set('audio_x', 'audio_x')
  h.drop('audio_x')
  const both = h.get()
  ok('press=X, release=X → 删 X → 两个槽都变空串', both.press === '' && both.release === '',
    JSON.stringify(both))

  h.set('audio_x', 'audio_y')
  h.drop('audio_x')
  const one = h.get()
  ok('只清引用被删片段的那个槽（另一个槽不动）', one.press === '' && one.release === 'audio_y',
    JSON.stringify(one))

  h.set('audio_x', 'audio_x')
  h.drop('audio_other')
  const none = h.get()
  ok('删的是别的片段 → 草稿不动', none.press === 'audio_x' && none.release === 'audio_x',
    JSON.stringify(none))

  h.set('audio_x', 'audio_x')
  h.drop('')
  ok('空 id → 草稿不动', h.get().press === 'audio_x' && h.get().release === 'audio_x')

  // 结构断言：两条删除回调都必须重建音频元素 + 清缓存（否则缓存仍让挂件放被删的片段）
  const inSlot = extractFn(FRONT, 'audioDeleteFragmentInSlot')
  ok('audioDeleteFragmentInSlot 调用了草稿清理', inSlot.includes('audioEditDropFragmentDraft(id)'))
  ok('audioDeleteFragmentInSlot 清了解码缓存', inSlot.includes('dshwvAudioCacheDropFragment(id)'))
  ok('audioDeleteFragmentInSlot 调用了 applySoundSet()', inSlot.includes('applySoundSet()'))
  const inRes = extractFn(FRONT, 'resDelAudioFrag')
  ok('resDelAudioFrag 清了解码缓存', inRes.includes('dshwvAudioCacheDropFragment(id)'))
  ok('resDelAudioFrag 调用了 applySoundSet()', inRes.includes('applySoundSet()'))
  ok('applySoundSet 在 audioGroups 赋值之后调用（组数据已更新）',
    inRes.indexOf('audioGroups = d.groups') < inRes.indexOf('applySoundSet()'))
}

// ===========================================================================
// 3. 保存带失效 id 的组 → 400，不落 duck
// ===========================================================================
console.log('\n=== 3. save-group：失效片段 id → 400，不静默强转 duck ===')
{
  const index = {
    fragments: [{ id: 'audio_keep', name: 'KEEP' }],
    groups: [{ id: 'group_1', name: '我的组', press: 'audio_keep', release: 'audio_keep' }],
  }
  const state = makeState(index, index.fragments)
  const r = call(state, { action: 'save-group', id: 'group_1', name: '我的组', press: 'audio_gone', release: 'audio_keep' })
  ok('HTTP 400', r.status === 400, 'status=' + r.status)
  ok('响应 ok:false', !!(r.body && r.body.ok === false))
  ok('错误里点名了失效的片段 id', typeof r.body.error === 'string' && r.body.error.includes('audio_gone'),
    JSON.stringify(r.body.error))
  ok('错误文案提示重新选择', typeof r.body.error === 'string' && r.body.error.includes('请重新选择'))
  const g = index.groups.find((x) => x.id === 'group_1')
  ok('组没有被改成 duck 预设', g.press === 'audio_keep' && g.release === 'audio_keep',
    JSON.stringify([g.press, g.release]))
  ok('索引没有被写回（拒绝保存不落盘）', state.writes.length === 0, 'writes=' + state.writes.length)

  // release 槽失效同样要拦
  const r2 = call(state, { action: 'save-group', id: 'group_1', name: '我的组', press: 'audio_keep', release: 'audio_gone' })
  ok('release 槽失效也返回 400', r2.status === 400, 'status=' + r2.status)
  ok('release 槽失效时错误里点名的是 release 的 id',
    typeof r2.body.error === 'string' && r2.body.error.includes('audio_gone'))

  // 新建组带失效 id 也要拦（不能靠"组不存在"绕过校验）
  const r3 = call(state, { action: 'save-group', id: '', name: '新组', press: 'audio_gone', release: '' })
  ok('新建组带失效 id 也返回 400', r3.status === 400, 'status=' + r3.status)
  ok('新建组被拒后没有新增组', index.groups.length === 1, 'groups=' + index.groups.length)
}

// ===========================================================================
// 4. 保存空串 → 合法（静音）
// ===========================================================================
console.log('\n=== 4. save-group：空串（留空=静音）合法 ===')
{
  const index = {
    fragments: [{ id: 'audio_keep', name: 'KEEP' }],
    groups: [{ id: 'group_1', name: '我的组', press: 'audio_keep', release: 'audio_keep' }],
  }
  const state = makeState(index, index.fragments)
  const r = call(state, { action: 'save-group', id: 'group_1', name: '我的组', press: '', release: '' })
  ok('HTTP 200', r.status === 200, 'status=' + r.status)
  const g = index.groups.find((x) => x.id === 'group_1')
  ok('两个槽都存成空串（不是 duck 预设）', g.press === '' && g.release === '', JSON.stringify([g.press, g.release]))
  ok('索引被写回一次', state.writes.length === 1, 'writes=' + state.writes.length)

  // 一空一有：空的那个保持空，有的那个原样
  const r2 = call(state, { action: 'save-group', id: 'group_1', name: '我的组', press: '', release: 'audio_keep' })
  ok('一空一有也能保存', r2.status === 200, 'status=' + r2.status)
  ok('空槽保持空、非空槽原样', g.press === '' && g.release === 'audio_keep', JSON.stringify([g.press, g.release]))

  // 合法 id 原样保存（不被改写）
  const r3 = call(state, { action: 'save-group', id: 'group_1', name: '我的组', press: 'audio_keep', release: 'audio_keep' })
  ok('合法 id 原样保存', r3.status === 200 && g.press === 'audio_keep' && g.release === 'audio_keep')
}

// ===========================================================================
// 5. fillSoundSelect：frag:<已删 id> 置空，不改写、不留幽灵项
// ===========================================================================
console.log('\n=== 5. fillSoundSelect：frag:<已删 id> → 置空（静音） ===')
{
  const fillFn = extractFn(FRONT, 'fillSoundSelect')
  function buildFill(env) {
    const factory = new Function('env', `
      var taskEndSel = env.taskEndSel
      var audioGroups = env.audioGroups
      var audioFragments = env.audioFragments
      var audioFragmentsLoaded = env.loaded
      var usageSet = env.usageSet
      var taskEndDrop = env.taskEndDrop
      var notices = []
      function soundOpt(v, lab) { return { value: v, textContent: lab } }
      function audioGroupName(id) { return id }
      function audioFragStaleNotice(id, where) { notices.push({ id: id, where: where }) }
      ${fillFn}
      return { fill: fillSoundSelect, notices: notices, usage: function () { return usageSet } }
    `)
    return factory(env)
  }
  // 最小 <select> 桩：options / value / selectedIndex / innerHTML='' / appendChild / remove
  function fakeSelect() {
    const opts = []
    const el = {
      options: opts,
      selectedIndex: -1,
      appendChild(o) { opts.push(o); return o },
      remove(i) { opts.splice(i, 1) },
    }
    Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => { opts.length = 0 } })
    Object.defineProperty(el, 'value', {
      get() { return el.selectedIndex >= 0 && opts[el.selectedIndex] ? opts[el.selectedIndex].value : '' },
      set(v) { el.selectedIndex = opts.findIndex((o) => o.value === String(v)) },
    })
    return el
  }
  const FRAGS = [{ id: 'audio_a', name: 'A' }, { id: 'audio_b', name: 'B' }]

  // 5a 任务结束音：frag:<已删> → 置空 + 提示，不改写成第一个 frag 候选
  {
    const sel = fakeSelect()
    const h = buildFill({
      taskEndSel: sel, audioGroups: [], audioFragments: FRAGS, loaded: true,
      usageSet: { taskEnd: { on: true, sel: 'frag:audio_gone' } }, taskEndDrop: null,
    })
    const ret = h.fill(sel, 'frag:audio_gone', '任务结束音')
    ok('返回 false（没找到现值）', ret === false, 'ret=' + ret)
    ok('下拉被置空（静音）', sel.value === '', JSON.stringify(sel.value))
    ok('没有把选择改写成别的 frag 候选',
      !sel.options.some((o) => o.value === 'frag:audio_a' && o.value === sel.value))
    ok('没有留下 frag:<已删 id> 的选项', !sel.options.some((o) => o.value === 'frag:audio_gone'))
    ok('没有「（暂未加载）」幽灵项', !sel.options.some((o) => String(o.textContent).includes('暂未加载')))
    ok('持久化值没有被改写成默认音', h.usage().taskEnd.sel === 'frag:audio_gone',
      JSON.stringify(h.usage().taskEnd.sel))
    ok('提示通道收到 1 条（片段 id + 位置）',
      h.notices.length === 1 && h.notices[0].id === 'audio_gone' && h.notices[0].where === '任务结束音',
      JSON.stringify(h.notices))
  }

  // 5b 片段全删光（列表已就绪但为空）也要识别成"已删"，而不是当成"还没加载"
  {
    const sel = fakeSelect()
    const h = buildFill({
      taskEndSel: sel, audioGroups: [], audioFragments: [], loaded: true,
      usageSet: { taskEnd: { on: true, sel: 'frag:audio_gone' } }, taskEndDrop: null,
    })
    h.fill(sel, 'frag:audio_gone', '任务结束音')
    ok('片段列表为空但已就绪 → 仍然置空', sel.value === '', JSON.stringify(sel.value))
    ok('片段列表为空但已就绪 → 仍然提示', h.notices.length === 1, JSON.stringify(h.notices))
  }

  // 5c 面板下拉（提问/授权）：不再追加幽灵项
  {
    const sel = fakeSelect()
    const h = buildFill({
      taskEndSel: fakeSelect(), audioGroups: [], audioFragments: FRAGS, loaded: true,
      usageSet: {}, taskEndDrop: null,
    })
    h.fill(sel, 'frag:audio_gone', '提问提示音效')
    ok('面板下拉被置空', sel.value === '', JSON.stringify(sel.value))
    ok('面板下拉没有幽灵项', !sel.options.some((o) => String(o.textContent).includes('暂未加载')))
    ok('面板下拉的提示带位置名',
      h.notices.length === 1 && h.notices[0].where === '提问提示音效', JSON.stringify(h.notices))
  }

  // 5d 列表还没到（启动时）：一律不动，保留原值显示（不能把用户的选择清掉）
  {
    const sel = fakeSelect()
    const h = buildFill({
      taskEndSel: fakeSelect(), audioGroups: [], audioFragments: [], loaded: false,
      usageSet: {}, taskEndDrop: null,
    })
    h.fill(sel, 'frag:audio_a', '提问提示音效')
    ok('列表未就绪 → 保留原值显示', sel.value === 'frag:audio_a', JSON.stringify(sel.value))
    ok('列表未就绪 → 不提示（不是"已删"）', h.notices.length === 0, JSON.stringify(h.notices))
  }

  // 5e 片段还在：正常选中，不提示
  {
    const sel = fakeSelect()
    const h = buildFill({
      taskEndSel: sel, audioGroups: [], audioFragments: FRAGS, loaded: true,
      usageSet: { taskEnd: { on: true, sel: 'frag:audio_a' } }, taskEndDrop: null,
    })
    h.fill(sel, 'frag:audio_a', '任务结束音')
    ok('片段还在 → 正常选中', sel.value === 'frag:audio_a', JSON.stringify(sel.value))
    ok('片段还在 → 不提示', h.notices.length === 0)
  }

  // 5f 回归：空 sel 仍然走 v762 的兜底（挑默认音并写回 usageSet），没被这次改动带偏
  {
    const sel = fakeSelect()
    const h = buildFill({
      taskEndSel: sel, audioGroups: [], audioFragments: FRAGS, loaded: true,
      usageSet: { taskEnd: { on: true, sel: '' } }, taskEndDrop: null,
    })
    h.fill(sel, '', '任务结束音')
    // 既有规则：兜底取**最后一个** frag 候选（除非某个候选显示名正好是 entity）
    ok('空 sel 仍兜底成 frag 候选（v762 行为未被带偏）', sel.value === 'frag:audio_b', JSON.stringify(sel.value))
    ok('空 sel 的兜底仍写回 usageSet', h.usage().taskEnd.sel === 'frag:audio_b',
      JSON.stringify(h.usage().taskEnd.sel))
  }
}

// ===========================================================================
// 6. 资源窗口 meta：用片段名、空槽显示"留空"
// ===========================================================================
console.log('\n=== 6. 资源窗口 meta：片段名 + 空槽"留空" ===')
{
  const factory = new Function('frags', `
    var audioFragments = frags
    ${extractFn(FRONT, 'audioSlotName')}
    ${extractFn(FRONT, 'audioGroupSlotMeta')}
    return audioGroupSlotMeta
  `)
  const meta = factory([{ id: 'audio_a', name: 'A' }, { id: 'audio_b', name: 'B' }])
  ok('两槽都有 → 显示片段名（不是原始 id）',
    meta({ press: 'audio_a', release: 'audio_b' }) === '按压:A 松开:B',
    JSON.stringify(meta({ press: 'audio_a', release: 'audio_b' })))
  ok('两槽都留空 → 仍然显示，且两个槽都写"留空"',
    meta({ press: '', release: '' }) === '按压:留空 松开:留空',
    JSON.stringify(meta({ press: '', release: '' })))
  ok('一空一有 → 空的那个写"留空"',
    meta({ press: 'audio_a', release: '' }) === '按压:A 松开:留空',
    JSON.stringify(meta({ press: 'audio_a', release: '' })))
  ok('预设组不显示摘要', meta({ press: 'ya1', release: 'ya2', preset: true }) === '')
  ok('空对象不抛错', meta(null) === '' && meta({}) === '按压:留空 松开:留空')
  ok('未知 id 回落成 id 本身（不显示 undefined）',
    meta({ press: 'audio_zzz', release: '' }) === '按压:audio_zzz 松开:留空',
    JSON.stringify(meta({ press: 'audio_zzz', release: '' })))
  // 结构断言：资源窗口真的用了这个函数，而不是又拼回原始 id
  const resRender = extractFn(FRONT, 'resRenderData')
  ok('resRenderData 用 audioGroupSlotMeta 生成摘要', resRender.includes('audioGroupSlotMeta(g)'))
  ok('resRenderData 不再直接拼 g.press / g.release', !resRender.includes("'按压:' + g.press"))
}

// ===========================================================================
// 7. 解码缓存：按完整 URL 精确清掉该片段（不误伤同前缀的别的片段）
// ===========================================================================
console.log('\n=== 7. 删片段后清解码缓存（URL 精确匹配）===')
{
  const fn = extractFn(FRONT, 'dshwvAudioCacheDropFragment')
  const factory = new Function(`
    var dshwvAudioDecoded = {}
    var dshwvAudioBuffers = {}
    ${fn}
    return { drop: dshwvAudioCacheDropFragment, decoded: dshwvAudioDecoded, buffers: dshwvAudioBuffers }
  `)
  const h = factory()
  const url = (id) => '/dsh-whale/audio-fragment?id=' + encodeURIComponent(id)
  const seed = () => {
    for (const k of Object.keys(h.decoded)) delete h.decoded[k]
    for (const k of Object.keys(h.buffers)) delete h.buffers[k]
    h.decoded[url('audio_a')] = 'buf-a'
    h.decoded[url('audio_ab')] = 'buf-ab'          // 同前缀的另一个片段
    h.decoded['/dsh-whale/sound/press.mp3?set=duck'] = 'buf-legacy'
    h.buffers[url('audio_a')] = 'promise-a'
    h.buffers[url('audio_ab')] = 'promise-ab'
  }
  seed()
  h.drop('audio_a')
  ok('decoded 里该片段的条目被删掉', !(url('audio_a') in h.decoded))
  ok('buffers 里该片段的条目被删掉', !(url('audio_a') in h.buffers))
  ok('同前缀的 audio_ab 不受影响（不是裸前缀匹配）',
    h.decoded[url('audio_ab')] === 'buf-ab' && h.buffers[url('audio_ab')] === 'promise-ab')
  ok('老的声音组路由缓存不受影响', h.decoded['/dsh-whale/sound/press.mp3?set=duck'] === 'buf-legacy')

  // 需要转义的 id（空格/中文）也要能命中
  seed()
  h.decoded[url('audio a 中文')] = 'buf-enc'
  h.drop('audio a 中文')
  ok('含空格/中文的 id 按 encodeURIComponent 后的 URL 命中', !(url('audio a 中文') in h.decoded))

  // 空 id 不清任何东西
  seed()
  h.drop('')
  ok('空 id → 一条都不清', Object.keys(h.decoded).length === 3 && Object.keys(h.buffers).length === 2,
    'decoded=' + Object.keys(h.decoded).length + ' buffers=' + Object.keys(h.buffers).length)
}

// ===========================================================================
// 8. 删除提示：客户端 frag: 引用被置空的位置也要报出来（否则只报音效组槽位）
// ===========================================================================
console.log('\n=== 8. 删除提示：音效组槽位 + 客户端引用位置 ===')
{
  const factory = new Function('env', `
    var usageSet = env.usageSet
    var toasts = []
    function dshwvToast(msg, kind, ms) { toasts.push({ msg: msg, kind: kind, ms: ms }) }
    function soundEventCfg(kind) { return { sel: (env.events && env.events[kind]) || '' } }
    ${extractFn(FRONT, 'audioFragNoticeEsc')}
    ${extractFn(FRONT, 'audioFragClientRefs')}
    ${extractFn(FRONT, 'audioFragDeleteNotice')}
    return { notice: audioFragDeleteNotice, refs: audioFragClientRefs, toasts: toasts }
  `)
  const h = factory({
    usageSet: { taskEnd: { on: true, sel: 'frag:audio_x' } },
    events: { question: 'frag:audio_x', approval: 'frag:audio_y' },
  })

  ok('找出引用该片段的位置（任务结束音 + 提问，不含授权）',
    JSON.stringify(h.refs('audio_x')) === '["任务结束音","提问提示音效"]', JSON.stringify(h.refs('audio_x')))
  ok('没有位置引用时返回空数组', h.refs('audio_zzz').length === 0)
  ok('空 id 返回空数组', h.refs('').length === 0)

  h.notice('X', [], [])
  ok('既没有组槽位也没有客户端引用 → 不弹提示', h.toasts.length === 0, JSON.stringify(h.toasts))

  h.notice('X', [], ['任务结束音'])
  ok('只有客户端引用时也要提示（原来会整条吞掉）', h.toasts.length === 1, JSON.stringify(h.toasts))
  ok('提示里点名了位置', h.toasts[0].msg.includes('任务结束音') && h.toasts[0].msg.includes('已改为留空'),
    JSON.stringify(h.toasts[0].msg))

  h.toasts.length = 0
  h.notice('X', [{ name: '组A', slot: 'press' }, { name: '组A', slot: 'release' }], ['提问提示音效'])
  const msg = h.toasts[0].msg
  ok('组槽位与客户端引用同一条提示里都报出来',
    msg.includes('2 个音效组槽位') && msg.includes('组A（按下）') && msg.includes('组A（松开）') && msg.includes('提问提示音效'),
    JSON.stringify(msg))

  h.toasts.length = 0
  h.notice('<b>坏名字</b>', [{ name: '<i>组</i>', slot: 'press' }], [])
  ok('组名/片段名进 toast 前被转义',
    !h.toasts[0].msg.includes('<b>') && !h.toasts[0].msg.includes('<i>') && h.toasts[0].msg.includes('&lt;b&gt;'),
    JSON.stringify(h.toasts[0].msg))
}

console.log('')
if (failures) { console.log(`结果：${failures} 项失败`); process.exitCode = 1 }
else console.log('结果：全部通过')
