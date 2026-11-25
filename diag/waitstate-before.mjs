// 反证：把**上游原版**（git show HEAD:lib/index.js）的 waitState / notePendingEvent 抽出来，
// 跑一遍 bug 报告里的复现，证明修复前的行为确实是"主会话挂起被子 agent 清掉"。
// 这个脚本存在的意义：证明 diag/waitstate-check.mjs 的断言不是自说自话 —— 同一套复现在旧代码上会红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findOldBaseline } from './_baseline.mjs'
import { makeExtractor } from './_extract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
// 基线必须沿 git 历史回溯找"仍含旧 waitState 声明"的那一版，不能用 HEAD ——
// 修复提交之后 HEAD 就是新版，脚本会自己挂掉（本脚本 2026-11-25 踩过）。
// 判据用**代码行**：新版注释里也提到 waitState，用裸片段会误判。
const baseline = findOldBaseline(
  repo,
  (src) => /^ {4}const waitState = \{ pending: null, sessionName: "" \}$/m.test(src),
  '仍含旧 waitState 声明的版本',
)
const SRC = baseline.src
console.log('旧版基线：' + baseline.rev.slice(0, 7))

// 按函数名抽取源码：抽取器在 diag/_extract.mjs（共用；`async function` 不会被截掉 async）。
const extractFn = makeExtractor(SRC)

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
