/**
 * 轻量 YAML 加载器。
 *
 * 为什么要这个模块：插件是以 `link:` 方式挂进 profile 的，其**实体位于 profile 之外**，
 * 因此 Node 会按真实路径解析 —— 裸 `import 'js-yaml'` 会 ERR_MODULE_NOT_FOUND
 * （这一现象已由探针实测证实，见 docs/03-probe-report.md §3）。
 *
 * 策略（三级回退，任一级成功即返回）：
 *   1. 裸导入 `js-yaml`（插件被拷贝安装进 profile 时可用）
 *   2. 从 DSH 安装目录按绝对路径导入 `js-yaml`（本机路径，实测可用）
 *   3. 内置最小解析器 —— 只覆盖 DSH 配置文件实际使用的 YAML 子集：
 *      顶层 `key:` 缩进映射、块序列 `- `、以及流式（`{...}` / `[...]`）集合。
 *      流式部分先做「无引号键加引号、去尾逗号、单引号转双引号」的规范化，再交给 JSON.parse。
 *
 * 本模块不修改任何文件，且**不记录任何可能含密钥的内容**。
 *
 * @module dsh-prompt-optimizer/lib/yaml
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

/** 可能的 DSH 安装根候选（用于定位随 CLI 一起安装的依赖）。 */
function dshInstallCandidates() {
  const out = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p)
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  // 本机已知路径：npm 全局 node_modules 下的 CLI
  const appData = process.env.APPDATA
  if (appData) push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  push(path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh'))
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh')
  push('/usr/lib/node_modules/@deepseek-ai/dsh')
  return out
}

/** 解析出的 js-yaml 模块（缓存，避免重复尝试）。 */
let jsYamlCache
/** 是否已经尝试过解析 js-yaml。 */
let jsYamlProbed = false

/**
 * 尝试取得 js-yaml 模块。
 * @returns {Promise<object | null>} 模块或 null（全部失败）。
 */
async function loadJsYaml() {
  if (jsYamlProbed) return jsYamlCache
  jsYamlProbed = true

  // 一级：裸导入
  try {
    jsYamlCache = await import('js-yaml')
    if (typeof jsYamlCache?.load === 'function') return jsYamlCache
  } catch {
    // 预期会失败（link: 安装），继续回退
  }

  // 二级：从 DSH 安装目录按绝对路径导入
  for (const root of dshInstallCandidates()) {
    const file = path.join(root, 'node_modules', 'js-yaml', 'dist', 'js-yaml.mjs')
    if (!fs.existsSync(file)) continue
    try {
      const mod = await import(pathToFileURL(file).href)
      if (typeof mod?.load === 'function') {
        jsYamlCache = mod
        return mod
      }
    } catch {
      // 换下一个候选
    }
  }

  jsYamlCache = null
  return null
}

/**
 * 去掉 YAML 注释（保持引号内的 `#`、流式结构内部、以及 URL 完整）。
 *
 * 为什么不能简单地按 `#` 截断：DSH 的 settings.yaml 里有形如
 * `baseURL: https://ark.cn-beijing.volces.com/api/coding/v3,` 的行 ——
 * `//` 必须原样保留。因此用「结构深度 + 引号状态」双状态机：
 * 只有在深度为 0（不在任何 `{}`/`[]` 内）且不在引号内时，`#` 才可能是注释。
 *
 * @param {string} line - 原始行。
 * @returns {string} 去注释后的行。
 */
function stripComment(line) {
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1)
      else if (ch === '#' && depth === 0) {
        if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i)
      }
    }
  }
  return line
}

/**
 * 把流式上下文里的裸标量转成 JSON 片段。
 *
 * YAML 的裸标量只有 `true` / `false` / `null` / `~` 与数字会保持原类型，
 * 其余一律是字符串（因此需要加引号）。
 * @param {string} token - 裸标量文本。
 * @returns {string} JSON 片段。
 */
function coerceBare(token) {
  if (token === 'true' || token === 'false' || token === 'null') return token
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return token
  return JSON.stringify(token)
}

/**
 * 把 YAML 流式集合规范化为严格 JSON 文本。
 *
 * DSH 的 settings.yaml 使用 YAML 流式风格写 provider 配置，特点是：
 * 无引号键、无引号标量值、允许尾逗号、可用单引号。
 * 本函数逐字符扫描（跳过字符串内部），在结构位置补引号并去掉尾逗号。
 * @param {string} text - 规范化后的流式文本（`{...}` / `[...]`，可能跨行）。
 * @returns {string} 严格 JSON 文本。
 */
function flowToJson(text) {
  let out = ''
  let i = 0
  const n = text.length
  // 期望值的上下文：回溯到最后一个非空白字符，判断它是否是分隔符。
  // （不能直接把正则作用于 out —— 冒号后的空格会被算进来，导致判断失效。）
  const isValueStart = () => {
    let k = out.length - 1
    while (k >= 0 && /\s/.test(out[k])) k--
    if (k < 0) return true
    const c = out[k]
    return c === ':' || c === ',' || c === '{' || c === '['
  }
  while (i < n) {
    const ch = text[i]

    // 字符串：原样搬运（单引号转双引号并转义）
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') j += 2
        else if (text[j] === '"') break
        else j++
      }
      out += text.slice(i, Math.min(j + 1, n))
      i = j + 1
      continue
    }
    if (ch === "'") {
      let j = i + 1
      let buf = ''
      while (j < n) {
        if (text[j] === "'" && text[j + 1] === "'") {
          buf += "'"
          j += 2
          continue
        }
        if (text[j] === "'") break
        buf += text[j]
        j++
      }
      out += JSON.stringify(buf)
      i = j + 1
      continue
    }

    // 结构字符
    if (ch === '{' || ch === '[' || ch === '}' || ch === ']' || ch === ':' || ch === ',') {
      out += ch
      i++
      continue
    }

    if (/\s/.test(ch)) {
      out += ch
      i++
      continue
    }

    // 裸标量：读到「结构分隔符」为止。
    //
    // 关键细节：`:` 只有在其后是空白或结构字符时才算「键分隔符」。
    // 否则 `https://host/path` 会被从 `https` 处切断（这正是需要避免的）。
    //
    // 另一个关键细节：连续多个裸 token（`火山 Coding Plan`）是**一个**标量，
    // 必须用空格原样拼接，不能各自加引号。
    let j = i
    while (j < n) {
      const c = text[j]
      if (c === ',' || c === '{' || c === '}' || c === '[' || c === ']') break
      if (c === ':') {
        const next = text[j + 1]
        if (next === undefined || /[\s,{}[\]]/.test(next)) break
      }
      j++
    }
    // token 内部可能含空白（多词标量），整体作为一个值
    const token = text.slice(i, j).trim()
    i = j

    // 位于键位置的裸标量 → 加引号
    const tail = out.replace(/\s+$/, '')
    const atKeyPos = tail.length === 0 || tail.endsWith('{') || tail.endsWith(',')
    if (atKeyPos) {
      // 向后看：若下一个非空白字符是 ':'，说明这是键
      let k = i
      while (k < n && /\s/.test(text[k])) k++
      if (text[k] === ':') {
        out += JSON.stringify(token)
        continue
      }
    }

    // 值位置的裸标量 → 加引号（保持字符串语义），但数字与布尔/null 保持原类型
    if (isValueStart()) {
      out += coerceBare(token)
      continue
    }
    out += coerceBare(token)
  }
  // 去尾逗号
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * 内置最小 YAML 解析器（js-yaml 不可用时的兜底）。
 *
 * 支持的子集：顶层缩进映射、块序列、流式集合、行内注释。
 * 不支持：锚点/别名、多文档、复杂多行标量、标签。
 * @param {string} text - YAML 文本。
 * @returns {unknown} 解析结果。
 */
export function parseMinimalYaml(text) {
  const rawLines = String(text).split(/\r?\n/)
  const lines = []
  for (const raw of rawLines) {
    const stripped = stripComment(raw)
    if (stripped.trim().length === 0) continue
    const indent = stripped.length - stripped.trimStart().length
    lines.push({ indent, text: stripped.trim(), raw: stripped })
  }
  let cursor = 0
  return parseBlock(0)

  /** 解析一个缩进层级下的块（映射或序列）。 */
  function parseBlock(minIndent) {
    if (cursor >= lines.length) return null
    const first = lines[cursor]
    if (first.indent < minIndent) return null

    // 流式集合作为**值**出现在更深缩进处（`providers:` 换行后接 `{`）：
    // 必须整体交给 parseFlow —— 否则 `{` 行既不匹配映射也不匹配序列，
    // 会被当成无法识别的行跳过，得到一个空容器。
    if (first.text.startsWith('{') || first.text.startsWith('[')) return parseFlowValue()

    const isSeq = first.text === '-' || first.text.startsWith('- ')
    const container = isSeq ? [] : {}
    const baseIndent = first.indent

    while (cursor < lines.length) {
      const line = lines[cursor]
      if (line.indent < baseIndent) break
      if (line.indent > baseIndent) {
        // 意外缩进：跳过，避免死循环
        cursor++
        continue
      }

      if (isSeq) {
        if (!(line.text === '-' || line.text.startsWith('- '))) break
        const rest = line.text.slice(1).trim()
        cursor++
        if (rest.length === 0) {
          container.push(parseBlock(baseIndent + 1))
          continue
        }
        if (rest.startsWith('{') || rest.startsWith('[')) {
          container.push(parseFlowValue(rest))
          continue
        }
        // `- key: value` 形式（序列项本身是映射）
        const m = /^([^:]+):(.*)$/.exec(rest)
        if (m) {
          const obj = {}
          const key = unquote(m[1].trim())
          const headValue = m[2].trim()
          obj[key] = headValue.length === 0 ? parseBlock(baseIndent + 1) : parseScalar(headValue)
          // 吸收同项内的后续键（缩进比 `-` 更深）
          while (cursor < lines.length && lines[cursor].indent > baseIndent) {
            const sub = lines[cursor]
            const sm = /^([^:]+):(.*)$/.exec(sub.text)
            if (!sm) break
            const skey = unquote(sm[1].trim())
            const sval = sm[2].trim()
            const subIndent = sub.indent
            cursor++
            obj[skey] = sval.length === 0 ? parseBlock(subIndent + 1) : parseScalar(sval)
          }
          container.push(obj)
          continue
        }
        container.push(parseScalar(rest))
        continue
      }

      // 映射
      const m = /^([^:]+):(.*)$/.exec(line.text)
      if (!m) {
        cursor++
        continue
      }
      const key = unquote(m[1].trim())
      const valueText = m[2].trim()
      const keyIndent = line.indent
      cursor++
      if (valueText.length === 0) {
        const next = lines[cursor]
        if (next && next.indent > keyIndent) container[key] = parseBlock(next.indent)
        else if (next && next.indent === keyIndent && (next.text === '-' || next.text.startsWith('- '))) {
          container[key] = parseBlock(keyIndent)
        } else container[key] = null
      } else {
        container[key] = parseScalar(valueText)
      }
    }
    return container
  }

  /**
   * 收集并解析一个（可能跨行的）流式集合。
   *
   * `bare` 给出时表示当前行本身不含集合文本（如 `- ` 之后换行），
   * 此时从下一行开始吃。
   * @param {string | null} [bare] - 行内已有的集合起始文本。
   * @returns {unknown} 解析结果。
   */
  function parseFlowValue(bare = null) {
    let buf = ''
    if (typeof bare === 'string' && bare.length > 0) {
      buf = bare
      cursor++
    }
    // 逐行补齐，直到最外层容器闭合
    while (cursor < lines.length && !isFlowClosed(buf)) {
      buf += (buf.length > 0 ? ' ' : '') + lines[cursor].text
      cursor++
    }
    try {
      return JSON.parse(flowToJson(buf))
    } catch {
      return null
    }
  }

  /**
   * 判断流式文本的最外层容器是否已关闭。
   *
   * 不能简单数括号配平：`https://…` 里没有括号，但初值为空串时深度会保持 0，
   * 因此必须等到「出现并关闭过一层容器」才算闭合。
   * @param {string} s - 流式文本。
   * @returns {boolean} 是否已闭合。
   */
  function isFlowClosed(s) {
    if (typeof s !== 'string' || s.length === 0) return false
    const normalized = flowToJson(s)
    let depth = 0
    let sawOpen = false
    let inD = false
    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i]
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '"') {
        inD = !inD
        continue
      }
      if (inD) continue
      if (ch === '{' || ch === '[') {
        depth++
        sawOpen = true
      } else if (ch === '}' || ch === ']') {
        depth--
        if (sawOpen && depth === 0) return true
      }
    }
    return false
  }

  /** 解析标量。 */
  function parseScalar(text) {
    const t = text.trim()
    if (t.startsWith('{') || t.startsWith('[')) return parseFlow(t)
    if (t === 'null' || t === '~') return null
    if (t === 'true') return true
    if (t === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    return unquote(t)
  }

  /** 去掉可能的包裹引号。 */
  function unquote(t) {
    if (t.length >= 2) {
      if ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) return t.slice(1, -1)
    }
    return t
  }
}

/**
 * 解析 YAML 文本（优先 js-yaml，失败则回退内置解析器）。
 * @param {string} text - YAML 文本。
 * @returns {Promise<unknown>} 解析结果。
 */
export async function parseYaml(text) {
  const mod = await loadJsYaml()
  if (mod) {
    try {
      return mod.load(text)
    } catch {
      // 落到内置解析器
    }
  }
  return parseMinimalYaml(text)
}

/**
 * 读取并解析一个 YAML 文件。
 * @param {string} filePath - 文件绝对路径。
 * @returns {Promise<unknown | null>} 解析结果；文件不存在或不可读时返回 null。
 */
export async function readYamlFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    return await parseYaml(text)
  } catch {
    return null
  }
}

/** 当前使用的 YAML 实现（用于自检与排障，不含敏感信息）。 */
export async function yamlBackend() {
  const mod = await loadJsYaml()
  return mod ? 'js-yaml' : 'builtin'
}

export { flowToJson }
