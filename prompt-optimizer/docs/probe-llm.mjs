// 一次性探针：验证「已接入模型」能否被插件直接以 OpenAI 兼容方式调用。
// 不入库、不打包，只用于阶段 1 概念验证。
// 用法: node docs/probe-llm.mjs
import fs from 'node:fs'

const HOME = process.env.DSH_HOME || 'C:/Users/18136/.dsh'

function readRefs() {
  const text = fs.readFileSync(`${HOME}/.credentials.yaml`, 'utf8')
  const refs = {}
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (/^\S/.test(line)) inRefs = false
    if (!inRefs) continue
    const m = /^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line)
    if (m) refs[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return refs
}

const refs = readRefs()
const targets = [
  {
    label: 'volcengine-coding-plan / doubao-seed-2.1-pro',
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    key: refs.VOLCENGINE_CODING_PLAN_API_KEY,
    model: 'doubao-seed-2.1-pro',
  },
  {
    label: 'volcengine-agent-plan / glm-5.3',
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    key: refs.VOLCENGINE_AGENT_PLAN_API_KEY,
    model: 'glm-5.3',
  },
  {
    label: 'deepseek-official / deepseek-flash',
    baseURL: 'https://api.deepseek.com',
    key: refs.DEEPSEEK_API_KEY,
    model: 'deepseek-flash',
  },
]

for (const t of targets) {
  const started = Date.now()
  try {
    const res = await fetch(`${t.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${t.key}`,
      },
      body: JSON.stringify({
        model: t.model,
        messages: [{ role: 'user', content: '只回复两个字：可用' }],
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    const ok = res.ok
    let preview = text.slice(0, 300)
    try {
      const j = JSON.parse(text)
      preview = j?.choices?.[0]?.message?.content ?? preview
    } catch {}
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${t.label}  http=${res.status}  ${Date.now() - started}ms  -> ${String(preview).replace(/\s+/g, ' ').slice(0, 120)}`)
  } catch (err) {
    console.log(`ERR  ${t.label}  ${Date.now() - started}ms  -> ${err?.name}: ${err?.message}`)
  }
}
