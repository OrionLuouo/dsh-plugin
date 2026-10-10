// 一次性调查：找出 composer 里「权限」控件由哪个包渲染，并看它周围的 DOM 结构。
import fs from 'node:fs'
import path from 'node:path'

const root = 'C:/Users/18136/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const needle = '\u6743\u9650' // 权限
const packages = fs.readdirSync(root).filter((p) => p.startsWith('dsh-client'))

console.log('=== 哪些客户端包含「权限」字样 ===')
for (const pkg of packages) {
  const file = path.join(root, pkg, 'lib', 'client.js')
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(needle)) {
    const idx = text.indexOf(needle)
    console.log(`--- ${pkg}`)
    console.log('    ' + text.slice(Math.max(0, idx - 200), idx + 120).replace(/\s+/g, ' '))
  }
}

// 再看 composer 工具行的官方渲染顺序
console.log('\n=== conversation.input.* 官方渲染顺序 ===')
const conv = path.join(root, 'dsh-client-ui-conversation', 'lib', 'client.js')
if (fs.existsSync(conv)) {
  const text = fs.readFileSync(conv, 'utf8')
  const matches = [...text.matchAll(/renderSlot\("conversation\.input\.[a-z]+"/g)]
  for (const m of matches) {
    console.log('  ' + text.slice(Math.max(0, m.index - 160), m.index + 90).replace(/\s+/g, ' '))
    console.log('')
  }
}
