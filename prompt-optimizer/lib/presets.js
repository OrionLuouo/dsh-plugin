/**
 * 内置预设：每个预设 = 一个已接入模型引用 + 一段「工作说明」。
 *
 * 这些文本是接口冻结内容（见 docs/02-api.md §3），正式实现以此为准。
 * `builtin: true` 的预设可以被用户编辑或停用，但若被删除会在下次启动时按 id 恢复，
 * 避免误删导致插件不可用。
 *
 * @module dsh-prompt-optimizer/lib/presets
 */

/** 结构化重写预设的工作说明。 */
const INSTRUCTION_STRUCTURED = `你是提示词工程专家。请把用户的最新输入改写为一条更高质量的提示词。

要求：
1. 保留用户的全部原始意图与约束，不新增用户未提出的需求。
2. 明确任务类型（问答／分析／编码／写作／翻译等）与期望的输出形态。
3. 把含糊的表述具体化：补全缺失的上下文、对象、范围与验收标准。
4. 如用户在历史对话中已有明确偏好或约束，应在新提示词中体现。
5. 语言与用户输入保持一致。
6. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。`

/** 精简明确预设的工作说明。 */
const INSTRUCTION_CONCISE = `你是提示词工程专家。请把用户的最新输入改写为一条简洁、无歧义、可直接执行的提示词。

要求：
1. 删除冗余寒暄、重复表述与无关背景，但不得删掉任何实质约束。
2. 一句话能说清就不写两句话；优先使用明确的动词与可核查的目标。
3. 保留用户的全部原始意图。
4. 语言与用户输入保持一致。
5. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。`

/** 编码任务专用预设的工作说明。 */
const INSTRUCTION_CODING = `你是资深软件工程师兼提示词工程专家。请把用户的最新输入改写为一条面向编码任务的高质量提示词。

要求：
1. 明确目标代码库／文件范围、当前行为与期望行为。
2. 明确技术栈、运行环境与约束（语言版本、依赖限制、兼容性要求）。
3. 明确验收标准：改完后如何验证（命令、测试、可观察结果）。
4. 指出已知的坑与不可破坏的既有行为。
5. 不改写用户的技术选型，只把需求表达具体化。
6. 语言与用户输入保持一致。
7. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。`

/** 分析研究专用预设的工作说明。 */
const INSTRUCTION_ANALYSIS = `你是研究分析专家。请把用户的最新输入改写为一条结构化的分析型提示词。

要求：
1. 明确分析对象、分析目的与决策用途。
2. 明确需要覆盖的维度与希望得到的结论形态（对比表／优劣清单／建议方案等）。
3. 明确已知前提、待验证假设与信息缺口。
4. 要求给出依据与不确定性说明，而非只给结论。
5. 语言与用户输入保持一致。
6. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。`

/** 保守润色预设的工作说明。 */
const INSTRUCTION_FAITHFUL = `你是细心的文字编辑。请对用户的最新输入做最小必要的改写，使其表达清晰、无歧义。

要求：
1. 严格保持原意、原有语气与原有详细程度，不做任何扩写或收缩。
2. 只修正语法、标点、指代不明与歧义表述。
3. 不添加用户没有提出的要求、约束或验收标准。
4. 语言与用户输入保持一致。
5. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。`

/**
 * 内置预设定义（顺序即 UI 中的默认展示顺序）。
 * `modelRef` 为 `provider/model` 形式，取自本机已接入的 provider。
 */
export const BUILTIN_PRESETS = Object.freeze([
  Object.freeze({
    id: 'structured',
    name: '结构化重写',
    modelRef: 'volcengine-coding-plan/doubao-seed-2.1-pro',
    instruction: INSTRUCTION_STRUCTURED,
    builtin: true,
  }),
  Object.freeze({
    id: 'concise',
    name: '精简明确',
    modelRef: 'volcengine-agent-plan/glm-5.3',
    instruction: INSTRUCTION_CONCISE,
    builtin: true,
  }),
  Object.freeze({
    id: 'coding',
    name: '编码任务专用',
    modelRef: 'volcengine-coding-plan/doubao-seed-2.1-pro',
    instruction: INSTRUCTION_CODING,
    builtin: true,
  }),
  Object.freeze({
    id: 'analysis',
    name: '分析研究专用',
    modelRef: 'volcengine-agent-plan/glm-5.3',
    instruction: INSTRUCTION_ANALYSIS,
    builtin: true,
  }),
  Object.freeze({
    id: 'faithful',
    name: '保守润色',
    modelRef: 'deepseek-official/deepseek-flash',
    instruction: INSTRUCTION_FAITHFUL,
    builtin: true,
  }),
])

/** 内置预设 id 集合。 */
export const BUILTIN_PRESET_IDS = Object.freeze(BUILTIN_PRESETS.map((p) => p.id))

/**
 * 深拷贝内置预设（用户配置中需要可变副本）。
 * @returns {object[]} 可变的预设数组副本。
 */
export function cloneBuiltinPresets() {
  return BUILTIN_PRESETS.map((p) => ({ ...p }))
}

/**
 * 按 id 查内置预设。
 * @param {string} id - 预设 id。
 * @returns {object | undefined} 预设定义。
 */
export function builtinPresetById(id) {
  return BUILTIN_PRESETS.find((p) => p.id === id)
}

/**
 * 把用户配置里的预设列表与内置预设对齐：
 * 保留用户的编辑，补回被删除的内置项（追加在末尾）。
 * @param {unknown} userPresets - 用户配置中的 presets 字段。
 * @returns {object[]} 对齐后的预设数组。
 */
export function reconcilePresets(userPresets) {
  const user = Array.isArray(userPresets) ? userPresets.filter((p) => p && typeof p === 'object') : []
  const seen = new Set()
  const out = []
  for (const p of user) {
    const id = typeof p.id === 'string' && p.id.length > 0 ? p.id : null
    if (!id || seen.has(id)) continue
    seen.add(id)
    const base = builtinPresetById(id)
    out.push({
      id,
      name: typeof p.name === 'string' && p.name.length > 0 ? p.name : (base?.name ?? id),
      modelRef: typeof p.modelRef === 'string' ? p.modelRef : (base?.modelRef ?? ''),
      instruction: typeof p.instruction === 'string' ? p.instruction : (base?.instruction ?? ''),
      builtin: base !== undefined,
    })
  }
  for (const base of BUILTIN_PRESETS) {
    if (seen.has(base.id)) continue
    out.push({ ...base })
  }
  return out
}
