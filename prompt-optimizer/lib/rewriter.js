/**
 * 改写器：在 `agent/pre-step` 处把本轮真人输入替换为优化后的提示词。
 *
 * ## 这是本插件唯一「侵入」会话数据流的地方，三条硬约束必须守住
 *
 * 1. **只处理 `step === 1`。** `agent/pre-step` 在每个 step 前都会触发，
 *    只有轮次的第一个 step 才带有从 inbox 领出的真人提示词；后续 step 只有
 *    `agent.inject()` 的上下文体。不限制 step 会导致重复处理。
 *
 * 2. **只替换真人消息，其余条目原样保留。** 宿主默认的 `next()` 会在数组末尾
 *    追加一条 context 消息（见 `dsh-agent-loop/lib/index.js:894-901`），
 *    因此**不能整体替换 `decision.messages`**，否则会丢掉那一条。
 *
 * 3. **必须原样保留 `source`（含 `rpcId` 与 `clientTimeZone`）。** 浏览器端靠
 *    `rpcId` 把本地乐观回显与持久消息对账；宿主的 prompt 幂等去重
 *    （`hasPromptRequest`）也依赖它。丢失 `rpcId` 会造成回显不退休与重复入队。
 *
 * 改写后的消息额外在 `source` 上追加 `po*` 字段作为「已优化」标记与原文存档，
 * 这是 DSH 官方支持的扩展方式（`MessageSourceMap` 是 merge-extensible 的，
 * 官方自己的 `user-rpc` 就是这样加上去的）。
 *
 * ## 关于 `createUserMessage` 的三级回退
 *
 * 插件以 `link:` 方式安装时，其实体位于 profile 之外，Node 按真实路径解析模块，
 * 因此裸导入 `@deepseek-ai/dsh-llm/types/message.js` 会 ERR_MODULE_NOT_FOUND
 * （已实测）。三级回退：裸导入 → 从 DSH 安装目录按绝对路径导入 → 本地等价实现。
 * 本地实现与官方完全一致：`{...input, role:'user', id: uuid}` 后深冻结
 * （官方为 `createMessage` → `freezeMessage` → `deepFreeze(structuredClone())`，
 * 其中 `brandString` 是恒等函数）。
 *
 * @module dsh-prompt-optimizer/lib/rewriter
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { buildContext, isHumanMessage, textOf } from './context.js'
import { optimizeOnce } from './optimize.js'
import { resolveModelRef } from './catalog.js'
import { activePreset, effectiveModelRef } from './config.js'

/** 消息来源里本插件追加的字段名（集中在此，便于排查）。 */
export const MARKER_FIELDS = Object.freeze({
  optimized: 'poOptimized',
  originalText: 'poOriginalText',
  optimizedBy: 'poOptimizedBy',
  presetId: 'poPresetId',
})

/** 可能的 DSH 安装根候选。 */
function dshInstallCandidates() {
  const out = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p)
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  push(path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh'))
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh')
  push('/usr/lib/node_modules/@deepseek-ai/dsh')
  return out
}

/**
 * 深冻结（与 `@deepseek-ai/dsh-util-values` 的 `deepFreeze` 语义一致）。
 * @param {unknown} value - 待冻结的值。
 * @returns {unknown} 同一引用。
 */
export function deepFreezeValue(value) {
  const seen = new WeakSet()
  const walk = (node) => {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return node
    if (seen.has(node)) return node
    seen.add(node)
    for (const key of Object.getOwnPropertyNames(node)) {
      try {
        walk(node[key])
      } catch {
        /* getter 抛错时跳过 */
      }
    }
    return Object.freeze(node)
  }
  return walk(value)
}

/**
 * 本地等价实现的 `createUserMessage`。
 * @param {{ content: unknown[], source: object }} input - 内容与来源。
 * @returns {object} 深冻结的用户消息。
 */
export function createUserMessageLocal(input) {
  return deepFreezeValue({ ...input, role: 'user', id: randomUUID() })
}

/** 解析结果的缓存。 */
let createUserMessageCache
/** 是否已尝试解析。 */
let createUserMessageProbed = false

/**
 * 解析 `createUserMessage`（三级回退）。
 * @returns {Promise<{ fn: (input: object) => object, via: 'bare' | 'abspath' | 'local' }>} 解析结果。
 */
export async function resolveCreateUserMessage() {
  if (createUserMessageProbed) return createUserMessageCache
  createUserMessageProbed = true

  // 一级：裸导入
  for (const spec of ['@deepseek-ai/dsh-llm/types/message.js', '@deepseek-ai/dsh-llm']) {
    try {
      const mod = await import(spec)
      if (typeof mod?.createUserMessage === 'function') {
        createUserMessageCache = { fn: mod.createUserMessage, via: 'bare' }
        return createUserMessageCache
      }
    } catch {
      // link: 安装下预期失败，继续回退
    }
  }

  // 二级：从 DSH 安装目录按绝对路径导入
  for (const root of dshInstallCandidates()) {
    const file = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'types', 'message.js')
    if (!fs.existsSync(file)) continue
    try {
      const mod = await import(pathToFileURL(file).href)
      if (typeof mod?.createUserMessage === 'function') {
        createUserMessageCache = { fn: mod.createUserMessage, via: 'abspath' }
        return createUserMessageCache
      }
    } catch {
      // 换下一个候选
    }
  }

  // 三级：本地等价实现
  createUserMessageCache = { fn: createUserMessageLocal, via: 'local' }
  return createUserMessageCache
}

/**
 * 判断本轮是否应当被优化。
 * @param {object} config - 合法配置。
 * @param {string} text - 真人输入文本。
 * @returns {{ ok: true } | { ok: false, reason: string }} 判定结果。
 */
export function shouldOptimize(config, text) {
  if (!config.enabled) return { ok: false, reason: 'disabled' }
  if (config.mode !== 'optimize') return { ok: false, reason: 'direct-mode' }
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  if (config.maxOptimizeChars > 0 && trimmed.length > config.maxOptimizeChars) {
    return { ok: false, reason: 'too-long' }
  }
  return { ok: true }
}

/**
 * 对一批消息执行改写。
 *
 * 这是纯函数式的核心：不接触 ctx，便于离线测试。
 *
 * @param {object} input - 输入。
 * @param {object[]} input.messages - `decision.messages`。
 * @param {number} input.step - 当前 step。
 * @param {object} input.config - 合法配置。
 * @param {object} input.catalog - 模型目录。
 * @param {(refName: string) => Promise<{ key: string | null, source: string }>} input.resolveKey - 凭据解析。
 * @param {import('./state.js').RuntimeState} input.state - 运行时状态（票据与记录）。
 * @param {string} [input.sessionId] - 会话 id（仅用于记录）。
 * @param {number} [input.turn] - 轮次（仅用于记录）。
 * @param {AbortSignal} [input.signal] - 取消信号。
 * @param {(url: string, init: object) => Promise<Response>} [input.fetchImpl] - 注入的 fetch（自检用）。
 * @returns {Promise<{ messages: object[], replacements: object[], notes: string[] }>} 结果。
 */
export async function rewriteMessages(input) {
  const { messages, step, config, catalog, resolveKey, state } = input
  /** @type {string[]} */
  const notes = []
  /** @type {object[]} */
  const replacements = []

  if (!Array.isArray(messages) || messages.length === 0) return { messages, replacements, notes }
  if (step !== 1) {
    notes.push('step 不是 1，跳过')
    return { messages, replacements, notes }
  }

  const modelRef = effectiveModelRef(config)
  const preset = activePreset(config)
  const resolved = resolveModelRef(catalog, modelRef)

  const { fn: createUserMessage, via } = await resolveCreateUserMessage()

  /** @type {object[]} */
  const nextMessages = []
  let changed = false
  /** 只优化**第一条**真人消息；其余（例如 steer）原样放行。 */
  let alreadyHandledOne = false
  /** 命中 cancel 降级时立即结束。 */
  let cancelled = false

  for (const message of messages) {
    if (!isHumanMessage(message) || alreadyHandledOne) {
      // 注意：这里**不能** break —— 宿主默认会在数组末尾追加一条 context 消息，
      // 提前跳出会把后续条目整段丢掉。
      nextMessages.push(message)
      continue
    }
    alreadyHandledOne = true

    const original = textOf(message).trim()
    const verdict = shouldOptimize(config, original)
    if (!verdict.ok) {
      notes.push(`跳过（${verdict.reason}）`)
      nextMessages.push(message)
      continue
    }

    if (!resolved.ok) {
      notes.push(`无法解析优化模型：${resolved.error}`)
      if (config.onFailure === 'cancel') {
        cancelled = true
        break
      }
      nextMessages.push(message)
      continue
    }

    // 预览确认路径：前端已优化过并留下票据 → 不再重复调用，只做标记
    const ticketHit = state.consumeTicket(original)
    if (ticketHit.hit) {
      notes.push('命中预览票据，跳过重复优化')
      nextMessages.push(markMessage(message, createUserMessage, {
        optimized: original,
        originalText: undefined,
        modelRef: ticketHit.modelRef || modelRef,
        presetId: preset?.id,
      }))
      changed = true
      replacements.push({ kind: 'ticket', modelRef: ticketHit.modelRef || modelRef })
      continue
    }

    // 构造上下文并发起优化
    const built = buildContext({
      messages,
      maxTurns: config.context.maxTurns,
      maxChars: config.context.maxChars,
      includeAssistant: config.context.includeAssistant,
    })

    const { key, source: keySource } = await resolveKey(resolved.apiKeyEnv)
    const started = Date.now()
    const result = await optimizeOnce({
      endpoint: resolved,
      apiKey: key,
      instruction: preset?.instruction ?? '',
      userContent: built.contextText,
      original,
      timeoutMs: config.timeoutMs,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    })

    state.pushRecent({
      sessionId: input.sessionId,
      turn: input.turn,
      ok: result.ok,
      code: result.ok ? null : result.code,
      modelRef,
      elapsedMs: result.elapsedMs,
      inputChars: original.length,
      outputChars: result.ok ? result.optimized.length : 0,
    })

    if (!result.ok) {
      notes.push(`优化失败（${result.code}）：${result.error}`)
      if (config.onFailure === 'cancel') {
        cancelled = true
        break
      }
      // send-original / notify：原样放行
      nextMessages.push(message)
      continue
    }

    if (!result.changed) {
      notes.push('优化结果与原文相同，按未变化处理')
      nextMessages.push(markMessage(message, createUserMessage, {
        optimized: original,
        originalText: original,
        modelRef,
        presetId: preset?.id,
      }))
      changed = true
      replacements.push({ kind: 'unchanged', modelRef, keySource, elapsedMs: result.elapsedMs })
      continue
    }

    nextMessages.push(
      markMessage(message, createUserMessage, {
        optimized: result.optimized,
        originalText: original,
        modelRef,
        presetId: preset?.id,
      }),
    )
    changed = true
    replacements.push({
      kind: 'optimized',
      modelRef,
      keySource,
      elapsedMs: result.elapsedMs,
      inputChars: original.length,
      outputChars: result.optimized.length,
      via,
    })
    notes.push(`已优化（${modelRef}，${result.elapsedMs}ms）`)
  }

  if (cancelled) return { messages, replacements, notes, cancelled: true }
  return { messages: changed ? nextMessages : messages, replacements, notes }
}

/**
 * 生成「已优化」标记后的消息。
 *
 * 保留原 `source` 的全部字段（**尤其 `rpcId`**），并追加 `po*` 标记字段。
 *
 * @param {object} message - 原消息。
 * @param {(input: object) => object} createUserMessage - 消息构造函数。
 * @param {object} marks - 标记内容。
 * @param {string} marks.optimized - 优化后的文本（作为新的 content）。
 * @param {string | undefined} marks.originalText - 原始文本；与优化后相同或无意义时可为 undefined。
 * @param {string} marks.modelRef - 使用的模型引用。
 * @param {string | undefined} marks.presetId - 预设 id。
 * @returns {object} 新消息。
 */
function markMessage(message, createUserMessage, marks) {
  /** 保留 message 里的非文本内容块（图片/文件等），只替换文本块。 */
  const content = Array.isArray(message.content) ? message.content : []
  const nonText = content.filter((b) => !(b && typeof b === 'object' && b.type === 'text'))
  const nextContent = [{ type: 'text', text: marks.optimized }, ...nonText]

  const source = {
    ...message.source,
    [MARKER_FIELDS.optimized]: true,
    [MARKER_FIELDS.optimizedBy]: marks.modelRef,
    ...(marks.presetId ? { [MARKER_FIELDS.presetId]: marks.presetId } : {}),
    ...(typeof marks.originalText === 'string' ? { [MARKER_FIELDS.originalText]: marks.originalText } : {}),
  }

  return createUserMessage({ content: nextContent, source })
}
