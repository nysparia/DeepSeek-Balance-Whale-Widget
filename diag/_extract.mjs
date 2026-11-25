// diag/_extract.mjs —— 从 lib/index.js 里按函数名抽取真实源码（diag/ 下多个脚本共用，0 依赖）。
//
// 为什么不用 `src.indexOf('function ' + name + '(')`：对 `async function foo(` 它会命中里面的
// `function foo(`，抽出来的副本**丢掉 async** —— 调用方拿到一个同步函数，断言看着全绿，
// 实际测的不是仓库里那份代码（assertSafeApiUrl 已经是 async，将来谁抽它就会静默踩中）。
// 这里用正则从 `async` 起切，切出来的片段自然带上 async。
export function makeExtractor(src) {
  // 从 `function NAME(`（可带 async 前缀）到配对的花括号，返回整段源码（含 async）。
  return function extractFn(name) {
    const m = src.match(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('))
    if (!m) throw new Error('function not found: ' + name)
    const at = m.index
    const open = src.indexOf('{', at)
    if (open < 0) throw new Error('no body brace for ' + name)
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
}
