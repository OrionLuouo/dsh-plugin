/**
 * dsh-prompt-optimizer —— 提示词优化插件的宿主侧入口。
 *
 * 职责：
 * 1. 挂 `agent/pre-step` waterfall，把本轮真人提示词替换为优化后的版本（见 lib/rewriter.js）。
 * 2. 提供同源 HTTP 接口给浏览器侧 UI（见 lib/routes.js）。
 * 3. 通过 `webServer.tapIndex` 往 index.html 注入前端脚本（见 assets/ui.js）。
 *
 * 重要：本模块**不使用 `export default`**。DSH 的插件加载器用 `unwrapExports`
 * 归一导出，使用 default 会丢掉 `inject` 声明（见 dsh-tool-todo 的 README 说明）。
 *
 * @module dsh-prompt-optimizer
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, dshHome, configPath } from './config.js'
import { Credentials } from './credentials.js'
import { RuntimeState } from './state.js'
import { buildCatalog } from './catalog.js'
import { rewriteMessages, resolveCreateUserMessage } from './rewriter.js'
import { registerRoutes, ROUTE_PREFIX } from './routes.js'

/** 插件名（loader 用它作为 row id）。 */
export const name = 'dsh-prompt-optimizer'

/**
 * 所需宿主服务。
 * 只声明 `webServer`：`connection` 与凭据都用 `ctx.get()` 可选获取，
 * 这样在服务缺失时能给出可读错误而不是让插件加载失败。
 */
export const inject = ['webServer']

/** 本模块所在目录。 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 包根目录。 */
const PACKAGE_ROOT = path.resolve(HERE, '..')

/** 前端脚本的候选位置（按优先级）。 */
const UI_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'ui.js'),
  path.join(HERE, 'ui.js'),
]

/** 模型目录的刷新间隔（毫秒）。 */
const CATALOG_TTL_MS = 30_000

/** 前端脚本缓存：{ text, mtimeMs }。 */
let uiCache = null

/**
 * 读取前端脚本（按 mtime 缓存，改完硬刷新页面即生效，无需重启）。
 * @returns {string | null} 脚本内容；找不到文件时返回 null。
 */
function loadUiScript() {
  for (const file of UI_CANDIDATES) {
    try {
      const stat = fs.statSync(file)
      if (uiCache && uiCache.file === file && uiCache.mtimeMs === stat.mtimeMs) return uiCache.text
      const text = fs.readFileSync(file, 'utf8')
      uiCache = { file, text, mtimeMs: stat.mtimeMs }
      return text
    } catch {
      // 换下一个候选
    }
  }
  return uiCache ? uiCache.text : null
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
export function apply(ctx) {
  const home = dshHome()
  const state = new RuntimeState({ home })
  const credentials = new Credentials({ home })

  /** @type {object} */
  let config = loadConfig({ home })
  /** 配置文件的 mtime，用于感知外部编辑（用户在设置页写文件时不必重启）。 */
  let configMtime = 0
  const statConfig = () => {
    try {
      return fs.statSync(configPath(home)).mtimeMs
    } catch {
      return 0
    }
  }
  configMtime = statConfig()

  /** 取当前配置（若文件被外部改动则重读）。 */
  function getConfig() {
    const mtime = statConfig()
    if (mtime !== configMtime) {
      configMtime = mtime
      try {
        config = loadConfig({ home })
        credentials.invalidate()
      } catch {
        /* 保持旧配置 */
      }
    }
    return config
  }

  /** 强制重读配置。 */
  function reloadConfig() {
    configMtime = statConfig()
    config = loadConfig({ home })
    credentials.invalidate()
  }

  /** @type {{ catalog: object | null, at: number }} */
  let catalogCache = { catalog: null, at: 0 }

  /** 取模型目录（带 TTL 缓存）。 */
  function getCatalog() {
    const now = Date.now()
    if (catalogCache.catalog && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.catalog
    return catalogCache.catalog
  }

  /** 异步刷新模型目录。 */
  async function refreshCatalog() {
    try {
      const catalog = await buildCatalog({ home })
      catalogCache = { catalog, at: Date.now() }
    } catch {
      /* 保留旧目录 */
    }
  }

  /** 当前会话信息（供 UI 显示上下文轮数）。 */
  let sessionInfo = { sessionId: null, currentContextTurns: 0, updatedAt: 0 }

  /** 取当前会话信息。 */
  function getSessionInfo() {
    return { ...sessionInfo }
  }

  /** 取当前会话的消息（给 /optimize.json 当上下文用）。 */
  let sessionMessages = []
  function getSessionMessages() {
    return sessionMessages
  }

  /** 改写器运行信息（排障用）。 */
  let rewriterInfo = { createUserMessage: 'unknown', preStepBound: false }

  // —— 挂 agent/pre-step ——
  //
  // 注意：挂根 ctx 可收到**所有** agent 的事件（scope 过滤对祖先层放行）。
  // 子代理的输入来源不是 `user-rpc`，会被 rewriter 里的人真判据自然排除。
  const disposePreStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter') return decision
      const current = getConfig()
      if (!current.enabled || current.mode !== 'optimize') return decision

      // 记录当前会话信息，供 UI 与 /optimize.json 使用
      try {
        const messages = payload.agent?.session?.deriveMessages?.() ?? []
        sessionMessages = messages
        sessionInfo = {
          sessionId: payload.agent?.session?.id ?? null,
          currentContextTurns: Math.max(0, messages.filter((m) => m?.source?.kind === 'user' && 'rpcId' in (m.source ?? {})).length - 1),
          updatedAt: Date.now(),
        }
      } catch {
        /* 会话信息只是展示用，失败不影响改写 */
      }

      const result = await rewriteMessages({
        messages: decision.messages,
        step: payload.step,
        config: current,
        catalog: getCatalog(),
        resolveKey: (refName) => credentials.resolve(refName),
        state,
        sessionId: payload.agent?.session?.id ?? null,
        turn: payload.turn,
        signal: payload.signal,
      })

      if (result.cancelled) {
        return { kind: 'reject' }
      }
      if (result.messages === decision.messages) return decision
      return { ...decision, messages: result.messages }
    } catch (err) {
      // 任何异常都不该破坏会话：原样放行，并把原因记进状态
      try {
        state.pushRecent({
          sessionId: payload?.agent?.session?.id ?? '',
          turn: payload?.turn,
          ok: false,
          code: 'PLUGIN_ERROR',
          modelRef: '',
          elapsedMs: 0,
          inputChars: 0,
          outputChars: 0,
        })
      } catch {
        /* 忽略 */
      }
      return decision
    }
  })

  // —— HTTP 路由 ——
  const routeDisposers = registerRoutes({
    ctx,
    getConfig,
    getCatalog,
    getCredentials: () => credentials,
    getState: () => state,
    getSessionInfo,
    getSessionMessages,
    getUiScript: loadUiScript,
    getRewriterInfo: () => rewriterInfo,
    getHome: () => home,
    reloadConfig,
  })

  // —— 注入前端脚本 ——
  const disposeTap = ctx.webServer.tapIndex((html) => {
    const src = `${ROUTE_PREFIX}/ui.js`
    if (html.includes(src)) return html
    const tag = `<script defer src="${src}"></script>`
    if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`)
    return html + tag
  })

  // —— 启动时预热：解析改写所需的构造器、刷新模型目录 ——
  void (async () => {
    try {
      const resolved = await resolveCreateUserMessage()
      rewriterInfo = { ...rewriterInfo, createUserMessage: resolved.via, preStepBound: true }
    } catch {
      rewriterInfo = { ...rewriterInfo, createUserMessage: 'local', preStepBound: true }
    }
    await refreshCatalog()
  })()

  /** 定时刷新目录（让用户在 DSH 里新加的 provider 自动出现）。 */
  const catalogTimer = setInterval(() => {
    void refreshCatalog()
  }, CATALOG_TTL_MS)
  if (typeof catalogTimer.unref === 'function') catalogTimer.unref()

  // —— 统一清理 ——
  ctx.effect(() => () => {
    clearInterval(catalogTimer)
    try {
      disposePreStep?.()
    } catch {
      /* 忽略 */
    }
    for (const dispose of routeDisposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    try {
      disposeTap?.()
    } catch {
      /* 忽略 */
    }
  })
}
