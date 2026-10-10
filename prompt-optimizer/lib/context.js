/**
 * 优化上下文：把会话消息整理成「每轮用户输入 + 助手输出」的对话记录。
 *
 * 关键规则：
 * - **只采集真人输入**：判据是 `message.source.kind === 'user' && 'rpcId' in message.source`。
 *   这同时排除了 `agent.inject()` 的系统上下文注入（那类 source 是 `{kind:'plugin'}`）、
 *   工具结果（`{kind:'tool'}`）与助手消息（`{kind:'model'}`）。
 * - **已优化轮次用优化后的文本**：优化后的文本就是消息当下的 `content`，
 *   原始文本额外存放在 `source.poOriginalText`。因此本模块天然满足
 *   「上下文里拼接优化后的提示词」这一要求，无需特殊处理。
 * - 上限截断：先按 `maxTurns` 取最近 N 轮，再按 `maxChars` 从**最旧**开始丢弃。
 *
 * @module dsh-prompt-optimizer/lib/context
 */

/** 上下文分隔线。 */
const SEPARATOR = '---'

/**
 * 判断是不是「真人提示词」消息。
 * @param {unknown} message - 一条消息。
 * @returns {boolean} 是否为真人输入。
 */
export function isHumanMessage(message) {
  if (!message || typeof message !== 'object') return false
  const source = message.source
  if (!source || typeof source !== 'object') return false
  if (source.kind !== 'user') return false
  return Object.prototype.hasOwnProperty.call(source, 'rpcId')
}

/**
 * 抽取消息里的纯文本（只取 text 块，忽略图片/文件/工具等其它块）。
 * @param {unknown} message - 一条消息。
 * @returns {string} 文本；没有文本块时返回空串。
 */
export function textOf(message) {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 把消息数组切成轮次。
 *
 * 一轮的定义：一条真人消息开启一轮，其后直到下一条真人消息之前的所有助手文本都属于该轮。
 *
 * @param {unknown} messages - 消息数组（通常是 `agent.session.deriveMessages()` 的结果或
 *   `agent/pre-step` 的 `decision.messages`）。
 * @returns {{ turns: { user: string, assistant: string }[], lastHumanIndex: number }} 轮次与最后一条真人消息的下标。
 */
export function splitTurns(messages) {
  /** @type {{ user: string, assistant: string }[]} */
  const turns = []
  if (!Array.isArray(messages)) return { turns, lastHumanIndex: -1 }

  let lastHumanIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (isHumanMessage(m)) {
      turns.push({ user: textOf(m), assistant: '' })
      lastHumanIndex = i
      continue
    }
    if (turns.length === 0) continue // 首条真人消息之前的系统/注入内容不计入
    // 助手文本累积到当前轮
    if (m && typeof m === 'object' && m.role === 'assistant') {
      const text = textOf(m)
      if (text.length > 0) {
        const turn = turns[turns.length - 1]
        turn.assistant = turn.assistant.length > 0 ? `${turn.assistant}\n${text}` : text
      }
    }
  }
  return { turns, lastHumanIndex }
}

/**
 * 按字符上限从最旧开始裁剪轮次。
 * @param {{ user: string, assistant: string }[]} turns - 轮次数组（会就地裁剪副本）。
 * @param {number} maxChars - 字符上限；<= 0 表示不限制。
 * @returns {{ user: string, assistant: string }[]} 裁剪后的轮次。
 */
export function trimByChars(turns, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return turns.slice()
  const out = []
  let total = 0
  // 从最新往回收集，直到超限
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    const size = t.user.length + t.assistant.length + 16
    if (out.length > 0 && total + size > maxChars) break
    total += size
    out.unshift(t)
  }
  return out
}

/**
 * 构造发给优化模型的上下文段落。
 *
 * @param {object} input - 输入。
 * @param {unknown} input.messages - 消息数组。
 * @param {number} [input.maxTurns] - 最多回溯轮数（不含本次待优化输入）。
 * @param {number} [input.maxChars] - 上下文总字符上限。
 * @param {boolean} [input.includeAssistant] - 是否包含助手输出。
 * @returns {{ contextText: string, target: string, usedTurns: number, totalTurns: number }} 结果。
 */
export function buildContext(input) {
  const { turns, lastHumanIndex } = splitTurns(input.messages)
  const totalTurns = turns.length

  // 最后一条真人消息就是本次待优化的目标，不进上下文
  const history = turns.slice(0, Math.max(0, turns.length - 1))
  const target = lastHumanIndex >= 0 ? turns[turns.length - 1].user : ''

  const maxTurns = Number.isFinite(input.maxTurns) ? Math.max(0, Math.trunc(input.maxTurns)) : 10
  let selected = maxTurns > 0 ? history.slice(Math.max(0, history.length - maxTurns)) : []
  const maxChars = Number.isFinite(input.maxChars) ? input.maxChars : 6000
  selected = trimByChars(selected, maxChars)

  const includeAssistant = input.includeAssistant !== false
  const lines = []
  if (selected.length === 0) {
    lines.push('以下是本次会话已发生的对话记录（可能为空）：')
    lines.push('（本次会话尚无更早的对话）')
  } else {
    lines.push('以下是本次会话已发生的对话记录（可能为空）：')
    const offset = history.length - selected.length
    selected.forEach((turn, i) => {
      const round = offset + i + 1
      lines.push(`[第 ${round} 轮]`)
      lines.push(`用户：${turn.user}`)
      if (includeAssistant) lines.push(`助手：${turn.assistant.length > 0 ? turn.assistant : '（本轮无文本输出）'}`)
    })
  }
  lines.push('')
  lines.push(SEPARATOR)
  lines.push('')
  lines.push('现在需要优化的、我最新输入的提示词是：')
  lines.push(target)
  lines.push('')
  lines.push('请按上述要求改写它。')

  return {
    contextText: lines.join('\n'),
    target,
    usedTurns: selected.length,
    totalTurns: Math.max(0, totalTurns - 1),
  }
}
