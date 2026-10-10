/**
 * 校验 assets/ui.js 的界面文案是否全部为 ASCII 转义。
 *
 * 为什么需要这个检查：脚本由插件路由原样吐给浏览器，若源码里含真实中文，
 * 一旦服务器以错误编码返回就会乱码。本检查确保**所有面向用户的字符串**
 * 都是 `\uXXXX` 转义（注释里的中文是安全的，因为注释不会到达浏览器）。
 *
 * 用法: node tools/check-ui-encoding.mjs
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const text = fs.readFileSync(path.join(root, 'assets', 'ui.js'), 'utf8')

/** 从 `var T = { ... }` 块里逐个字段提取字面量（逐行，避免跨行误匹配）。 */
function extractTLiterals(source) {
  const start = source.indexOf('var T = {')
  if (start < 0) return []
  const end = source.indexOf('\n  }', start)
  const block = source.slice(start, end < 0 ? undefined : end)
  const out = []
  for (const line of block.split('\n')) {
    const m = /^\s*([A-Za-z][A-Za-z0-9]*):\s*'((?:[^'\\]|\\.)*)'/.exec(line)
    if (m) out.push({ key: m[1], raw: m[2] })
  }
  return out
}

const literals = extractTLiterals(text)
const withRealNonAscii = literals.filter((l) => /[^\x00-\x7F]/.test(l.raw))

console.log(`界面文案条目数: ${literals.length}`)
console.log(`含真实非 ASCII 字符的条目数: ${withRealNonAscii.length} ${withRealNonAscii.length === 0 ? '(符合设计)' : '(不符合！)'}`)
if (withRealNonAscii.length > 0) {
  for (const l of withRealNonAscii) console.log(`  - ${l.key}: ${l.raw}`)
}

// 抽样解码，确认转义有效
const samples = ['trigger', 'modeOptimize', 'optimizing', 'settingsTitle', 'optimizeAndSend']
console.log('\n抽样解码:')
for (const key of samples) {
  const found = literals.find((l) => l.key === key)
  if (!found) {
    console.log(`  ${key}: 未找到`)
    continue
  }
  let decoded
  try {
    decoded = JSON.parse(`"${found.raw.replace(/"/g, '\\"')}"`)
  } catch (err) {
    decoded = `<解码失败: ${err.message}>`
  }
  console.log(`  ${key}: ${decoded}`)
}

// 检查是否有 6 位 \uXXXX 之外的异常转义
const badEscapes = literals.filter((l) => /\\u(?![0-9a-fA-F]{4})/.test(l.raw))
console.log(`\n非法 \\u 转义条目数: ${badEscapes.length} ${badEscapes.length === 0 ? '(符合设计)' : '(不符合！)'}`)

const ok = withRealNonAscii.length === 0 && badEscapes.length === 0
console.log(`\n===== 编码检查：${ok ? '通过' : '未通过'} =====`)
process.exit(ok ? 0 : 1)
