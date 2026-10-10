// 验证：可见内容为空是否由推理 token 吃光 max_tokens 导致；以及能否关闭思考。
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
const instruction = '你是提示词工程专家。请把用户最新输入改写得更清晰具体，只输出改写结果，不要解释。'
const userContent = '现在需要优化的、我最新输入的提示词是：\n帮我看看那个东西\n\n请按上述要求改写它。'

async function call(modelRef, extra, maxTokens, timeout) {
  const r = resolveModelRef(catalog, modelRef)
  const key = refs[r.apiKeyEnv]
  const started = Date.now()
  try {
    const res = await fetch(`${r.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: r.model,
        messages: [{ role: 'system', content: instruction }, { role: 'user', content: userContent }],
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: false,
        ...extra,
      }),
      signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text()
    try {
      const j = JSON.parse(text)
      const ch = j?.choices?.[0]
      const c = ch?.message?.content
      return `http=${res.status} ${Date.now() - started}ms contentLen=${typeof c === 'string' ? c.length : -1} finish=${ch?.finish_reason} completion=${j?.usage?.completion_tokens} reasoning=${j?.usage?.completion_tokens_details?.reasoning_tokens}${res.status !== 200 ? ' body=' + text.slice(0, 120) : ''}`
    } catch {
      return `http=${res.status} ${Date.now() - started}ms raw=${text.slice(0, 120)}`
    }
  } catch (err) {
    return `FAIL ${Date.now() - started}ms ${err?.name}`
  }
}

const matrix = [
  ['volcengine-coding-plan/doubao-seed-2.1-pro', {}, 2048, 60000, 'doubao 2048'],
  ['volcengine-coding-plan/doubao-seed-2.1-pro', {}, 16384, 90000, 'doubao 16384'],
  ['volcengine-coding-plan/doubao-seed-2.1-pro', { thinking: { type: 'disabled' } }, 8192, 90000, 'doubao thinking:disabled'],
  ['volcengine-coding-plan/doubao-seed-2.1-pro', { enable_thinking: false }, 8192, 90000, 'doubao enable_thinking:false'],
  ['volcengine-agent-plan/glm-5.3', {}, 16384, 90000, 'glm 16384'],
  ['volcengine-agent-plan/glm-5.3', { thinking: { type: 'disabled' } }, 8192, 90000, 'glm thinking:disabled'],
  ['deepseek-official/deepseek-flash', {}, 16384, 90000, 'ds-flash 16384'],
  ['deepseek-official/deepseek-flash', { reasoning_effort: 'none' }, 8192, 90000, 'ds-flash effort:none'],
]

for (const [modelRef, extra, mt, to, label] of matrix) {
  console.log(`${label.padEnd(28)} ${await call(modelRef, extra, mt, to)}`)
}
