// 离线验证 dsh-po-probe 的纯函数逻辑（YAML 极简解析 / createUserMessage 等价实现）
// 只读本机 settings.yaml 与 .credentials.yaml，不启动 DSH。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SETTINGS_FILE = path.join(DSH_HOME, 'settings.yaml')
const CREDENTIALS_FILE = path.join(DSH_HOME, '.credentials.yaml')

// ---- 与 dsh-po-probe/lib/index.js 中同名函数保持逐字一致 ----
function unquote(v) {
  let s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1)
  return s
}

function readCredentialRefs() {
  const out = {}
  let text
  try { text = fs.readFileSync(CREDENTIALS_FILE, 'utf8') } catch (err) { return { ok: false, error: `read failed: ${err && err.message}`, refs: out } }
  let inRefs = false
  let refsIndent = -1
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    const indent = raw.match(/^\s*/)[0].length
    const trimmed = raw.trim()
    if (!inRefs) {
      if (/^refs\s*:/.test(trimmed)) { inRefs = true; refsIndent = indent }
      continue
    }
    if (indent <= refsIndent) break
    const m = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/)
    if (m) out[m[1]] = unquote(m[2])
  }
  return { ok: true, refs: out }
}

function readProviderSettings() {
  const providers = {}
  let text
  try { text = fs.readFileSync(SETTINGS_FILE, 'utf8') } catch (err) { return { ok: false, error: `read failed: ${err && err.message}`, providers } }
  const lines = text.split(/\r?\n/)
  let i = lines.findIndex((l) => /^\s*llm-pi-ai\s*:/.test(l))
  if (i === -1) return { ok: true, providers, note: 'no llm-pi-ai section' }
  let j = -1
  for (let k = i + 1; k < lines.length; k += 1) {
    if (/^\S/.test(lines[k]) && lines[k].trim() !== '') break
    if (/^\s*providers\s*:/.test(lines[k])) { j = k; break }
  }
  if (j === -1) return { ok: true, providers, note: 'no providers key' }
  const region = []
  for (let k = j + 1; k < lines.length; k += 1) {
    if (/^\S/.test(lines[k]) && lines[k].trim() !== '') break
    region.push(lines[k])
  }
  const joined = region.join('\n')
  const nameRe = /(^|\n)\s*([A-Za-z0-9_.\-]+)\s*:\s*\n?\s*\{/g
  let m
  while ((m = nameRe.exec(joined)) !== null) {
    const providerName = m[2]
    let depth = 0
    let start = joined.indexOf('{', m.index)
    let end = -1
    for (let p = start; p < joined.length; p += 1) {
      const ch = joined[p]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) { end = p; break }
      }
    }
    const block = end === -1 ? joined.slice(start) : joined.slice(start, end + 1)
    const entry = {}
    const url = block.match(/baseURL\s*:\s*([^,}\n]+)/)
    if (url) entry.baseURL = unquote(url[1])
    const env = block.match(/apiKeyEnv\s*:\s*([^,}\n]+)/)
    if (env) entry.apiKeyEnv = unquote(env[1])
    providers[providerName] = entry
    nameRe.lastIndex = end === -1 ? joined.length : end
  }
  return { ok: true, providers }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
function localCreateUserMessage(input) {
  return deepFreeze({ ...structuredClone(input), role: 'user', id: randomUUID() })
}

const creds = readCredentialRefs()
const settings = readProviderSettings()
console.log('credentials ok=', creds.ok, 'refNames=', Object.keys(creds.refs))
console.log('settings ok=', settings.ok, 'providers=', JSON.stringify(settings.providers, null, 2))
console.log('apiKey present for DEEPSEEK_API_KEY =', Boolean(creds.refs.DEEPSEEK_API_KEY))
console.log('apiKey present for VOLCENGINE_CODING_PLAN_API_KEY =', Boolean(creds.refs.VOLCENGINE_CODING_PLAN_API_KEY))

const msg = localCreateUserMessage({
  content: [{ type: 'text', text: 'PO-SELFTEST' }],
  source: { kind: 'user', rpcId: 'po-selftest-1', originalText: '原始文本', optimizedBy: 'x/y' },
})
console.log('localMessage =', JSON.stringify(msg))
console.log('frozen =', Object.isFrozen(msg), 'sourceFrozen =', Object.isFrozen(msg.source))

// JSON 往返（模拟落盘 → 读回）验证自定义字段保真
const roundTrip = JSON.parse(JSON.stringify(msg.source))
console.log('roundTripSource =', JSON.stringify(roundTrip))
console.log('roundTripPreservesCustomFields =', roundTrip.originalText === '原始文本' && roundTrip.optimizedBy === 'x/y' && roundTrip.rpcId === 'po-selftest-1')
