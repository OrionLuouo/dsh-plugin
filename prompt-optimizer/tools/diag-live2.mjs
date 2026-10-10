// 复现 selfcheck --live 的确切调用
import { buildCatalog, resolveModelRef } from '../lib/catalog.js'
import { Credentials } from '../lib/credentials.js'
import { BUILTIN_PRESETS } from '../lib/presets.js'
import { optimizeOnce } from '../lib/optimize.js'

const catalog = await buildCatalog({})
const preset = BUILTIN_PRESETS[0]
const resolved = resolveModelRef(catalog, preset.modelRef)
console.log('resolved:', resolved)
const cred = new Credentials({ home: process.env.DSH_HOME })
const { key, source } = await cred.resolve(resolved.apiKeyEnv)
console.log('key source:', source, 'len:', key?.length)

const userContent = '以下是本次会话已发生的对话记录（可能为空）：\n（本次会话尚无更早的对话）\n\n---\n\n现在需要优化的、我最新输入的提示词是：\n帮我看看那个东西\n\n请按上述要求改写它。'
console.log('instruction len:', preset.instruction.length, 'userContent len:', userContent.length)

const started = Date.now()
const res = await optimizeOnce({
  endpoint: resolved,
  apiKey: key,
  instruction: preset.instruction,
  userContent,
  original: '帮我看看那个东西',
  timeoutMs: 45000,
})
console.log('elapsed:', Date.now() - started, 'ms')
console.log('result:', res.ok ? { ok: true, changed: res.changed, len: res.optimized.length } : res)
if (res.ok) console.log('--- optimized ---\n' + res.optimized)
