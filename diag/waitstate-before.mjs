// 反证：把**上游原版**（git show HEAD:lib/index.js）的 waitState / notePendingEvent 抽出来，
// 跑一遍 bug 报告里的复现，证明修复前的行为确实是"主会话挂起被子 agent 清掉"。
// 这个脚本存在的意义：证明 diag/waitstate-check.mjs 的断言不是自说自话 —— 同一套复现在旧代码上会红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const SRC = execFileSync('git', ['show', 'HEAD:lib/index.js'], { cwd: repo, encoding: 'utf8' })

function braceBlock(at) {
  const open = SRC.indexOf('{', at)
  let depth = 0
  let inStr = null
  let inLine = false
  let inBlock = false
  for (let i = open; i < SRC.length; i++) {
    const c = SRC[i]
    const n = SRC[i + 1]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++ } continue }
    if (inStr) { if (c === '\\') { i++; continue } if (c === inStr) inStr = null; continue }
    if (c === '/' && n === '/') { inLine = true; i++; continue }
    if (c === '/' && n === '*') { inBlock = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(open, i + 1) }
  }
  throw new Error('unbalanced')
}
function extractFn(name) {
  const at = SRC.indexOf('function ' + name + '(')
  if (at < 0) throw new Error('not found: ' + name)
  return SRC.slice(at, SRC.indexOf('{', at) + braceBlock(at).length)
}

const DECL_STATE = SRC.match(/^ {4}const waitState = .*$/m)[0]
const DECL_TOOL = SRC.match(/^ {4}const WAIT_QUESTION_TOOL = .*$/m)[0]
const body = ['titleFromService', 'pickSessionName', 'eventCallId', 'notePendingEvent'].map(extractFn).join('\n\n')

const factory = new Function('ctx', `
${DECL_STATE}
${DECL_TOOL}
${body}
return { notePendingEvent, getState: () => waitState }
`)
const w = factory({ get: () => null })

const sess = (id, name) => ({ id, name })
// 复现（与 bug 报告逐字一致）
w.notePendingEvent('main', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q1' } }, sess('main', '主会话'))
const afterAsk = JSON.parse(JSON.stringify(w.getState()))
console.log('主会话提问后 waitState =', JSON.stringify(afterAsk))

w.notePendingEvent('sub', { type: 'turn/start', data: {} }, sess('sub', '子agent'))
const afterSub = JSON.parse(JSON.stringify(w.getState()))
console.log('子 agent turn/start 后 waitState =', JSON.stringify(afterSub))

const bugReproduced = afterAsk.pending !== null && afterSub.pending === null && afterSub.sessionName === '子agent'
console.log('\n修复前行为：' + (bugReproduced
  ? 'BUG 复现 —— 主会话的 pending 被子 agent 的 turn/start 清掉，sessionName 也被改成子 agent 的'
  : '未复现（上游可能已改过这段）'))
process.exit(bugReproduced ? 0 : 1)
