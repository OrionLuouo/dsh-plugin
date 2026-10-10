/**
 * 模型目录：把 DSH 已接入的 provider / 模型整理成可选的「优化模型」清单。
 *
 * 数据来源（按优先级合并，越靠前越优先）：
 *   1. `DSH_HOME/settings.yaml` 里以 `providers:` 声明端点的 LLM 插件配置
 *      （本机是 `llm-pi-ai`，含 baseURL / api / apiKeyEnv / models）
 *   2. 同上文件里以 `models:` 声明内置端点的插件配置
 *      （本机是 `llm-deepseek`，端点与密钥引用来自下面的内置目录）
 *   3. 内置目录（把已知的官方 provider 路由映射到端点与密钥引用）
 *
 * 协议支持：只有 `api` 为 `openai-completions`（或未声明 `api` 的内置路由）时标记 `supported: true`。
 * 其余协议**不猜**，标记 `supported: false` 并给出可读原因，UI 上置灰。
 *
 * @module dsh-prompt-optimizer/lib/catalog
 */
import path from 'node:path'
import { readYamlFile } from './yaml.js'
import { dshHome } from './config.js'

/** settings.yaml 基名。 */
export const SETTINGS_BASENAME = 'settings.yaml'

/**
 * 内置 provider 目录：已知的官方 provider 路由 → 端点与密钥引用。
 * 仅在这些插件没有在 settings.yaml 里显式声明 `providers:` 时使用。
 */
export const BUILTIN_PROVIDERS = Object.freeze({
  'deepseek-official': Object.freeze({
    displayName: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com',
    api: 'openai-completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  }),
})

/** 我们支持的请求协议。 */
const SUPPORTED_APIS = Object.freeze(['openai-completions'])

/**
 * settings.yaml 绝对路径。
 * @param {string} [home] - 覆盖 DSH home。
 * @returns {string} 绝对路径。
 */
export function settingsPath(home) {
  return path.join(home ?? dshHome(), SETTINGS_BASENAME)
}

/**
 * 从 settings.yaml 抽出 provider 候选。
 * @param {unknown} parsed - 解析后的 settings 对象。
 * @returns {{ explicit: object[], modelOnly: object[] }} 两类候选。
 */
function extractFromSettings(parsed) {
  /** @type {object[]} */
  const explicit = []
  /** @type {object[]} */
  const modelOnly = []
  if (!parsed || typeof parsed !== 'object') return { explicit, modelOnly }

  for (const [ns, section] of Object.entries(parsed)) {
    if (!ns.startsWith('llm-')) continue
    if (!section || typeof section !== 'object') continue

    // 形态一：显式声明 providers 映射（llm-pi-ai）
    const providers = section.providers
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      for (const [id, def] of Object.entries(providers)) {
        if (!def || typeof def !== 'object') continue
        const models = Array.isArray(def.models) ? def.models : []
        explicit.push({
          provider: id,
          displayName: typeof def.displayName === 'string' && def.displayName.length > 0 ? def.displayName : id,
          baseURL: typeof def.baseURL === 'string' ? def.baseURL : '',
          api: typeof def.api === 'string' ? def.api : 'openai-completions',
          apiKeyEnv: typeof def.apiKeyEnv === 'string' ? def.apiKeyEnv : '',
          models: models
            .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id.length > 0)
            .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id })),
          source: ns,
        })
      }
    }

    // 形态二：只声明 models（llm-deepseek 这类内置端点的插件）
    const models = section.models
    if (Array.isArray(models) && models.length > 0) {
      modelOnly.push({
        source: ns,
        models: models
          .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id.length > 0)
          .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id })),
        baseURL: typeof section.baseURL === 'string' ? section.baseURL : '',
        api: typeof section.api === 'string' ? section.api : '',
        apiKeyEnv: typeof section.apiKeyEnv === 'string' ? section.apiKeyEnv : '',
      })
    }
  }
  return { explicit, modelOnly }
}

/**
 * 把候选整理成最终的分组目录。
 * @param {{ explicit: object[], modelOnly: object[] }} extracted - 抽取结果。
 * @param {object} [options] - 选项。
 * @param {string} [options.defaultModelRef] - DSH 的默认模型（用于回落）。
 * @param {(provider: string) => string} [options.fallbackForKey] - 由内置目录给出密钥引用。
 * @returns {{ groups: object[], defaultModelRef: string }} 目录。
 */
function buildGroups(extracted, options = {}) {
  /** @type {Map<string, object>} */
  const byProvider = new Map()

  // 形态一优先（显式端点）
  for (const item of extracted.explicit) {
    if (byProvider.has(item.provider)) continue
    byProvider.set(item.provider, item)
  }

  // 形态二：尝试用内置目录补全端点
  for (const item of extracted.modelOnly) {
    // 内置目录的键就是 provider 路由名；插件名形如 llm-deepseek，需要映射
    const guesses = Object.keys(BUILTIN_PROVIDERS)
    for (const provider of guesses) {
      if (byProvider.has(provider)) continue
      const builtin = BUILTIN_PROVIDERS[provider]
      // 只在插件命名空间与 provider 名字明显相关时采用，避免张冠李戴
      const ns = item.source.replace(/^llm-/, '')
      const providerTail = provider.replace(/-official$/, '')
      if (!(provider.includes(ns) || ns.includes(providerTail))) continue
      byProvider.set(provider, {
        provider,
        displayName: builtin.displayName,
        baseURL: item.baseURL || builtin.baseURL,
        api: item.api || builtin.api,
        apiKeyEnv: item.apiKeyEnv || builtin.apiKeyEnv,
        models: item.models,
        source: item.source,
      })
    }
  }

  const groups = []
  for (const group of byProvider.values()) {
    const supported = SUPPORTED_APIS.includes(group.api)
    groups.push({
      provider: group.provider,
      displayName: group.displayName,
      baseURL: group.baseURL,
      api: group.api,
      apiKeyEnv: group.apiKeyEnv,
      models: group.models,
      supported,
      error: supported
        ? null
        : `暂不支持的请求协议 「${group.api || '未声明'}」，本插件目前只支持 openai-completions`,
    })
  }

  groups.sort((a, b) => a.provider.localeCompare(b.provider))

  // 默认模型：优先取 DSH 默认模型所在分组里的模型
  let defaultModelRef = ''
  const want = typeof options.defaultModelRef === 'string' ? options.defaultModelRef : ''
  if (want.includes('/')) {
    const [p, m] = want.split('/', 2)
    const g = groups.find((x) => x.provider === p && x.models.some((mm) => mm.id === m))
    if (g) defaultModelRef = `${p}/${m}`
    else if (groups.some((x) => x.provider === p)) defaultModelRef = `${p}/${groups.find((x) => x.provider === p).models[0]?.id ?? ''}`
  }
  if (!defaultModelRef) {
    const first = groups.find((g) => g.supported && g.models.length > 0)
    if (first) defaultModelRef = `${first.provider}/${first.models[0].id}`
  }

  return { groups, defaultModelRef }
}

/**
 * 构建模型目录。
 * @param {object} [options] - 选项。
 * @param {string} [options.home] - 覆盖 DSH home。
 * @param {string} [options.defaultModelRef] - DSH 默认模型（`provider/model`）。
 * @returns {Promise<{ groups: object[], defaultModelRef: string, source: string, available: boolean }>} 目录。
 */
export async function buildCatalog(options = {}) {
  const parsed = await readYamlFile(settingsPath(options.home))
  const extracted = extractFromSettings(parsed)
  const { groups, defaultModelRef } = buildGroups(extracted, options)
  const available = groups.length > 0
  return {
    groups,
    defaultModelRef,
    source: available ? 'settings.yaml' : 'empty',
    available,
  }
}

/**
 * 把 `provider/model` 解析成调用所需的端点信息。
 * @param {object} catalog - {@link buildCatalog} 的结果。
 * @param {string} modelRef - `provider/model`。
 * @returns {{ ok: true, provider: string, model: string, baseURL: string, api: string, apiKeyEnv: string, displayName: string }
 *          | { ok: false, error: string }} 解析结果。
 */
export function resolveModelRef(catalog, modelRef) {
  const ref = typeof modelRef === 'string' ? modelRef.trim() : ''
  if (ref.length === 0) return { ok: false, error: '未选择优化模型' }
  const idx = ref.indexOf('/')
  if (idx <= 0 || idx === ref.length - 1) {
    return { ok: false, error: `优化模型引用格式应为 "provider/model"，收到：${ref}` }
  }
  const provider = ref.slice(0, idx)
  const model = ref.slice(idx + 1)

  const group = catalog?.groups?.find((g) => g.provider === provider)
  if (!group) return { ok: false, error: `未找到已接入的 provider：${provider}` }
  if (!group.supported) return { ok: false, error: group.error ?? `provider ${provider} 暂不支持` }
  if (group.models.length > 0 && !group.models.some((m) => m.id === model)) {
    // 模型目录是「建议性」的（官方 API 文档如此描述），因此只提示不阻断
    // 但为了可预测性，这里仍按错误处理，由上层决定是否放宽
    return { ok: false, error: `provider ${provider} 下未列出模型：${model}` }
  }
  if (!group.baseURL) return { ok: false, error: `provider ${provider} 没有可用的 baseURL` }

  return {
    ok: true,
    provider,
    model,
    baseURL: group.baseURL,
    api: group.api,
    apiKeyEnv: group.apiKeyEnv,
    displayName: group.displayName,
  }
}

/**
 * 给目录补充「密钥是否已配置」（**不返回密钥本身**，可安全回传前端）。
 * @param {object} catalog - {@link buildCatalog} 的结果。
 * @param {{ availability: (refs: string[]) => Promise<Record<string, boolean>> }} credentials - 凭据解析器。
 * @returns {Promise<object>} 补充后的目录（新对象）。
 */
export async function annotateAvailability(catalog, credentials) {
  const refs = catalog.groups.map((g) => g.apiKeyEnv).filter((x) => typeof x === 'string' && x.length > 0)
  let avail = {}
  try {
    avail = await credentials.availability(refs)
  } catch {
    avail = {}
  }
  return {
    ...catalog,
    groups: catalog.groups.map((g) => ({
      ...g,
      keyConfigured: typeof g.apiKeyEnv === 'string' && g.apiKeyEnv.length > 0 ? avail[g.apiKeyEnv] === true : false,
    })),
  }
}
