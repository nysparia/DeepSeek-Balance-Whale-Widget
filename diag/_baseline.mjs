// diag/_baseline.mjs —— 从 git 历史里找"修复前"的 lib/index.js 基线（diag/ 下三个脚本共用，0 依赖）。
//
// 为什么不用钉死的 commit sha：钉 sha 并不能摆脱 clone 深度 —— 浅克隆里那个对象根本不存在
// （实测 depth-1 clone：`git cat-file -t <sha>` → "Not a valid object name"），照样得 fetch-depth: 0；
// 而 sha 一旦被 rebase / squash 掉就永久失效。沿历史回溯 + 判据（predicate）更稳：
// 只要历史里还有"修复前的那一版"就能找到，判据是代码形状而不是提交号。
// 代价是必须拿到完整历史 —— 所以 ci.yml / publish.yml 的 checkout 都是 fetch-depth: 0；
// 浅克隆时这里给出可操作的报错，而不是含糊的"找不到基线"。
import { execFileSync } from 'node:child_process'

export function findOldBaseline(repo, predicate, what) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  let revs
  try {
    revs = git(['rev-list', 'HEAD', '--', 'lib/index.js']).trim().split('\n').filter(Boolean)
  } catch (err) {
    throw new Error('读不到 lib/index.js 的 git 历史：' + String((err && err.message) || err)
      + '（本脚本需要完整历史：浅克隆请先 git fetch --unshallow）')
  }
  for (const rev of revs) {
    const src = git(['show', rev + ':lib/index.js'])
    if (predicate(src)) return { rev, src }
  }
  let shallow = 'unknown'
  try { shallow = git(['rev-parse', '--is-shallow-repository']).trim() } catch (err) { void err }
  throw new Error('找不到修复前的 lib/index.js 基线（' + what + '）'
    + (shallow === 'true'
      ? ' —— 当前是浅克隆（历史被截断）：请 git fetch --unshallow；CI 里是 actions/checkout 的 fetch-depth: 0'
      : ' —— 历史里没有满足判据的版本（判据见调用处注释）'))
}
