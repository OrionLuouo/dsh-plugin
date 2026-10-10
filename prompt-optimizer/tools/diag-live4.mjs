// 找出工作说明长度的安全边界：coding-plan 端点对长 system 明显变慢。
import fs from 'node:fs'
import { buildCatalog, resolveModelRef } from '../lib/catalog.js'

const HOME = process.env.DSH_HOME || 'C:/Users/18136/.dsh'
const refs = {}
{
  const text = fs.readFileSync(`${HOME}/.credentials.yaml`, 'utf8')
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (/^\S/.test(line)) inRefs = false
    if (!inRefs) continue
    const m = /^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line)
    if (m) refs[m[1]] = m[2]
  }
}
const catalog = await buildCatalog({})
const userContent = '现在需要优化的、我最新输入的提示词是：\n帮我看看那个东西\n\n请按上述要求改写它。'

const base = [
  '你是提示词工程专家。请把用户的最新输入改写为一条更高质量的提示词。',
  '要求：',
  '1. 保留用户的全部原始意图与约束，不新增用户未提出的需求。',
  '2. 明确任务类型与期望的输出形态。',
  '3. 把含糊的表述具体化。',
  '4. 语言与用户输入保持一致。',
  '5. 只输出改写后的提示词本身，不要解释或 Markdown 代码块。',
]

const variants = [
  { label: '0 行（无 system）', lines: 0 },
  { label: '1 行', lines: 1 },
  { label: '前 3 行', lines: 3 },
  { label: '前 5 行', lines: 5 },
  { label: '全部 7 行', lines: 7 },
]

const targets = [
  'volcengine-coding-plan/doubao-seed-2.1-pro',
  'volcengine-agent-plan/glm-5.3',
  'deepseek-official/deepseek-flash',
]

for (const modelRef of targets) {
  const r = resolveModelRef(catalog, modelRef)
  if (!r.ok) { console.log(`SKIP ${modelRef}: ${r.error}`); continue }
  const key = refs[r.apiKeyEnv]
  console.log(`\n--- ${modelRef} ---`)
  for (const v of variants) {
    const instruction = v.lines === 0 ? null : base.slice(0, v.lines).join('\n')
    const messages = []
    if (instruction) messages.push({ role: 'system', content: instruction })
    messages.push({ role: 'user', content: userContent })
    const len = instruction ? instruction.length : 0
    const started = Date.now()
    try {
      const res = await fetch(`${r.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: r.model, messages, max_tokens: 2048, temperature: 0.3, stream: false }),
        signal: AbortSignal.timeout(50000),
      })
      const text = await res.text()
      let info = ''
      try {
        const j = JSON.parse(text)
        const ch = j?.choices?.[0]
        info = `len=${typeof ch?.message?.content === 'string' ? ch.message.content.length : -1} finish=${ch?.finish_reason}`
      } catch { info = text.slice(0, 120) }
      console.log(`  ${v.label.padEnd(16)} system字符=${String(len).padStart(3)}  http=${res.status}  ${Date.now() - started}ms  ${info}`)
    } catch (err) {
      console.log(`  ${v.label.padEnd(16)} system字符=${String(len).padStart(3)}  FAIL ${Date.now() - started}ms  ${err?.name}`)
    }
  }
}
