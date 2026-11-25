// 结构断言：只要信任栅栏走 `conn.admit()`，inject 列表就必须含 `connection.authentication`。
//
// 为什么这条会单独成一个回归脚本：cordis 的服务代理把方法调用里的 `this` 绑到**调用方 ctx 的
// shadow** 上，而宿主 `connection.admit()` 内部要读 `this.authentication`。调用方没 inject 这个
// 服务，`admit()` 就抛 "cannot get property 'connection.authentication' without inject"，本插件的
// catch 按 fail-closed 回 403 —— 于是 26 条路由（含 /dsh-whale/widget.js）全部 403，挂件从页面上
// 消失，而宿主侧一切正常（路由在、账本在写）。实测过一次：去掉 inject → widget.js 403；加回来 → 200。
//
// 这条不测行为（行为要靠真宿主），只钉住"两个事实必须同时成立"这个结构前提。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')) }
}

function injectList(src) {
  const m = src.match(/root\.inject\(\[([^\]]*)\],\s*\(ctx\)/)
  return m ? m[1] : null
}
function usesAdmit(src) { return /conn\.admit\s*\(/.test(src) }
function hasAuthInject(src) {
  const list = injectList(src)
  return list !== null && list.indexOf("'connection.authentication'") >= 0
}

console.log('\n[1] 当前源码：走 admit 就必须 inject connection.authentication')
ok(usesAdmit(SRC), 'rejected() 确实调用 conn.admit()（否则这条前提不适用）')
ok(hasAuthInject(SRC), 'inject 列表含 connection.authentication', 'inject=' + injectList(SRC))

console.log('\n[2] 负向对照：把 inject 里的 connection.authentication 删掉，判据必须变红')
{
  const mutated = SRC.replace("'connection', 'connection.authentication'", "'connection'")
  ok(mutated !== SRC, '变异确实改到了 inject 列表')
  ok(!hasAuthInject(mutated), '删掉后判据为假（说明这条断言不是恒真）')
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + `：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1
