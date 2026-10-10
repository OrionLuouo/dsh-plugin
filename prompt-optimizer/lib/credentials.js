/**
 * 凭据解析：从 `DSH_HOME/.credentials.yaml` 的 `refs:` 段取 API 密钥。
 *
 * 硬性隐私约束：
 * - **密钥绝不写入插件自有文件**（配置、状态、日志都不写）。
 * - **密钥绝不回传前端**：HTTP 响应里只出现 provider 名与「是否已配置」布尔值。
 * - 排障输出一律经过 {@link maskKey}，只留头尾各 4 个字符。
 *
 * 解析顺序：`refs[apiKeyEnv]` → 进程环境变量 `apiKeyEnv`。
 * 后者是官方推荐的部署方式（见 llm-deepseek 的报错文案：
 * "store <ref> through the credentials service ..., or export <ref> in the launching environment"）。
 *
 * @module dsh-prompt-optimizer/lib/credentials
 */
import { readYamlFile } from './yaml.js'
import { dshHome } from './config.js'
import path from 'node:path'

/** 凭据文件名。 */
export const CREDENTIALS_BASENAME = '.credentials.yaml'

/**
 * 凭据文件绝对路径。
 * @param {string} [home] - 覆盖 DSH home。
 * @returns {string} 绝对路径。
 */
export function credentialsPath(home) {
  return path.join(home ?? dshHome(), CREDENTIALS_BASENAME)
}

/**
 * 把密钥掩码成可安全打印的形式。
 * @param {unknown} key - 原始密钥。
 * @returns {string} 掩码文本。
 */
export function maskKey(key) {
  const s = typeof key === 'string' ? key : ''
  if (s.length === 0) return '(empty)'
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`
  return `${s.slice(0, 4)}***${s.slice(-4)}`
}

/**
 * 读取凭据文件里的 `refs` 映射。
 * @param {object} [options] - 选项。
 * @param {string} [options.home] - 覆盖 DSH home。
 * @returns {Promise<Record<string, string> | null>} refs 映射；文件缺失或格式异常时返回 null。
 */
export async function readRefs(options = {}) {
  const parsed = await readYamlFile(credentialsPath(options.home))
  if (!parsed || typeof parsed !== 'object') return null
  const refs = parsed.refs
  if (!refs || typeof refs !== 'object') return null
  const out = Object.create(null)
  for (const [k, v] of Object.entries(refs)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return out
}

/**
 * 凭据解析器：缓存文件读取结果，支持显式失效以响应外部改动。
 */
export class Credentials {
  /**
   * @param {object} [options] - 选项。
   * @param {string} [options.home] - 覆盖 DSH home。
   */
  constructor(options = {}) {
    this.home = options.home
    /** @type {Record<string,string> | null} */
    this.refs = null
    /** @type {Promise<Record<string,string>|null> | null} */
    this.loading = null
  }

  /**
   * 载入（或重新载入）凭据文件。
   * @returns {Promise<Record<string, string> | null>} refs 映射。
   */
  async load() {
    if (this.loading) return this.loading
    this.loading = readRefs({ home: this.home })
      .then((refs) => {
        this.refs = refs
        this.loading = null
        return refs
      })
      .catch(() => {
        this.refs = null
        this.loading = null
        return null
      })
    return this.loading
  }

  /** 丢弃缓存，下次解析重新读盘（让用户在设置页改了密钥后无需重启）。 */
  invalidate() {
    this.refs = null
    this.loading = null
  }

  /**
   * 按 provider 的 `apiKeyEnv` 解析密钥。
   * @param {string} refName - 凭据引用名（例如 `VOLCENGINE_CODING_PLAN_API_KEY`）。
   * @returns {Promise<{ key: string | null, source: 'credentials' | 'env' | 'none' }>} 解析结果。
   */
  async resolve(refName) {
    const name = typeof refName === 'string' ? refName.trim() : ''
    if (name.length === 0) return { key: null, source: 'none' }

    if (this.refs === null) await this.load()
    const fromFile = this.refs?.[name]
    if (typeof fromFile === 'string' && fromFile.length > 0) {
      return { key: fromFile, source: 'credentials' }
    }

    const fromEnv = process.env[name]
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
      return { key: fromEnv, source: 'env' }
    }

    return { key: null, source: 'none' }
  }

  /**
   * 批量检查哪些引用已就绪（**不返回密钥本身**，可安全回传前端）。
   * @param {string[]} refNames - 引用名列表。
   * @returns {Promise<Record<string, boolean>>} 引用名 → 是否已配置。
   */
  async availability(refNames) {
    /** @type {Record<string, boolean>} */
    const out = Object.create(null)
    for (const name of new Set(refNames.filter((x) => typeof x === 'string' && x.length > 0))) {
      const { key } = await this.resolve(name)
      out[name] = typeof key === 'string' && key.length > 0
    }
    return out
  }
}
