/**
 * HTTP 路由：前端 UI 与宿主插件之间的同源 JSON 接口。
 *
 * 安全约束（每条路由都强制遵守）：
 * - 先过 DSH 的**浏览器信任栅栏** `connection.requestRejection(req)`：
 *   伪造 Host/Origin（DNS 重绑定）返回 403，未认证返回 401。
 *   （栅栏顺序见 `dsh-client-connection/lib/index.js:553-556`。）
 * - 响应一律 `Cache-Control: no-store`。
 * - **密钥永不回传**：目录里只出现 provider 名与「是否已配置」布尔值。
 * - 请求体大小上限 256 KB，避免被塞入超大 payload。
 *
 * @module dsh-prompt-optimizer/lib/routes
 */
import { optimizeOnce } from './optimize.js'
import { buildContext } from './context.js'
import { resolveModelRef, annotateAvailability } from './catalog.js'
import { activePreset, effectiveModelRef, updateConfig } from './config.js'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/dsh-prompt-optimizer'
/** 请求体大小上限（字节）。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 读取请求体（带大小上限）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<string>} 请求体文本。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} value - 响应体。
 */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 注册全部路由。
 *
 * @param {object} deps - 依赖（都是取当前值的小函数，便于热更新配置）。
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx - 宿主上下文。
 * @param {() => object} deps.getConfig - 取当前配置。
 * @param {() => object | null} deps.getCatalog - 取当前模型目录（未注解）。
 * @param {() => object} deps.getCredentials - 取凭据解析器。
 * @param {() => object} deps.getState - 取运行时状态。
 * @param {() => object | null} deps.getSessionInfo - 取当前会话信息。
 * @param {() => string | null} deps.getUiScript - 取前端脚本内容。
 * @param {() => () => void} deps.onConfigChanged - 配置变更后的回调注册（用于让前端感知）。
 * @returns {(() => void)[]} 清理函数数组。
 */
export function registerRoutes(deps) {
  const { ctx } = deps
  /** @type {(() => void)[]} */
  const disposers = []

  /**
   * 信任栅栏。返回 true 表示请求已被拒绝并结束响应。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @returns {boolean} 是否已拒绝。
   */
  function rejected(req, res) {
    try {
      const conn = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (!conn || typeof conn.requestRejection !== 'function') {
        // 栅栏不可用：宁可拒绝，也不放行一个可能被跨站读写的接口
        writeJson(res, 503, { ok: false, error: '浏览器信任栅栏不可用（connection 服务缺失）' })
        return true
      }
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      writeJson(res, typeof code === 'number' ? code : 403, { ok: false, error: '请求被信任栅栏拒绝' })
      return true
    } catch (err) {
      writeJson(res, 403, { ok: false, error: `信任检查失败：${err?.message ?? String(err)}` })
      return true
    }
  }

  /**
   * 注册一条路由（自动套上信任栅栏与错误兜底）。
   *
   * **注意：`ctx.webServer.register` 要求 `(kind, path)` 唯一**，
   * 重复注册会直接抛错（见 dsh-host-webserver 的类型注释："Duplicate (kind, path)
   * throws — route patterns are a composition-level contract"）。
   * 因此同一路径的不同 HTTP 方法必须合并到**一条**路由里按 method 分派。
   *
   * @param {string} path - 绝对路径。
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void} handler - 处理器。
   * @returns {void}
   */
  function route(path, handler) {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        try {
          await handler(req, res)
        } catch (err) {
          try {
            writeJson(res, 500, { ok: false, error: `插件内部错误：${err?.message ?? String(err)}` })
          } catch {
            /* 响应可能已发出 */
          }
        }
      },
    })
    disposers.push(dispose)
  }

  // —— /config.json：GET 读取，POST 局部更新（同一路径，按方法分派） ——
  route(`${ROUTE_PREFIX}/config.json`, async (req, res) => {
    if (req.method === 'GET') {
      const config = deps.getConfig()
      const rawCatalog = deps.getCatalog()
      const annotated = rawCatalog ? await annotateAvailability(rawCatalog, deps.getCredentials()) : null
      writeJson(res, 200, {
        ok: true,
        config,
        catalog: annotated
          ? { groups: annotated.groups, defaultModelRef: annotated.defaultModelRef, available: annotated.available }
          : { groups: [], defaultModelRef: '', available: false },
        effectiveModelRef: effectiveModelRef(config),
        preset: activePreset(config),
        session: deps.getSessionInfo(),
      })
      return
    }

    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: '只支持 GET 与 POST' })

    let patch
    try {
      const text = await readBody(req)
      patch = JSON.parse(text.length > 0 ? text : '{}')
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: `请求体解析失败：${err?.message ?? String(err)}` })
    }
    const result = updateConfig(patch, { home: deps.getHome?.() })
    if (!result.ok) return writeJson(res, 400, result)
    deps.reloadConfig?.()
    writeJson(res, 200, { ok: true, config: deps.getConfig() })
  })

  // —— POST /optimize.json ——
  route(`${ROUTE_PREFIX}/optimize.json`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: '只支持 POST' })
    let body
    try {
      const text = await readBody(req)
      body = JSON.parse(text.length > 0 ? text : '{}')
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: `请求体解析失败：${err?.message ?? String(err)}` })
    }

    const config = deps.getConfig()
    if (!config.enabled) {
      return writeJson(res, 200, { ok: false, code: 'DISABLED', error: '插件当前已停用' })
    }

    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    if (prompt.trim().length === 0) {
      return writeJson(res, 400, { ok: false, code: 'BAD_RESPONSE', error: 'prompt 不能为空' })
    }
    if (config.maxOptimizeChars > 0 && prompt.trim().length > config.maxOptimizeChars) {
      return writeJson(res, 200, {
        ok: false,
        code: 'TOO_LONG',
        error: `输入超过 ${config.maxOptimizeChars} 字上限，未做优化`,
      })
    }

    const rawCatalog = deps.getCatalog()
    if (!rawCatalog) {
      return writeJson(res, 200, { ok: false, code: 'NO_ENDPOINT', error: '未能读取模型目录' })
    }

    const preset = activePreset(config)
    const modelRef =
      typeof body.modelRef === 'string' && body.modelRef.length > 0
        ? body.modelRef
        : effectiveModelRef(config)
    const resolved = resolveModelRef(rawCatalog, modelRef)
    if (!resolved.ok) {
      return writeJson(res, 200, { ok: false, code: 'NO_ENDPOINT', error: resolved.error })
    }

    const credentials = deps.getCredentials()
    const { key } = await credentials.resolve(resolved.apiKeyEnv)
    if (!key) {
      return writeJson(res, 200, {
        ok: false,
        code: 'NO_KEY',
        error: `未找到 ${resolved.apiKeyEnv} 的密钥，请先在 DSH 设置里配置该 provider`,
      })
    }

    // 上下文：优先用前端给的会话消息；否则用宿主侧会话
    const messages = Array.isArray(body.messages)
      ? body.messages
      : (deps.getSessionMessages?.() ?? [])
    const built = buildContext({
      messages,
      maxTurns: config.context.maxTurns,
      maxChars: config.context.maxChars,
      includeAssistant: config.context.includeAssistant,
    })

    const result = await optimizeOnce({
      endpoint: resolved,
      apiKey: key,
      instruction: preset?.instruction ?? '',
      userContent: built.contextText,
      original: prompt,
      timeoutMs: config.timeoutMs,
    })

    const state = deps.getState()
    state.pushRecent({
      sessionId: deps.getSessionInfo()?.sessionId ?? '',
      turn: 0,
      ok: result.ok,
      code: result.ok ? null : result.code,
      modelRef,
      elapsedMs: result.elapsedMs,
      inputChars: prompt.length,
      outputChars: result.ok ? result.optimized.length : 0,
    })

    if (!result.ok) {
      return writeJson(res, 200, { ok: false, code: result.code, error: result.error, modelRef, presetId: preset?.id })
    }

    const issueTicket = body.issueTicket !== false && config.sendStrategy === 'preview'
    const ticket = issueTicket ? state.issueTicket(result.optimized, modelRef) : null

    writeJson(res, 200, {
      ok: true,
      optimized: result.optimized,
      changed: result.changed,
      modelRef,
      presetId: preset?.id ?? null,
      elapsedMs: result.elapsedMs,
      usedTurns: built.usedTurns,
      totalTurns: built.totalTurns,
      ticket,
    })
  })

  // —— GET /status.json ——
  route(`${ROUTE_PREFIX}/status.json`, async (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: '只支持 GET' })
    const config = deps.getConfig()
    const state = deps.getState()
    writeJson(res, 200, {
      ok: true,
      enabled: config.enabled,
      mode: config.mode,
      sendStrategy: config.sendStrategy,
      modelRef: effectiveModelRef(config),
      presetId: config.presetId,
      onFailure: config.onFailure,
      rewriter: deps.getRewriterInfo?.() ?? {},
      pendingTickets: state.pendingTicketCount(),
      recent: state.recent.slice(0, 20),
      session: deps.getSessionInfo(),
    })
  })

  // —— GET /ui.js ——
  route(`${ROUTE_PREFIX}/ui.js`, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return writeJson(res, 405, { ok: false, error: '只支持 GET' })
    }
    const script = deps.getUiScript()
    if (script === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('dsh-prompt-optimizer: ui.js not found on disk')
      return
    }
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(script),
    })
    res.end(req.method === 'HEAD' ? undefined : script)
  })

  return disposers
}
