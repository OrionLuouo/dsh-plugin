/**
 * 运行时状态：`DSH_HOME/prompt-optimizer.state.json`。
 *
 * 与配置分离存放，原因是：这些是**易变的短生命周期数据**，
 * 不该混进用户可见/可编辑的配置里。
 *
 * 隐私约束（硬性）：`recent` 只记录**长度与元数据**，
 * **绝不写入提示词正文**；`tickets` 只存文本哈希，不存文本。
 *
 * 用途：
 * - `tickets`：预览确认路径的一次性票据。前端先调 `/optimize.json` 拿到优化结果与票据，
 *   把结果写回输入框并发送；宿主侧 `agent/pre-step` 命中票据时**不再重复优化**，只做标记。
 * - `recent`：最近若干次优化记录，供 UI 显示与排障。
 *
 * @module dsh-prompt-optimizer/lib/state
 */
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { statePath, atomicWriteJson } from './config.js'

/** 票据存活时间（毫秒）。 */
export const TICKET_TTL_MS = 5 * 60 * 1000
/** `recent` 最多保留条数。 */
export const RECENT_LIMIT = 50

/**
 * 文本哈希（票据键）。只输出前 32 个十六进制字符，足够避免碰撞且不泄露原文。
 * @param {string} text - 文本。
 * @returns {string} 哈希。
 */
export function textHash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 32)
}

/**
 * 运行时状态持有者。
 *
 * 采用「读-改-写整文件」的简单模型：状态很小（几十条记录），
 * 且访问频率低（每次发送提示词一次），不值得引入更复杂的同步机制。
 */
export class RuntimeState {
  /**
   * @param {object} [options] - 选项。
   * @param {string} [options.home] - 覆盖 DSH home。
   * @param {number} [options.now] - 时间源（自检时可注入）。
   */
  constructor(options = {}) {
    this.home = options.home
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    /** 票据表：hash → { ticket, ts, modelRef } */
    this.tickets = Object.create(null)
    /** 最近记录（不含正文） */
    this.recent = []
    this.load()
  }

  /** 状态文件路径。 */
  get file() {
    return statePath(this.home)
  }

  /** 从磁盘读取（失败则用空状态）。 */
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && typeof raw === 'object') {
        if (raw.tickets && typeof raw.tickets === 'object') this.tickets = { ...raw.tickets }
        if (Array.isArray(raw.recent)) this.recent = raw.recent.slice(0, RECENT_LIMIT)
      }
    } catch {
      this.tickets = Object.create(null)
      this.recent = []
    }
    this.pruneTickets()
  }

  /** 落盘（失败静默：状态不是关键路径，不该因为写盘失败影响发送）。 */
  save() {
    try {
      atomicWriteJson(this.file, {
        version: 1,
        tickets: this.tickets,
        recent: this.recent.slice(0, RECENT_LIMIT),
      })
      return true
    } catch {
      return false
    }
  }

  /** 清理过期票据。 */
  pruneTickets() {
    const cutoff = this.now() - TICKET_TTL_MS
    for (const [hash, entry] of Object.entries(this.tickets)) {
      const ts = Number(entry?.ts)
      if (!Number.isFinite(ts) || ts < cutoff) delete this.tickets[hash]
    }
  }

  /**
   * 为一段「优化后的文本」签发票据。
   * @param {string} optimizedText - 优化后的提示词。
   * @param {string} modelRef - 使用的模型引用。
   * @returns {string} 票据字符串。
   */
  issueTicket(optimizedText, modelRef) {
    const hash = textHash(optimizedText)
    const ticket = randomUUID()
    this.tickets[hash] = { ticket, ts: this.now(), modelRef: modelRef ?? '' }
    this.pruneTickets()
    this.save()
    return ticket
  }

  /**
   * 检查并消费票据：文本命中未过期票据时返回 true 并删除该票据。
   * @param {string} text - 即将发送的提示词文本。
   * @param {string} [ticket] - 前端回传的票据（可选；给出时必须匹配）。
   * @returns {{ hit: boolean, modelRef?: string }} 命中结果。
   */
  consumeTicket(text, ticket) {
    const hash = textHash(text)
    const entry = this.tickets[hash]
    if (!entry) return { hit: false }
    if (typeof ticket === 'string' && ticket.length > 0 && entry.ticket !== ticket) return { hit: false }
    const ts = Number(entry.ts)
    if (!Number.isFinite(ts) || ts < this.now() - TICKET_TTL_MS) {
      delete this.tickets[hash]
      this.save()
      return { hit: false }
    }
    delete this.tickets[hash]
    this.save()
    return { hit: true, modelRef: entry.modelRef }
  }

  /**
   * 记录一次优化结果。**只记长度，不记正文。**
   * @param {object} record - 记录。
   * @param {string} record.sessionId - 会话 id（可为空）。
   * @param {number} record.turn - 轮次（未知时 0）。
   * @param {boolean} record.ok - 是否成功。
   * @param {string} [record.code] - 失败码。
   * @param {string} [record.modelRef] - 使用的模型。
   * @param {number} [record.elapsedMs] - 耗时。
   * @param {number} [record.inputChars] - 输入长度。
   * @param {number} [record.outputChars] - 输出长度。
   * @returns {object} 实际写入的记录。
   */
  pushRecent(record) {
    const entry = {
      ts: this.now(),
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
      turn: Number.isFinite(Number(record.turn)) ? Number(record.turn) : 0,
      ok: record.ok === true,
      code: typeof record.code === 'string' ? record.code : null,
      modelRef: typeof record.modelRef === 'string' ? record.modelRef : '',
      elapsedMs: Number.isFinite(Number(record.elapsedMs)) ? Number(record.elapsedMs) : 0,
      inputChars: Number.isFinite(Number(record.inputChars)) ? Number(record.inputChars) : 0,
      outputChars: Number.isFinite(Number(record.outputChars)) ? Number(record.outputChars) : 0,
    }
    this.recent.unshift(entry)
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT
    this.save()
    return entry
  }

  /** 当前未过期票据数量（排障用）。 */
  pendingTicketCount() {
    this.pruneTickets()
    return Object.keys(this.tickets).length
  }
}
