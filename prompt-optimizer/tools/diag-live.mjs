// 一次性诊断：确认优化模型链路到底卡在哪。
// 用法: node tools/diag-live.mjs
import fs from 'node:fs'
import { buildCatalog, resolveModelRef } from '../lib/catalog.js'
import { Credentials } from '../lib/credentials.js'
import { BUILTIN_PRESETS } from '../lib/presets.js'

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
const catalog = await buildCatalog({})
console.log('目录 provider:', catalog.groups.map((g) => `${g.provider}(${g.models.length})`).join(', '))
console.log('默认模型:', catalog.defaultModelRef)

const cases = []
for (const p of BUILTIN_PRESETS) cases.push({ label: `预设 ${p.id}`, modelRef: p.modelRef })
cases.push({ label: '默认模型', modelRef: catalog.defaultModelRef })

for (const c of cases) {
  const resolved = resolveModelRef(catalog, c.modelRef)
  if (!resolved.ok) { console.log(`SKIP ${c.label} (${c.modelRef}): ${resolved.error}`); continue }
  const key = refs[resolved.apiKeyEnv]
  if (!key) { console.log(`SKIP ${c.label}: 缺少 ${resolved.apiKeyEnv}`); continue }
  const url = `${resolved.baseURL.replace(/\/+$/, '')}/chat/completions`
  const started = Date.now()
  let status = 0
  let preview = ''
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: resolved.model,
        messages: [{ role: 'user', content: '只回复两个字：可用' }],
        max_tokens: 2048,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    })
    status = res.status
    const text = await res.text()
    try {
      const j = JSON.parse(text)
      const ch = j?.choices?.[0]
      const content = ch?.message?.content
      const reasoning = ch?.message?.reasoning_content
      preview = `content=${JSON.stringify(typeof content === 'string' ? content.slice(0, 40) : content)} finish=${ch?.finish_reason} reasoningLen=${typeof reasoning === 'string' ? reasoning.length : 0} usage=${JSON.stringify(j?.usage)}`
    } catch {
      preview = text.slice(0, 200).replace(/\s+/g, ' ')
    }
  } catch (err) {
    preview = `${err?.name}: ${err?.message}`
  }
  console.log(`${c.label.padEnd(18)} ${resolved.provider}/${resolved.model}  http=${status}  ${Date.now() - started}ms  ${preview}`)
}
