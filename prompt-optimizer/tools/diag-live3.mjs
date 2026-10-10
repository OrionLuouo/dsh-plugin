// 定位超时原因：分别改变 system 长度 / max_tokens / 超时
import fs from 'node:fs'
import { buildCatalog, resolveModelRef } from '../lib/catalog.js'
import { BUILTIN_PRESETS } from '../lib/presets.js'

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
const userContent = '以下是本次会话已发生的对话记录（可能为空）：\n（本次会话尚无更早的对话）\n\n---\n\n现在需要优化的、我最新输入的提示词是：\n帮我看看那个东西\n\n请按上述要求改写它。'

const experiments = [
  { label: 'A 无 system + max_tokens 2048', model: 'volcengine-coding-plan/doubao-seed-2.1-pro', instruction: null, maxTokens: 2048, timeout: 60000 },
  { label: 'B 长 system + max_tokens 2048', model: 'volcengine-coding-plan/doubao-seed-2.1-pro', instruction: BUILTIN_PRESETS[0].instruction, maxTokens: 2048, timeout: 60000 },
  { label: 'C 长 system + max_tokens 8192', model: 'volcengine-coding-plan/doubao-seed-2.1-pro', instruction: BUILTIN_PRESETS[0].instruction, maxTokens: 8192, timeout: 90000 },
  { label: 'D 短 system + max_tokens 8192', model: 'volcengine-coding-plan/doubao-seed-2.1-pro', instruction: '请改写用户输入，只输出改写结果。', maxTokens: 8192, timeout: 90000 },
  { label: 'E glm-5.3 短 system', model: 'volcengine-agent-plan/glm-5.3', instruction: '请改写用户输入，只输出改写结果。', maxTokens: 8192, timeout: 90000 },
  { label: 'F deepseek-flash 短 system', model: 'deepseek-official/deepseek-flash', instruction: '请改写用户输入，只输出改写结果。', maxTokens: 8192, timeout: 90000 },
]

for (const e of experiments) {
  const r = resolveModelRef(catalog, e.model)
  if (!r.ok) { console.log(`SKIP ${e.label}: ${r.error}`); continue }
  const key = refs[r.apiKeyEnv]
  const messages = []
  if (e.instruction) messages.push({ role: 'system', content: e.instruction })
  messages.push({ role: 'user', content: userContent })
  const started = Date.now()
  try {
    const res = await fetch(`${r.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: r.model, messages, max_tokens: e.maxTokens, temperature: 0.3, stream: false }),
      signal: AbortSignal.timeout(e.timeout),
    })
    const text = await res.text()
    let info = ''
    try {
      const j = JSON.parse(text)
      const ch = j?.choices?.[0]
      info = `contentLen=${typeof ch?.message?.content === 'string' ? ch.message.content.length : -1} finish=${ch?.finish_reason} completion=${j?.usage?.completion_tokens} reasoning=${j?.usage?.completion_tokens_details?.reasoning_tokens}`
    } catch { info = text.slice(0, 160) }
    console.log(`${e.label.padEnd(34)} http=${res.status} ${Date.now() - started}ms  ${info}`)
  } catch (err) {
    console.log(`${e.label.padEnd(34)} FAIL ${Date.now() - started}ms  ${err?.name}: ${String(err?.message).slice(0, 100)}`)
  }
}
