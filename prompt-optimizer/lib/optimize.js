/**
 * 优化执行器：调用「已接入模型」把提示词改写为更高质量的形式。
 *
 * 为什么直接用 fetch 而不是 `ctx.llm.stream()`：
 * `@deepseek-ai/dsh-llm` 是**类型 + 少量运行时模块**的包（`createUserMessage` 在
 * `lib/types/message.js` 里是真实函数），但其 `LlmRuntime` 服务在插件里通过
 * `ctx.llm` 取用需要 `inject: ['llm']`。本插件要尽量减少对宿主服务的依赖
 * （这样在 `llm` 服务未就绪时也能给出可读错误），因此直接走 provider 的
 * OpenAI 兼容端点 —— 这与官方适配器发给线上的请求形态一致
 * （参见 `dsh-llm-deepseek/lib/index.js:1770` 的 `${baseURL}/chat/completions`）。
 *
 * 隐私：本模块不记录请求体与密钥；出错信息只包含 HTTP 状态码与**截断后**的
 * provider 错误文案（不含密钥）。
 *
 * @module dsh-prompt-optimizer/lib/optimize
 */

/** 失败码枚举。 */
export const FAILURE_CODES = Object.freeze([
  'DISABLED',
  'NO_KEY',
  'NO_ENDPOINT',
  'TIMEOUT',
  'ABORTED',
  'HTTP_4XX',
  'HTTP_5XX',
  'BAD_RESPONSE',
  'TOO_LONG',
])

/** 发给优化模型的最大输出 token。 */
const MAX_TOKENS = 2048

/**
 * 去掉模型可能加上的 Markdown 代码块围栏与首尾空白。
 * @param {string} text - 原始输出。
 * @returns {string} 清洗后的文本。
 */
export function stripFences(text) {
  let s = typeof text === 'string' ? text : ''
  s = s.trim()
  if (s.startsWith('```')) {
    // 去掉首行围栏（可能带语言标注）
    const firstBreak = s.indexOf('\n')
    if (firstBreak !== -1) {
      s = s.slice(firstBreak + 1)
      const end = s.lastIndexOf('```')
      if (end !== -1) s = s.slice(0, end)
      s = s.trim()
    }
  }
  // 去掉整体包裹的成对引号（模型偶发行为）
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('「') && s.endsWith('」')))) {
    const inner = s.slice(1, -1)
    if (inner.trim().length > 0) s = inner.trim()
  }
  return s
}

/**
 * 组装发给优化模型的消息。
 * @param {string} instruction - 预设的工作说明（system）。
 * @param {string} userContent - 上下文 + 待优化输入（user）。
 * @returns {object[]} messages 数组。
 */
export function buildMessages(instruction, userContent) {
  /** @type {object[]} */
  const messages = []
  const sys = typeof instruction === 'string' ? instruction.trim() : ''
  if (sys.length > 0) messages.push({ role: 'system', content: sys })
  messages.push({ role: 'user', content: String(userContent ?? '') })
  return messages
}

/**
 * 从 OpenAI 兼容响应里取出文本。
 * @param {unknown} json - 解析后的响应体。
 * @returns {string | null} 文本；结构不符时返回 null。
 */
export function textFromResponse(json) {
  const choice = json?.choices?.[0]
  if (!choice || typeof choice !== 'object') return null
  const content = choice.message?.content
  if (typeof content === 'string') return content
  // 少数网关返回数组形式的内容块
  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    if (parts.length > 0) return parts.join('')
  }
  return null
}

/**
 * 调用优化模型。
 *
 * @param {object} input - 输入。
 * @param {string} input.baseURL - provider 端点。
 * @param {string} input.model - 模型 id。
 * @param {string} input.apiKey - 密钥（不会被记录或回传）。
 * @param {object[]} input.messages - 消息数组。
 * @param {number} [input.timeoutMs] - 超时毫秒。
 * @param {AbortSignal} [input.signal] - 外部取消信号。
 * @param {number} [input.temperature] - 采样温度。
 * @param {(url: string, init: object) => Promise<Response>} [input.fetchImpl] - 注入的 fetch（自检用）。
 * @returns {Promise<{ ok: true, text: string, raw: string } | { ok: false, code: string, error: string }>} 结果。
 */
export async function callOptimizer(input) {
  const base = typeof input.baseURL === 'string' ? input.baseURL.replace(/\/+$/u, '') : ''
  if (base.length === 0) return { ok: false, code: 'NO_ENDPOINT', error: '优化模型的 provider 没有可用的 baseURL' }
  if (typeof input.apiKey !== 'string' || input.apiKey.length === 0) {
    return { ok: false, code: 'NO_KEY', error: '未找到该 provider 的 API 密钥，请先在 DSH 设置里配置' }
  }

  const url = `${base}/chat/completions`
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(3000, Math.trunc(input.timeoutMs)) : 45000

  // 组合外部信号与超时信号
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onExternalAbort = () => controller.abort()
  if (input.signal) {
    if (input.signal.aborted) {
      clearTimeout(timer)
      return { ok: false, code: 'ABORTED', error: '本轮操作已被取消' }
    }
    input.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  const fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : fetch

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        max_tokens: MAX_TOKENS,
        temperature: Number.isFinite(input.temperature) ? input.temperature : 0.3,
        stream: false,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      let detail = ''
      try {
        const bodyText = await res.text()
        try {
          const parsed = JSON.parse(bodyText)
          detail = parsed?.error?.message ?? parsed?.message ?? bodyText
        } catch {
          detail = bodyText
        }
      } catch {
        detail = ''
      }
      const trimmed = String(detail).replace(/\s+/g, ' ').slice(0, 240)
      const code = res.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX'
      return {
        ok: false,
        code,
        error: `优化模型返回 HTTP ${res.status}${trimmed.length > 0 ? `：${trimmed}` : ''}`,
      }
    }

    const bodyText = await res.text()
    let parsed
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return { ok: false, code: 'BAD_RESPONSE', error: '优化模型返回的不是合法 JSON' }
    }
    const text = textFromResponse(parsed)
    if (text === null) {
      return { ok: false, code: 'BAD_RESPONSE', error: '优化模型响应里没有可用的文本内容' }
    }
    return { ok: true, text, raw: text }
  } catch (err) {
    if (timedOut) return { ok: false, code: 'TIMEOUT', error: `优化调用超时（${timeoutMs} 毫秒）` }
    if (input.signal?.aborted) return { ok: false, code: 'ABORTED', error: '本轮操作已被取消' }
    const name = err?.name ?? ''
    if (name === 'AbortError') return { ok: false, code: 'TIMEOUT', error: `优化调用超时（${timeoutMs} 毫秒）` }
    return { ok: false, code: 'HTTP_5XX', error: `优化调用失败：${String(err?.message ?? err).slice(0, 240)}` }
  } finally {
    clearTimeout(timer)
    if (input.signal) input.signal.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * 完整的一次优化：组装消息 → 调用 → 清洗 → 判定是否发生变化。
 *
 * @param {object} input - 输入。
 * @param {object} input.endpoint - {@link resolveModelRef} 的成功结果。
 * @param {string} input.apiKey - 密钥。
 * @param {string} input.instruction - 工作说明。
 * @param {string} input.userContent - 上下文 + 待优化输入。
 * @param {string} input.original - 待优化的原始提示词（用于判定 changed）。
 * @param {number} [input.timeoutMs] - 超时。
 * @param {AbortSignal} [input.signal] - 取消信号。
 * @param {(url: string, init: object) => Promise<Response>} [input.fetchImpl] - 注入的 fetch。
 * @returns {Promise<{ ok: true, optimized: string, changed: boolean, elapsedMs: number }
 *                 | { ok: false, code: string, error: string, elapsedMs: number }>} 结果。
 */
export async function optimizeOnce(input) {
  const started = Date.now()
  const messages = buildMessages(input.instruction, input.userContent)
  const res = await callOptimizer({
    baseURL: input.endpoint?.baseURL,
    model: input.endpoint?.model,
    apiKey: input.apiKey,
    messages,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
  })
  const elapsedMs = Date.now() - started
  if (!res.ok) return { ok: false, code: res.code, error: res.error, elapsedMs }

  const optimized = stripFences(res.text)
  if (optimized.length === 0) {
    return { ok: false, code: 'BAD_RESPONSE', error: '优化模型返回了空内容', elapsedMs }
  }
  const original = typeof input.original === 'string' ? input.original.trim() : ''
  const changed = optimized.trim() !== original
  return { ok: true, optimized, changed, elapsedMs }
}
