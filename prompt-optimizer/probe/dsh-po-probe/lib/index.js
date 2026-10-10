/**
 * dsh-po-probe —— DSH「真人提示词优化器」技术探针（一次性、可完整回滚）
 * ============================================================================
 * 回答三个问题：
 *   Q1 `agent/pre-step` 能否拿到本轮真人输入文本并改写（且保留原 source/rpcId）？
 *   Q2 给 source 追加自定义字段，写入会话日志再读回后是否仍在？
 *   Q3 在 `agent/pre-step` 里发一次旁路 LLM 调用（Node fetch → OpenAI 兼容接口）
 *      是否可行且不污染主会话？
 *
 * 安全默认值：只有文件 <probe>/ENABLE 存在时才真正改写；否则只记录、原样返回 decision。
 * 零 npm 依赖，纯 JS ESM。所有路由先过 connection 信任栅栏。
 *
 * @module dsh-po-probe
 */
import fs from 'node:fs'
import path from 'node:path'
import dns from 'node:dns'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROBE_ROOT = path.resolve(PACKAGE_ROOT, '..') // ...\probe
const ENABLE_FILE = path.join(PROBE_ROOT, 'ENABLE')
const DISABLE_FILE = path.join(PROBE_ROOT, 'DISABLE')
const LOG_FILE = path.join(PROBE_ROOT, 'probe-log.jsonl')
const CONFIG_FILE = path.join(PROBE_ROOT, 'probe-config.json')
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const SETTINGS_FILE = path.join(DSH_HOME, 'settings.yaml')
const CREDENTIALS_FILE = path.join(DSH_HOME, '.credentials.yaml')
const RING_MAX = 400

const DEFAULT_CONFIG = {
  // 旁路优化调用（Node fetch → POST {baseURL}/chat/completions）。null = 从 settings.yaml 解析。
  provider: null,
  model: null,
  baseUrl: null,
  apiKeyEnv: null,
  maxChars: 4000,
  timeoutMs: 12000,
  systemPrompt: '把用户输入改写得更清晰具体，只输出改写结果。',
}

// ---------------------------------------------------------------------------
// 内存日志 + 落盘 jsonl
// ---------------------------------------------------------------------------
const ring = []
console.log(`[dsh-po-probe] module loaded from ${import.meta.url}`)

function log(kind, data) {
  const entry = { ts: new Date().toISOString(), kind, ...data }
  ring.push(entry)
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch (err) {
    console.log(`[dsh-po-probe] jsonl append failed: ${err && err.message}`)
  }
  try {
    console.log(`[dsh-po-probe] ${kind} ${JSON.stringify(data).slice(0, 400)}`)
  } catch (err) {}
  return entry
}

function tail(limit) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = text.split('\n').filter((l) => l.length > 0)
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l) } catch (err) { return { parseError: true, raw: l.slice(0, 200) } }
    })
  } catch (err) {
    return []
  }
}

// ---------------------------------------------------------------------------
// 极简 YAML 读取（只支持本机 settings.yaml / .credentials.yaml 用到的形态）
// ---------------------------------------------------------------------------
function unquote(v) {
  let s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1)
  return s
}

/** 读 .credentials.yaml 的 refs: 段 → { ENV_NAME: value } */
function readCredentialRefs() {
  const out = {}
  let text
  try {
    text = fs.readFileSync(CREDENTIALS_FILE, 'utf8')
  } catch (err) {
    return { ok: false, error: `read failed: ${err && err.message}`, refs: out }
  }
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

/**
 * 读 settings.yaml 的 llm-pi-ai.providers → { name: { baseURL, apiKeyEnv } }
 *
 * 实现说明：本机 settings.yaml 用的是**多行 flow 映射**
 *   providers:
 *     {
 *       volcengine-coding-plan:
 *         {
 *           displayName: 火山 Coding Plan,
 *           apiKeyEnv: VOLCENGINE_CODING_PLAN_API_KEY,
 *           baseURL: https://ark.cn-beijing.volces.com/api/coding/v3,
 *   ...
 * 逐行状态机在这种形态下不可靠，因此改为：逐个匹配 `name:\n { ... }` 块并做花括号配平，
 * 再在块内用正则抓 baseURL / apiKeyEnv。零依赖，够用即止。
 */
function readProviderSettings() {
  const providers = {}
  let text
  try {
    text = fs.readFileSync(SETTINGS_FILE, 'utf8')
  } catch (err) {
    return { ok: false, error: `read failed: ${err && err.message}`, providers }
  }
  const lines = text.split(/\r?\n/)
  // 找到 llm-pi-ai: → providers: 区域
  let i = lines.findIndex((l) => /^\s*llm-pi-ai\s*:/.test(l))
  if (i === -1) return { ok: true, providers, note: 'no llm-pi-ai section' }
  let j = -1
  for (let k = i + 1; k < lines.length; k += 1) {
    if (/^\S/.test(lines[k]) && lines[k].trim() !== '') break // 离开 llm-pi-ai 段
    if (/^\s*providers\s*:/.test(lines[k])) { j = k; break }
  }
  if (j === -1) return { ok: true, providers, note: 'no providers key' }

  // 从 providers: 之后聚合，直到遇到下一个顶级键
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
    // 花括号配平，取出该 provider 的整块
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

function readConfigFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return { ok: true, config: parsed }
  } catch (err) {
    if (err && err.code !== 'ENOENT') return { ok: false, error: String(err.message) }
    return { ok: false, error: 'no probe-config.json' }
  }
}

/**
 * 解析旁路优化调用目标。优先级：probe-config.json > settings.yaml 的 deepseek-official 等价（llm-deepseek）。
 * 说明：settings.yaml 里 agent-default-model.provider = deepseek-official / model = deepseek-flash，
 * 该 provider 由 llm-deepseek 段（DEEPSEEK_API_KEY + https://api.deepseek.com）承载。
 */
function resolveTarget() {
  const fileCfg = readConfigFile()
  const cfg = { ...DEFAULT_CONFIG, ...(fileCfg.ok ? fileCfg.config : {}) }
  const creds = readCredentialRefs()
  const settings = readProviderSettings()
  const notes = []
  if (!fileCfg.ok) notes.push(`config: ${fileCfg.error}`)
  if (!creds.ok) notes.push(`credentials: ${creds.error}`)
  if (!settings.ok) notes.push(`settings: ${settings.error}`)

  let provider = cfg.provider
  let model = cfg.model
  let baseUrl = cfg.baseUrl
  let apiKeyEnv = cfg.apiKeyEnv

  // 默认目标：settings.yaml 的 agent-default-model（deepseek-official/deepseek-flash）
  if (!provider) provider = 'deepseek-official'
  if (!model) model = 'deepseek-flash'
  if (!baseUrl) {
    if (provider === 'deepseek-official') baseUrl = 'https://api.deepseek.com'
    else if (settings.providers[provider] && settings.providers[provider].baseURL) baseUrl = settings.providers[provider].baseURL
  }
  if (!apiKeyEnv) {
    if (provider === 'deepseek-official') apiKeyEnv = 'DEEPSEEK_API_KEY'
    else if (settings.providers[provider] && settings.providers[provider].apiKeyEnv) apiKeyEnv = settings.providers[provider].apiKeyEnv
  }
  const apiKey = apiKeyEnv ? creds.refs[apiKeyEnv] : undefined
  if (!apiKey) notes.push(`apiKey ${apiKeyEnv} not found in refs`)

  return {
    provider, model, baseUrl, apiKeyEnv,
    apiKeyPresent: Boolean(apiKey),
    apiKey,
    maxChars: cfg.maxChars,
    timeoutMs: cfg.timeoutMs,
    systemPrompt: cfg.systemPrompt,
    knownProviders: Object.keys(settings.providers),
    credRefNames: Object.keys(creds.refs),
    notes,
  }
}

// ---------------------------------------------------------------------------
// createUserMessage：优先用宿主的真实现（绝对路径动态 import），失败则本地等价实现
// ---------------------------------------------------------------------------
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

const DSH_CANDIDATE_ROOTS = [
  process.env.DSH_INSTALL_DIR,
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
  path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  path.resolve(process.argv[1] ? path.dirname(process.argv[1]) : '.', 'node_modules', '@deepseek-ai', 'dsh'),
  path.resolve(DSH_HOME, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh'),
].filter(Boolean)

async function loadCreateUserMessage() {
  // 1) 裸导入（宿主若做了模块回退就能用）
  try {
    const mod = await import('@deepseek-ai/dsh-llm/message')
    if (typeof mod.createUserMessage === 'function') {
      return { fn: mod.createUserMessage, how: 'bare import @deepseek-ai/dsh-llm/message' }
    }
  } catch (err) { /* fallthrough */ }
  // 2) 从 dsh 安装目录绝对路径导入
  for (const root of DSH_CANDIDATE_ROOTS) {
    const p = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'types', 'message.js')
    try {
      if (!fs.existsSync(p)) continue
      const mod = await import(pathToFileURL(p).href)
      if (typeof mod.createUserMessage === 'function') {
        return { fn: mod.createUserMessage, how: `absolute import ${p}` }
      }
    } catch (err) { /* try next */ }
  }
  return { fn: localCreateUserMessage, how: 'local equivalent (createMessage: spread + structuredClone + deepFreeze + randomUUID)' }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------
export const name = 'dsh-po-probe'
export const inject = ['webServer']

export async function apply(ctx) {
  const state = {
    loadedAt: new Date().toISOString(),
    packageRoot: PACKAGE_ROOT,
    probeRoot: PROBE_ROOT,
    enableFile: ENABLE_FILE,
    enableFileExists: false,
    rewriter: 'unknown',
    registeredEvents: [],
    registeredRoutes: [],
    preStepCount: 0,
    rewriteCount: 0,
    lastPreStep: null,
    llmCalls: [],
    errors: [],
    lastResolution: null,
  }

  const { fn: createUserMessage, how: rewriterHow } = await loadCreateUserMessage()
  state.rewriter = rewriterHow
  log('module', { message: 'apply() start', rewriter: rewriterHow, packageRoot: PACKAGE_ROOT })

  function enabled() {
    try {
      if (fs.existsSync(DISABLE_FILE)) { state.enableFileExists = false; return false }
      const on = fs.existsSync(ENABLE_FILE)
      state.enableFileExists = on
      return on
    } catch (err) {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // 信任栅栏（照抄 whale-widget lib/index.js:537-566）
  // -------------------------------------------------------------------------
  function rejected(req, res) {
    try {
      const conn = ctx.get('connection') || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') {
        if (!rejected.warned) {
          rejected.warned = true
          try { console.warn('[dsh-po-probe] 信任栅栏不可用：connection 服务缺失，自定义路由将放行处理') } catch (err) {}
        }
        return false
      }
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch (err) { return false }
  }

  function registerRoute(route) {
    const inner = route && route.handler
    const wrapped = Object.assign({}, route, {
      handler: async (req, res) => {
        if (rejected(req, res)) return
        return inner(req, res)
      },
    })
    return ctx.webServer.register(wrapped)
  }

  function sendJson(res, status, value) {
    let body
    try { body = JSON.stringify(value, null, 2) } catch (err) { body = JSON.stringify({ serializeError: String(err) }) }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  }

  // -------------------------------------------------------------------------
  // 旁路 LLM 调用（Node fetch，OpenAI 兼容 /chat/completions）
  // -------------------------------------------------------------------------
  async function callOptimizer(text, signal) {
    const target = resolveTarget()
    state.lastResolution = { ...target, apiKey: target.apiKeyPresent ? '<redacted>' : null }
    if (!target.apiKeyPresent) {
      return { ok: false, error: `missing api key env ${target.apiKeyEnv}`, target: state.lastResolution }
    }
    // fetch 在部分网络下会优先 IPv6；探测脚本里统一 IPv4 优先（照抄 whale-widget 的做法）
    try { dns.setDefaultResultOrder('ipv4first') } catch (err) {}
    const url = `${String(target.baseUrl).replace(/\/+$/, '')}/chat/completions`
    const body = {
      model: target.model,
      messages: [
        { role: 'system', content: target.systemPrompt },
        { role: 'user', content: text },
      ],
      stream: false,
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('probe timeout')), target.timeoutMs)
    const onAbort = () => ac.abort(new Error('turn aborted'))
    try { if (signal) signal.addEventListener('abort', onAbort, { once: true }) } catch (err) {}
    const started = Date.now()
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      const raw = await resp.text()
      let parsed = null
      try { parsed = JSON.parse(raw) } catch (err) {}
      const out = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
        ? String(parsed.choices[0].message.content ?? '')
        : null
      const rec = {
        ts: new Date().toISOString(),
        url,
        model: target.model,
        provider: target.provider,
        status: resp.status,
        ms: Date.now() - started,
        ok: resp.ok && typeof out === 'string' && out.trim().length > 0,
        outLen: out ? out.length : 0,
        rawHead: raw.slice(0, 600),
      }
      state.llmCalls.push(rec)
      if (state.llmCalls.length > 50) state.llmCalls.shift()
      log('llm-call', rec)
      if (!rec.ok) return { ok: false, error: `http ${resp.status}`, detail: rec, target: state.lastResolution }
      return { ok: true, text: out.trim(), detail: rec, target: state.lastResolution }
    } catch (err) {
      const rec = { ts: new Date().toISOString(), url, model: target.model, ms: Date.now() - started, ok: false, error: String((err && err.message) || err) }
      state.llmCalls.push(rec)
      if (state.llmCalls.length > 50) state.llmCalls.shift()
      log('llm-call', rec)
      return { ok: false, error: rec.error, detail: rec, target: state.lastResolution }
    } finally {
      clearTimeout(timer)
      try { if (signal) signal.removeEventListener('abort', onAbort) } catch (err) {}
    }
  }

  // -------------------------------------------------------------------------
  // 消息工具
  // -------------------------------------------------------------------------
  function isHumanMessage(m) {
    return Boolean(m) && m.role === 'user' && m.source && m.source.kind === 'user' && 'rpcId' in m.source
  }
  function textOf(m) {
    if (!m || !Array.isArray(m.content)) return ''
    return m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
  }
  function summarizeMessage(m) {
    const src = m && m.source ? m.source : null
    return {
      role: m && m.role,
      id: m && m.id,
      sourceKind: src && src.kind,
      sourceKeys: src ? Object.keys(src) : [],
      hasRpcId: Boolean(src && 'rpcId' in src),
      rpcId: src && src.rpcId !== undefined ? String(src.rpcId) : null,
      contentTypes: Array.isArray(m && m.content) ? m.content.map((b) => b && b.type) : null,
      textLen: textOf(m).length,
      textHead: textOf(m).slice(0, 200),
      isHuman: isHumanMessage(m),
    }
  }

  // -------------------------------------------------------------------------
  // agent/pre-step 监听
  // -------------------------------------------------------------------------
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      state.preStepCount += 1
      const decision = await next()
      const messages = (decision && decision.kind === 'enter' && Array.isArray(decision.messages))
        ? decision.messages
        : (payload && Array.isArray(payload.messages) ? payload.messages : [])

      const summary = {
        seq: state.preStepCount,
        sessionId: payload && payload.agent && payload.agent.session ? String(payload.agent.session.id) : null,
        turn: payload && payload.turn,
        step: payload && payload.step,
        decisionKind: decision && decision.kind,
        payloadMessageCount: payload && Array.isArray(payload.messages) ? payload.messages.length : null,
        decisionMessageCount: decision && Array.isArray(decision.messages) ? decision.messages.length : null,
        messages: (payload && Array.isArray(payload.messages) ? payload.messages : []).map(summarizeMessage),
        route: payload && payload.agent && payload.agent.session && typeof payload.agent.session.requestHeader === 'function'
          ? (payload.agent.session.requestHeader() || {}).config ?? null
          : null,
      }
      state.lastPreStep = summary

      const humans = messages.filter(isHumanMessage)
      log('pre-step', {
        ...summary,
        humanCount: humans.length,
        humanTexts: humans.map((m) => textOf(m).slice(0, 500)),
        enabled: enabled(),
      })

      if (!enabled()) {
        return { ...decision, messages, probe: { enabled: false, recordedOnly: true, humanCount: humans.length } }
      }
      if (!decision || decision.kind !== 'enter' || humans.length === 0) {
        return { ...decision, messages }
      }

      let changed = false
      const rewritten = []
      for (const m of messages) {
        if (!isHumanMessage(m)) { rewritten.push(m); continue }
        const original = textOf(m)
        if (!original.trim()) { rewritten.push(m); continue }
        const result = await callOptimizer(original.slice(0, 4000), payload && payload.signal)
        if (!result.ok) {
          log('rewrite-skip', { sessionId: summary.sessionId, turn: summary.turn, step: summary.step, rpcId: String(m.source.rpcId), error: result.error })
          rewritten.push(m)
          continue
        }
        const optimized = result.text
        const hasImages = Array.isArray(m.content) && m.content.some((b) => b && b.type !== 'text')
        const newContent = hasImages
          ? m.content.map((b) => (b && b.type === 'text' ? { type: 'text', text: optimized } : b))
          : [{ type: 'text', text: optimized }]
        const newSource = { ...m.source, originalText: original, optimizedBy: `${result.target.provider}/${result.target.model}` }
        const newMessage = createUserMessage({ content: newContent, source: newSource })
        changed = true
        state.rewriteCount += 1
        log('rewrite', {
          sessionId: summary.sessionId,
          turn: summary.turn,
          step: summary.step,
          rpcId: String(m.source.rpcId),
          originalHead: original.slice(0, 300),
          optimizedHead: optimized.slice(0, 300),
          preservedSourceKeys: Object.keys(newSource),
          rpcIdPreserved: newSource.rpcId === m.source.rpcId,
          newMessageId: newMessage.id,
          oldMessageId: m.id,
          model: `${result.target.provider}/${result.target.model}`,
        })
        rewritten.push(newMessage)
      }
      if (!changed) return { ...decision, messages }
      return { ...decision, messages: rewritten }
    })
    state.registeredEvents.push('agent/pre-step')
    log('register', { event: 'agent/pre-step', ok: true })
  } catch (err) {
    state.errors.push(`ctx.on(agent/pre-step) failed: ${String(err && err.message)}`)
    log('error', { where: 'ctx.on(agent/pre-step)', error: String(err && err.message) })
  }

  // -------------------------------------------------------------------------
  // 路由 1：status.json
  // -------------------------------------------------------------------------
  const disposers = []
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-po-probe/status.json',
    handler: (req, res) => {
      state.enableFileExists = enabled()
      sendJson(res, 200, {
        probe: 'dsh-po-probe',
        loadedAt: state.loadedAt,
        now: new Date().toISOString(),
        enable: {
          enableFile: ENABLE_FILE,
          enableFileExists: state.enableFileExists,
          disableFile: DISABLE_FILE,
          disableFileExists: fs.existsSync(DISABLE_FILE),
          effective: state.enableFileExists,
        },
        rewriter: state.rewriter,
        registeredEvents: state.registeredEvents,
        registeredRoutes: state.registeredRoutes,
        preStepCount: state.preStepCount,
        rewriteCount: state.rewriteCount,
        lastPreStep: state.lastPreStep,
        lastResolution: state.lastResolution,
        llmCalls: state.llmCalls,
        errors: state.errors,
        logFile: LOG_FILE,
        inMemoryLogCount: ring.length,
        recentInMemory: ring.slice(-60),
        persistedLogTail: tail(60),
      })
    },
  }))
  state.registeredRoutes.push('/dsh-po-probe/status.json')

  // -------------------------------------------------------------------------
  // 路由 2：selftest.json —— Q2 验证：自定义 source 字段能否落盘并读回
  // -------------------------------------------------------------------------
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-po-probe/selftest.json',
    handler: async (req, res) => {
      const report = {
        probe: 'dsh-po-probe',
        startedAt: new Date().toISOString(),
        steps: [],
        answers: {},
        warnings: [],
      }
      const step = (name, value) => { report.steps.push({ name, ...value }); log('selftest-step', { name, value }) }

      const sessions = ctx.get('sessions') || ctx.sessions
      const sessionQuery = ctx.get('sessionQuery') || ctx.sessionQuery
      const sessionController = ctx.get('sessionController') || ctx.sessionController
      step('services', {
        sessions: Boolean(sessions),
        sessionQuery: Boolean(sessionQuery),
        sessionController: Boolean(sessionController),
        sessionQueryReadSession: Boolean(sessionQuery && typeof sessionQuery.readSession === 'function'),
        sessionQueryReadSurface: Boolean(sessionQuery && typeof sessionQuery.readSurface === 'function'),
        sessionsCreate: Boolean(sessions && typeof sessions.create === 'function'),
      })
      if (!sessions || typeof sessions.create !== 'function') {
        report.ok = false
        report.error = 'ctx.sessions.create unavailable'
        return sendJson(res, 500, report)
      }

      // 关键：用一个嵌套 effect 创建临时会话 —— 其 disposer 在本次 selftest 结束时释放该会话，
      // 保证不触碰任何既有会话，也不会把临时会话留到插件卸载之后。
      let tempId = null
      let tempSession = null
      let sessionScopeDisposer = null
      try {
        // ctx.sessions.create() 内部自己就注册了一个 fiber 级 effect（卸载插件即移除该会话）；
        // 我们再把 create 包进自己的 effect，并抓取其 disposer，在本次 handler 末尾确定性释放。
        // Cordis: ctx.effect(execute) 返回 Disposable<Promise<void>>，调用它即运行该 effect 的清理链。
        sessionScopeDisposer = ctx.effect(() => {
          const s = sessions.create(`session-po-selftest-${randomUUID()}`, {
            meta: { cwd: process.cwd() },
          })
          tempSession = s
          tempId = String(s.id)
          return () => {}
        }, 'dsh-po-probe-selftest')
      } catch (err) {
        report.ok = false
        report.error = `ctx.sessions.create threw: ${String(err && err.message)}`
        return sendJson(res, 500, report)
      }
      step('create', { tempSessionId: tempId, sameAsCurrentSession: tempId === 'session-7a49f5b1-29f1-4fb1-8a06-12a14f5f1ad8' })

      const sourceIn = {
        kind: 'user',
        rpcId: 'po-selftest-1',
        originalText: '原始文本',
        optimizedBy: 'x/y',
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: 'PO-SELFTEST' }],
        source: sourceIn,
      })
      step('createUserMessage', {
        rewriter: state.rewriter,
        messageId: message.id,
        sourceFrozenSnapshot: message.source,
        sourceKeys: Object.keys(message.source),
        frozen: Object.isFrozen(message),
        sourceFrozen: Object.isFrozen(message.source),
      })

      step('enter', { note: 'ctx.sessions.create() already prepared+entered+announced the session; no extra enter needed' })

      let appended = null
      try {
        appended = tempSession.append('user/message', message, { surfaceOp: 'append' })
        step('append', {
          ok: true,
          call: "session.append('user/message', createUserMessage(...), { surfaceOp: 'append' })",
          seq: appended.seq,
          eventType: appended.type,
          appendedDataSource: appended.data.source,
          appendedDataSourceKeys: Object.keys(appended.data.source),
        })
      } catch (err) {
        step('append', { ok: false, error: String(err && err.message) })
        report.answers.q2 = { verified: false, reason: 'append threw' }
      }

      // 直读 live log
      try {
        const own = tempSession.snapshotEvents()
        const last = own[own.length - 1]
        step('liveRead', {
          ok: true,
          eventCount: own.length,
          lastEventType: last && last.type,
          lastEventSeq: last && last.seq,
          lastDataSource: last && last.data && last.data.source,
        })
      } catch (err) {
        step('liveRead', { ok: false, error: String(err && err.message) })
      }

      // flush 到持久层
      try {
        if (typeof sessions.flush === 'function') {
          const participated = await sessions.flush(tempSession)
          step('flush', { ok: true, participated })
        }
      } catch (err) {
        step('flush', { ok: false, error: String(err && err.message) })
      }

      // sessionQuery.readSession
      if (sessionQuery && typeof sessionQuery.readSession === 'function') {
        try {
          const snap = await sessionQuery.readSession(tempId)
          const ev = snap.events.find((e) => e.type === 'user/message')
          step('readSession', {
            ok: true,
            eventCount: snap.events.length,
            found: Boolean(ev),
            foundSeq: ev && ev.seq,
            source: ev && ev.data && ev.data.source,
            sourceKeys: ev && ev.data && ev.data.source ? Object.keys(ev.data.source) : null,
            header: snap.session,
          })
        } catch (err) {
          step('readSession', { ok: false, error: String(err && err.message) })
        }
      } else {
        step('readSession', { ok: false, error: 'ctx.sessionQuery.readSession unavailable' })
      }

      // sessionQuery.readSurface
      if (sessionQuery && typeof sessionQuery.readSurface === 'function') {
        try {
          const surf = await sessionQuery.readSurface(tempId)
          const ev = surf.events.find((e) => e.type === 'user/message')
          step('readSurface', {
            ok: true,
            eventCount: surf.events.length,
            found: Boolean(ev),
            foundSeq: ev && ev.seq,
            source: ev && ev.data && ev.data.source,
            sourceKeys: ev && ev.data && ev.data.source ? Object.keys(ev.data.source) : null,
          })
        } catch (err) {
          step('readSurface', { ok: false, error: String(err && err.message) })
        }
      } else {
        step('readSurface', { ok: false, error: 'ctx.sessionQuery.readSurface unavailable' })
      }

      // 结论：把「写入时的 source」与「读回后的 source」原始 JSON 并排
      const stepByName = (n) => report.steps.find((s) => s.name === n)
      const readBack = stepByName('readSession')
      const written = stepByName('append') && stepByName('append').appendedDataSource
      report.answers.q2 = {
        writtenSourceJson: JSON.stringify(written),
        readBackSourceJson: readBack && readBack.source ? JSON.stringify(readBack.source) : null,
        customFieldsSurvive: Boolean(
          readBack && readBack.source && readBack.source.originalText === '原始文本' && readBack.source.optimizedBy === 'x/y',
        ),
        rpcIdSurvives: Boolean(readBack && readBack.source && readBack.source.rpcId === 'po-selftest-1'),
      }

      // 尽力清理：调用我们自己抓到的 effect disposer，链式释放该临时会话（并移除 store 条目）
      report.cleanup = { tempSessionId: tempId, sessionIsCurrentSession: tempId === 'session-7a49f5b1-29f1-4fb1-8a06-12a14f5f1ad8' }
      try {
        const cwd = tempSession.header && tempSession.header.cwd
        report.cleanup.cwd = cwd || null
        report.cleanup.expectedLogDir = cwd
          ? path.join(DSH_HOME, 'sessions', String(cwd).replace(/[\\/]/g, '-').replace(/\s/g, '~0020') + '--', tempId)
          : null
      } catch (err) {}
      try {
        const sessions2 = ctx.get('sessions') || ctx.sessions
        const stillLiveBefore = Boolean(sessions2 && sessions2.get(tempId))
        if (sessionScopeDisposer) await sessionScopeDisposer()
        const stillLiveAfter = Boolean(sessions2 && sessions2.get(tempId))
        report.cleanup.dispose = {
          called: true,
          method: 'ctx.effect(...) disposer (cascades into the effect ctx.sessions.create() registered)',
          liveBefore: stillLiveBefore,
          liveAfter: stillLiveAfter,
        }
        step('dispose', report.cleanup.dispose)
      } catch (err) {
        report.cleanup.dispose = { called: false, error: String(err && err.message) }
      }
      try {
        if (report.cleanup.expectedLogDir && fs.existsSync(report.cleanup.expectedLogDir)) {
          report.cleanup.persistedFilesRemaining = fs.readdirSync(report.cleanup.expectedLogDir)
        } else {
          report.cleanup.persistedFilesRemaining = null
        }
      } catch (err) { report.cleanup.persistedFilesRemaining = null }

      report.ok = true
      report.finishedAt = new Date().toISOString()
      log('selftest-done', { answers: report.answers, cleanup: report.cleanup })
      sendJson(res, 200, report)
    },
  }))
  state.registeredRoutes.push('/dsh-po-probe/selftest.json')

  // -------------------------------------------------------------------------
  // 路由 3：llmcheck.json —— 单独验证旁路 fetch 链路，无需真人输入
  // -------------------------------------------------------------------------
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-po-probe/llmcheck.json',
    handler: async (req, res) => {
      const target = resolveTarget()
      const result = await callOptimizer('写一句关于深海探测的说明', null)
      sendJson(res, 200, {
        probe: 'dsh-po-probe',
        target: { ...target, apiKey: target.apiKeyPresent ? '<redacted>' : null },
        result,
        mainSessionUntouched: 'this route never appends to any session',
      })
    },
  }))
  state.registeredRoutes.push('/dsh-po-probe/llmcheck.json')

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
    log('cleanup', { message: 'routes disposed', routes: state.registeredRoutes })
  })

  log('ready', {
    registeredEvents: state.registeredEvents,
    registeredRoutes: state.registeredRoutes,
    enabled: enabled(),
    rewriter: rewriterHow,
  })
}
