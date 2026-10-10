/**
 * 配置读写：`DSH_HOME/prompt-optimizer.json`。
 *
 * 设计要点：
 * - 原子写：先写同目录临时文件，再 rename 覆盖，避免半截文件。
 * - 局部更新：深合并到用户层，未提到的字段保持不变。
 * - 严格校验：非法枚举值直接拒绝（返回可读中文错误），不静默改成别的值。
 * - 默认值：文件缺失时即时生成并落盘；内置预设被删除时按 id 补回。
 *
 * @module dsh-prompt-optimizer/lib/config
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { cloneBuiltinPresets, reconcilePresets, builtinPresetById } from './presets.js'

/** 配置文件基名。 */
export const CONFIG_BASENAME = 'prompt-optimizer.json'
/** 运行时状态文件基名（与配置分离，避免互相污染）。 */
export const STATE_BASENAME = 'prompt-optimizer.state.json'

/** 合法的发送形态。 */
export const SEND_STRATEGIES = Object.freeze(['auto', 'preview'])
/** 合法的运行模式。 */
export const MODES = Object.freeze(['direct', 'optimize'])
/** 合法的失败降级策略。 */
export const ON_FAILURES = Object.freeze(['send-original', 'cancel', 'notify'])

/** 单条预设「工作说明」的长度上限（字符）。 */
export const MAX_INSTRUCTION_CHARS = 8000

/**
 * 解析 DSH home 目录。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * 配置文件绝对路径。
 * @param {string} [home] - 覆盖 DSH home。
 * @returns {string} 绝对路径。
 */
export function configPath(home) {
  return path.join(home ?? dshHome(), CONFIG_BASENAME)
}

/**
 * 状态文件绝对路径。
 * @param {string} [home] - 覆盖 DSH home。
 * @returns {string} 绝对路径。
 */
export function statePath(home) {
  return path.join(home ?? dshHome(), STATE_BASENAME)
}

/**
 * 默认配置。
 * @returns {object} 全新的默认配置对象。
 */
export function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    mode: 'direct',
    presetId: 'structured',
    modelRef: null,
    sendStrategy: 'auto',
    context: { maxTurns: 10, maxChars: 6000, includeAssistant: true },
    timeoutMs: 90000,
    onFailure: 'send-original',
    maxOptimizeChars: 8000,
    presets: cloneBuiltinPresets(),
  }
}

/** 整数范围归一。 */
function asInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/** 布尔归一。 */
function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 把任意读入的对象归一成合法配置（缺失字段用默认值补齐）。
 * @param {unknown} raw - 读入的原始对象。
 * @returns {object} 合法配置。
 */
export function normalizeConfig(raw) {
  const d = defaultConfig()
  const src = raw && typeof raw === 'object' ? raw : {}

  const mode = MODES.includes(src.mode) ? src.mode : d.mode
  const sendStrategy = SEND_STRATEGIES.includes(src.sendStrategy) ? src.sendStrategy : d.sendStrategy
  const onFailure = ON_FAILURES.includes(src.onFailure) ? src.onFailure : d.onFailure

  const ctxSrc = src.context && typeof src.context === 'object' ? src.context : {}
  const presets = reconcilePresets(src.presets)

  // modelRef 允许 null（表示沿用预设自带模型）或 "provider/model"
  let modelRef = null
  if (typeof src.modelRef === 'string' && src.modelRef.trim().length > 0) modelRef = src.modelRef.trim()

  // presetId 必须存在于预设列表中
  let presetId = typeof src.presetId === 'string' ? src.presetId : d.presetId
  if (!presets.some((p) => p.id === presetId)) presetId = presets[0]?.id ?? d.presetId

  return {
    version: 1,
    enabled: asBool(src.enabled, d.enabled),
    mode,
    presetId,
    modelRef,
    sendStrategy,
    context: {
      maxTurns: asInt(ctxSrc.maxTurns, d.context.maxTurns, 0, 200),
      maxChars: asInt(ctxSrc.maxChars, d.context.maxChars, 0, 200000),
      includeAssistant: asBool(ctxSrc.includeAssistant, d.context.includeAssistant),
    },
    timeoutMs: asInt(src.timeoutMs, d.timeoutMs, 3000, 600000),
    onFailure,
    maxOptimizeChars: asInt(src.maxOptimizeChars, d.maxOptimizeChars, 0, 1000000),
    presets,
  }
}/**
 * 原子写 JSON 文件。
 * @param {string} file - 目标绝对路径。
 * @param {unknown} value - 待写入的值。
 * @returns {void}
 * @throws {Error} 写入或 rename 失败时抛出。
 */
export function atomicWriteJson(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 读取配置（文件缺失或损坏时用默认值并落盘）。
 * @param {object} [options] - 选项。
 * @param {string} [options.home] - 覆盖 DSH home。
 * @param {boolean} [options.persistDefaults] - 缺失/损坏时是否把默认值写回（默认 true）。
 * @returns {object} 合法配置。
 */
export function loadConfig(options = {}) {
  const file = configPath(options.home)
  const persist = options.persistDefaults !== false
  let raw = null
  let existed = false
  try {
    const text = fs.readFileSync(file, 'utf8')
    existed = true
    raw = JSON.parse(text)
  } catch {
    raw = null
  }
  const normalized = normalizeConfig(raw)
  // 文件不存在、解析失败、或内置预设缺失需要补回时，落盘一次
  const needsWrite =
    !existed ||
    raw === null ||
    !Array.isArray(raw.presets) ||
    raw.presets.length !== normalized.presets.length ||
    JSON.stringify(raw.presets?.map((p) => p?.id)) !== JSON.stringify(normalized.presets.map((p) => p.id))
  if (persist && needsWrite) {
    try {
      atomicWriteJson(file, normalized)
    } catch {
      // 落盘失败不影响本次使用（可能是沙箱只读），交由调用方在状态里体现
    }
  }
  return normalized
}

/**
 * 深合并局部更新（数组整体替换）。
 * @param {unknown} base - 基准值。
 * @param {unknown} patch - 局部更新值。
 * @returns {unknown} 合并结果（新对象）。
 */
export function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === null) {
      out[k] = null
      continue
    }
    if (typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out
}

/**
 * 校验并应用一次局部更新。
 *
 * 与 `normalizeConfig` 的区别：这里对**显式给出的非法值直接报错**，
 * 而不是静默回退到默认值 —— 用户在设置页填错东西应当看到原因。
 *
 * @param {object} current - 当前合法配置。
 * @param {unknown} patch - 请求体中的局部更新。
 * @returns {{ ok: true, config: object } | { ok: false, error: string }} 结果。
 */
export function applyPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: '请求体必须是一个 JSON 对象' }
  }
  const p = patch

  if (p.mode !== undefined && !MODES.includes(p.mode)) {
    return { ok: false, error: `mode 只能是 ${MODES.join(' 或 ')}` }
  }
  if (p.sendStrategy !== undefined && !SEND_STRATEGIES.includes(p.sendStrategy)) {
    return { ok: false, error: `sendStrategy 只能是 ${SEND_STRATEGIES.join(' 或 ')}` }
  }
  if (p.onFailure !== undefined && !ON_FAILURES.includes(p.onFailure)) {
    return { ok: false, error: `onFailure 只能是 ${ON_FAILURES.join(' 或 ')}` }
  }
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
    return { ok: false, error: 'enabled 必须是布尔值' }
  }
  if (p.modelRef !== undefined && p.modelRef !== null) {
    if (typeof p.modelRef !== 'string') return { ok: false, error: 'modelRef 必须是字符串或 null' }
    if (p.modelRef.length > 0 && !p.modelRef.includes('/')) {
      return { ok: false, error: 'modelRef 必须是 "provider/model" 形式' }
    }
  }
  if (p.presetId !== undefined) {
    if (typeof p.presetId !== 'string') return { ok: false, error: 'presetId 必须是字符串' }
    if (!current.presets.some((x) => x.id === p.presetId)) {
      return { ok: false, error: `未知的 presetId：${p.presetId}` }
    }
  }
  if (p.timeoutMs !== undefined) {
    const n = Number(p.timeoutMs)
    if (!Number.isFinite(n) || n < 3000 || n > 600000) {
      return { ok: false, error: 'timeoutMs 必须在 3000 到 600000 之间' }
    }
  }
  if (p.maxOptimizeChars !== undefined) {
    const n = Number(p.maxOptimizeChars)
    if (!Number.isFinite(n) || n < 0 || n > 1000000) {
      return { ok: false, error: 'maxOptimizeChars 必须在 0 到 1000000 之间' }
    }
  }
  if (p.context !== undefined) {
    if (!p.context || typeof p.context !== 'object' || Array.isArray(p.context)) {
      return { ok: false, error: 'context 必须是对象' }
    }
    const c = p.context
    if (c.maxTurns !== undefined) {
      const n = Number(c.maxTurns)
      if (!Number.isFinite(n) || n < 0 || n > 200) return { ok: false, error: 'context.maxTurns 必须在 0 到 200 之间' }
    }
    if (c.maxChars !== undefined) {
      const n = Number(c.maxChars)
      if (!Number.isFinite(n) || n < 0 || n > 200000) {
        return { ok: false, error: 'context.maxChars 必须在 0 到 200000 之间' }
      }
    }
    if (c.includeAssistant !== undefined && typeof c.includeAssistant !== 'boolean') {
      return { ok: false, error: 'context.includeAssistant 必须是布尔值' }
    }
  }
  if (p.presets !== undefined) {
    if (!Array.isArray(p.presets)) return { ok: false, error: 'presets 必须是数组' }
    const seenPresetIds = new Set()
    for (const item of p.presets) {
      if (!item || typeof item !== 'object') return { ok: false, error: 'presets 的每一项都必须是对象' }
      if (typeof item.id !== 'string' || item.id.length === 0) {
        return { ok: false, error: '每个预设都需要非空的 id' }
      }
      // id 会进配置文件并作为 UI 的 key，限定字符集避免意外
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id)) {
        return { ok: false, error: `预设 id「${item.id}」不合法：只允许小写字母、数字与连字符，且以字母或数字开头` }
      }
      if (seenPresetIds.has(item.id)) return { ok: false, error: `预设 id 重复：${item.id}` }
      seenPresetIds.add(item.id)
      if (item.instruction !== undefined && typeof item.instruction !== 'string') {
        return { ok: false, error: `预设 ${item.id} 的 instruction 必须是字符串` }
      }
      if (typeof item.instruction === 'string' && item.instruction.length > MAX_INSTRUCTION_CHARS) {
        return {
          ok: false,
          error: `预设 ${item.id} 的工作说明过长（上限 ${MAX_INSTRUCTION_CHARS} 字，当前 ${item.instruction.length} 字）`,
        }
      }
      if (item.name !== undefined && typeof item.name !== 'string') {
        return { ok: false, error: `预设 ${item.id} 的 name 必须是字符串` }
      }
      if (typeof item.name === 'string' && item.name.length > 120) {
        return { ok: false, error: `预设 ${item.id} 的名称过长（上限 120 字）` }
      }
      if (item.modelRef !== undefined && item.modelRef !== null && typeof item.modelRef !== 'string') {
        return { ok: false, error: `预设 ${item.id} 的 modelRef 必须是字符串` }
      }
      if (typeof item.modelRef === 'string' && item.modelRef.length > 0 && !item.modelRef.includes('/')) {
        return { ok: false, error: `预设 ${item.id} 的 modelRef 必须是 "provider/model" 形式` }
      }
    }
  }

  const merged = deepMerge(current, p)
  // presets 需要与内置项对齐（用户可能只提交了一个预设的部分字段）
  if (Array.isArray(merged.presets)) {
    const byId = new Map()
    for (const item of p.presets ?? []) byId.set(item.id, item)
    merged.presets = reconcilePresets(
      merged.presets.map((item) => {
        const patchItem = byId.get(item.id)
        return patchItem ? { ...item, ...patchItem } : item
      }),
    )
  }
  const config = normalizeConfig(merged)
  return { ok: true, config }
}

/**
 * 读取配置、应用局部更新、原子落盘。
 * @param {unknown} patch - 局部更新。
 * @param {object} [options] - 选项。
 * @param {string} [options.home] - 覆盖 DSH home。
 * @returns {{ ok: true, config: object } | { ok: false, error: string }} 结果。
 */
export function updateConfig(patch, options = {}) {
  const current = loadConfig(options)
  const applied = applyPatch(current, patch)
  if (!applied.ok) return applied
  try {
    atomicWriteJson(configPath(options.home), applied.config)
  } catch (err) {
    return { ok: false, error: `写入配置失败：${err?.message ?? String(err)}` }
  }
  return applied
}

/**
 * 取当前生效的预设。
 * @param {object} config - 合法配置。
 * @returns {object} 预设对象。
 */
export function activePreset(config) {
  return config.presets.find((p) => p.id === config.presetId) ?? builtinPresetById('structured')
}

/**
 * 取本次调用应使用的 `provider/model`。
 * 顶层 `modelRef` 优先；否则用当前预设自带的。
 * @param {object} config - 合法配置。
 * @returns {string} `provider/model`，可能为空字符串（表示未配置）。
 */
export function effectiveModelRef(config) {
  if (typeof config.modelRef === 'string' && config.modelRef.length > 0) return config.modelRef
  return activePreset(config)?.modelRef ?? ''
}
