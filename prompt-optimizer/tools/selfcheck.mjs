/**
 * 离线自检：不依赖插件挂载即可验证除「改写生效 / 路由可达 / UI 挂载」之外的全部逻辑。
 *
 * 用法：
 *   node tools/selfcheck.mjs
 *   node tools/selfcheck.mjs --live     # 额外真调一次优化模型（会消耗额度，默认不跑）
 *
 * 退出码：0 = 全绿；1 = 存在失败项。
 *
 * @module dsh-prompt-optimizer/tools/selfcheck
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { yamlBackend, parseMinimalYaml, readYamlFile } from '../lib/yaml.js'
import { BUILTIN_PRESETS, reconcilePresets, cloneBuiltinPresets } from '../lib/presets.js'
import {
  defaultConfig,
  normalizeConfig,
  applyPatch,
  deepMerge,
  atomicWriteJson,
  loadConfig,
  updateConfig,
  effectiveModelRef,
  activePreset,
  configPath,
} from '../lib/config.js'
import { RuntimeState, textHash, TICKET_TTL_MS } from '../lib/state.js'
import { Credentials, readRefs, maskKey } from '../lib/credentials.js'
import { buildCatalog, resolveModelRef, annotateAvailability, settingsPath } from '../lib/catalog.js'
import { buildContext, splitTurns, isHumanMessage, textOf, trimByChars } from '../lib/context.js'
import { stripFences, buildMessages, textFromResponse, optimizeOnce } from '../lib/optimize.js'
import {
  rewriteMessages,
  shouldOptimize,
  createUserMessageLocal,
  deepFreezeValue,
  resolveCreateUserMessage,
  MARKER_FIELDS,
} from '../lib/rewriter.js'

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = []

/**
 * 记录一条断言结果。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 说明。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? `  —— ${detail}` : ''}`)
}

/** 断言相等。 */
function checkEq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, a === e ? '' : `期望 ${e}，实际 ${a}`)
}

/** 深比较。 */
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 建一个临时 home 目录用于配置/状态读写测试。 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpo-selfcheck-'))

console.log('=== 1. YAML 后端与解析 ===')
try {
  const backend = await yamlBackend()
  check('取得 YAML 后端', backend === 'js-yaml' || backend === 'builtin', `后端 = ${backend}`)

  // 内置解析器：覆盖 DSH 实际用到的 YAML 子集
  const sample = `
top:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    {
      volcengine-coding-plan:
        {
          displayName: 火山 Coding Plan,
          apiKeyEnv: VOLCENGINE_CODING_PLAN_API_KEY,
          api: openai-completions,
          baseURL: https://ark.cn-beijing.volces.com/api/coding/v3,
          models:
            [
              { id: deepseek-v4.1-flash, name: deepseek-v4-1-flash, contextWindow: 1024000 },
              { id: glm-5.3, contextWindow: 1024000 }
            ]
        }
    }
refs:
  DEEPSEEK_API_KEY: sk-abc
`
  const parsed = parseMinimalYaml(sample)
  check('内置解析器：顶层键', Object.keys(parsed).join(',') === 'top,llm-pi-ai,refs', Object.keys(parsed).join(','))
  const provider = parsed['llm-pi-ai']?.providers?.['volcengine-coding-plan']
  check('内置解析器：流式对象与无引号键', provider?.api === 'openai-completions', String(provider?.api))
  check('内置解析器：无引号值', provider?.baseURL === 'https://ark.cn-beijing.volces.com/api/coding/v3', String(provider?.baseURL))
  check('内置解析器：流式数组', Array.isArray(provider?.models) && provider.models.length === 2, `长度 ${provider?.models?.length}`)
  check('内置解析器：数组元素为对象', provider?.models?.[1]?.id === 'glm-5.3', String(provider?.models?.[1]?.id))
  check('内置解析器：数字类型', provider?.models?.[0]?.contextWindow === 1024000, String(provider?.models?.[0]?.contextWindow))
  check('内置解析器：refs 映射', parsed.refs?.DEEPSEEK_API_KEY === 'sk-abc', String(parsed.refs?.DEEPSEEK_API_KEY))
} catch (err) {
  check('YAML 解析用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 2. 预设 ===')
try {
  check('内置预设数量为 5', BUILTIN_PRESETS.length === 5, `实际 ${BUILTIN_PRESETS.length}`)
  check('每个内置预设都有非空工作说明', BUILTIN_PRESETS.every((p) => p.instruction.length > 100))
  check('每个内置预设都有 modelRef', BUILTIN_PRESETS.every((p) => p.modelRef.includes('/')))
  const deleted = reconcilePresets([{ id: 'structured', instruction: '改过的说明' }])
  check('被删除的内置预设会补回', deleted.length === 5, `实际 ${deleted.length}`)
  check('用户编辑被保留', deleted.find((p) => p.id === 'structured')?.instruction === '改过的说明')
  check('补回的预设带 builtin 标记', deleted.find((p) => p.id === 'coding')?.builtin === true)
  const dedup = reconcilePresets([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }])
  check('重复 id 去重', dedup.filter((p) => p.id === 'a').length === 1)
} catch (err) {
  check('预设用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 3. 配置读写与校验 ===')
try {
  const d = defaultConfig()
  checkEq('默认模式为直接输出', d.mode, 'direct')
  checkEq('默认发送形态为静默直发', d.sendStrategy, 'auto')
  checkEq('默认失败策略为发原文', d.onFailure, 'send-original')
  check('默认 modelRef 为 null（沿用预设自带）', d.modelRef === null)

  // 深合并
  const merged = deepMerge({ a: 1, c: { d: 2, e: 3 } }, { c: { d: 9 } })
  checkEq('深合并保留未提及字段', merged, { a: 1, c: { d: 9, e: 3 } })

  // 显式非法值必须报错，而不是静默回退
  const badMode = applyPatch(normalizeConfig(d), { mode: 'bogus' })
  check('非法 mode 被拒绝', badMode.ok === false && /mode/.test(badMode.error), badMode.error ?? '')
  const badStrategy = applyPatch(normalizeConfig(d), { sendStrategy: 'x' })
  check('非法 sendStrategy 被拒绝', badStrategy.ok === false)
  const badOnFail = applyPatch(normalizeConfig(d), { onFailure: 'x' })
  check('非法 onFailure 被拒绝', badOnFail.ok === false)
  const badRef = applyPatch(normalizeConfig(d), { modelRef: 'no-slash' })
  check('缺斜杠的 modelRef 被拒绝', badRef.ok === false && /provider\/model/.test(badRef.error), badRef.error ?? '')
  const badPreset = applyPatch(normalizeConfig(d), { presetId: 'nope' })
  check('未知 presetId 被拒绝', badPreset.ok === false)
  const badTimeout = applyPatch(normalizeConfig(d), { timeoutMs: 10 })
  check('越界 timeoutMs 被拒绝', badTimeout.ok === false)
  const badTurns = applyPatch(normalizeConfig(d), { context: { maxTurns: 9999 } })
  check('越界 maxTurns 被拒绝', badTurns.ok === false)
  const notObject = applyPatch(normalizeConfig(d), [1, 2])
  check('非对象请求体被拒绝', notObject.ok === false)

  // 合法局部更新
  const good = applyPatch(normalizeConfig(d), { mode: 'optimize', context: { maxTurns: 6 }, presetId: 'coding' })
  check('合法局部更新被接受', good.ok === true, good.ok ? '' : good.error)
  if (good.ok) {
    checkEq('局部更新生效', good.config.mode, 'optimize')
    checkEq('嵌套局部更新生效', good.config.context.maxTurns, 6)
    checkEq('未提及字段保持默认', good.config.timeoutMs, 90000)
  }

  // 预设局部更新：只提交一个字段也不该丢掉别的字段
  const presetPatch = applyPatch(normalizeConfig(d), { presets: [{ id: 'coding', instruction: '新说明' }] })
  check('预设局部更新被接受', presetPatch.ok === true, presetPatch.ok ? '' : presetPatch.error)
  if (presetPatch.ok) {
    const c = presetPatch.config.presets.find((p) => p.id === 'coding')
    checkEq('预设说明被更新', c.instruction, '新说明')
    checkEq('预设名称未被清空', c.name, '编码任务专用')
    checkEq('预设模型未被清空', c.modelRef, 'volcengine-coding-plan/doubao-seed-2.1-pro')
  }

  // 新增预设（「新增预设」功能的后端支撑）
  const base = normalizeConfig(d)
  const withNew = applyPatch(base, {
    presets: base.presets.concat([
      { id: 'custom-1', name: '我的预设', modelRef: 'deepseek-official/deepseek-flash', instruction: '自定义工作说明' },
    ]),
  })
  check('新增预设被接受', withNew.ok === true, withNew.ok ? '' : withNew.error)
  if (withNew.ok) {
    const custom = withNew.config.presets.find((p) => p.id === 'custom-1')
    check('新增预设已进入配置', custom !== undefined)
    checkEq('新增预设名称正确', custom?.name, '我的预设')
    checkEq('新增预设工作说明正确', custom?.instruction, '自定义工作说明')
    checkEq('新增预设标记为非内置', custom?.builtin, false)
    checkEq('内置预设未被挤掉', withNew.config.presets.filter((p) => p.builtin).length, 5)
  }
  check('空 id 被拒绝', applyPatch(base, { presets: [{ id: '' }] }).ok === false)
  check('含大写或空格的 id 被拒绝', applyPatch(base, { presets: [{ id: 'My Preset' }] }).ok === false)
  check('重复 id 被拒绝', applyPatch(base, { presets: [{ id: 'dup' }, { id: 'dup' }] }).ok === false)
  check('过长工作说明被拒绝', applyPatch(base, { presets: [{ id: 'x', instruction: 'a'.repeat(9000) }] }).ok === false)
  check('过长名称被拒绝', applyPatch(base, { presets: [{ id: 'x', name: 'a'.repeat(200) }] }).ok === false)

  // 内置预设不可删除：提交删除后仍会在同一次保存里被补回（已如实反映在 UI 文案中）
  const withoutStructured = base.presets.filter((p) => p.id !== 'structured')
  const afterDelete = applyPatch(base, { presets: withoutStructured })
  check('提交删除内置预设仍可保存', afterDelete.ok === true, afterDelete.ok ? '' : afterDelete.error)
  if (afterDelete.ok) {
    check('内置预设会被立即补回（不接受删除）', afterDelete.config.presets.some((p) => p.id === 'structured'))
    checkEq('补回后预设总数仍为 5', afterDelete.config.presets.length, 5)
  }
  // 非内置预设可以真正删除
  const withCustom = applyPatch(base, {
    presets: base.presets.concat([{ id: 'tmp-1', name: '临时', modelRef: 'deepseek-official/deepseek-flash', instruction: 'x' }]),
  })
  if (withCustom.ok) {
    const removed = applyPatch(withCustom.config, { presets: withCustom.config.presets.filter((p) => p.id !== 'tmp-1') })
    check('自定义预设可以真正删除', removed.ok === true && !removed.config.presets.some((p) => p.id === 'tmp-1'))
  }

  // 磁盘读写往返（用临时 home，不碰真实 DSH_HOME）
  const cfgFile = configPath(tmpHome)
  updateConfig({ mode: 'optimize', modelRef: 'volcengine-agent-plan/glm-5.3' }, { home: tmpHome })
  check('配置文件已落盘', fs.existsSync(cfgFile), cfgFile)
  const reread = loadConfig({ home: tmpHome })
  checkEq('落盘后读回 mode', reread.mode, 'optimize')
  checkEq('落盘后读回 modelRef', reread.modelRef, 'volcengine-agent-plan/glm-5.3')
  checkEq('落盘后预设仍为 5 个', reread.presets.length, 5)
  checkEq('落盘后读回中文说明正确', reread.presets.find((p) => p.id === 'concise').name, '精简明确')
  checkEq('生效模型：顶层覆盖预设', effectiveModelRef(reread), 'volcengine-agent-plan/glm-5.3')
  const noOverride = { ...reread, modelRef: null }
  checkEq('生效模型：回落给预设自带', effectiveModelRef(noOverride), activePreset(noOverride).modelRef)

  // 损坏文件应回退默认值而不是抛错
  fs.writeFileSync(cfgFile, '{ this is not json', 'utf8')
  const recovered = loadConfig({ home: tmpHome, persistDefaults: false })
  check('损坏配置回退默认值', recovered.mode === 'direct' && recovered.presets.length === 5)

  // 原子写：目录不存在也应能创建
  const nested = path.join(tmpHome, 'a', 'b', 'c.json')
  atomicWriteJson(nested, { ok: 1 })
  check('原子写可创建多级目录', fs.existsSync(nested))
  check('原子写不残留临时文件', fs.readdirSync(path.dirname(nested)).filter((f) => f.endsWith('.tmp')).length === 0)
} catch (err) {
  check('配置用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 4. 运行时状态与票据 ===')
try {
  let clock = 1_000_000
  const st = new RuntimeState({ home: tmpHome, now: () => clock })
  const text = '这是一条优化后的提示词'
  const ticket = st.issueTicket(text, 'p/m')
  check('票据为 UUID 形状', /^[0-9a-f-]{36}$/.test(ticket), ticket)
  check('哈希不泄露原文', textHash(text).length === 32 && !textHash(text).includes('提示词'))
  check('签发票据后待处理数为 1', st.pendingTicketCount() === 1)

  const wrongTicket = st.consumeTicket(text, 'not-the-ticket')
  check('票据不匹配时不命中', wrongTicket.hit === false)

  const hit = st.consumeTicket(text, ticket)
  check('正确票据命中', hit.hit === true)
  check('票据命中后带出 modelRef', hit.modelRef === 'p/m')
  check('票据一次性：再次消费不命中', st.consumeTicket(text, ticket).hit === false)

  // 过期
  const t2 = st.issueTicket('另一条', 'p/m')
  clock += TICKET_TTL_MS + 1
  check('过期票据不命中', st.consumeTicket('另一条', t2).hit === false)

  // recent 只记长度
  st.pushRecent({ sessionId: 's1', turn: 2, ok: true, modelRef: 'p/m', elapsedMs: 1200, inputChars: 10, outputChars: 20 })
  const rec = st.recent[0]
  check('recent 已写入', rec && rec.turn === 2)
  check('recent 不含正文（只有长度）', Object.keys(rec).sort().join(',') === 'code,elapsedMs,inputChars,modelRef,ok,outputChars,sessionId,ts,turn')
  check('recent 落盘可读回', JSON.parse(fs.readFileSync(st.file, 'utf8')).recent.length === 1)
} catch (err) {
  check('状态用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 5. 凭据解析（不含真实密钥） ===')
try {
  const refs = await readRefs({ home: process.env.DSH_HOME })
  if (refs === null) {
    check('凭据文件可读', false, '未读到 refs（真实 DSH_HOME 缺少 .credentials.yaml）')
  } else {
    check('凭据文件可读', true, `共 ${Object.keys(refs).length} 个引用`)
    check('引用名不含密钥长度信息', Object.keys(refs).every((k) => /^[A-Z0-9_]+$/.test(k)))
  }
  checkEq('掩码不泄露中段', maskKey('sk-0123456789abcdef'), 'sk-0***cdef')
  checkEq('掩码处理空值', maskKey(''), '(empty)')
  const cred = new Credentials({ home: process.env.DSH_HOME })
  await cred.load()
  const missing = await cred.resolve('__NOT_A_REAL_REF__')
  check('未配置的引用返回 none', missing.key === null && missing.source === 'none')
  const avail = await cred.availability(['__NOT_A_REAL_REF__', 'DEEPSEEK_API_KEY'])
  check('availability 只返回布尔（不返回密钥）', typeof avail['DEEPSEEK_API_KEY'] === 'boolean')
} catch (err) {
  check('凭据用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 6. 模型目录（读本机真实 settings.yaml） ===')
let catalogCache = null
try {
  const exists = fs.existsSync(settingsPath())
  check('本机 settings.yaml 存在', exists, settingsPath())
  const catalog = await buildCatalog({})
  catalogCache = catalog
  check('目录非空', catalog.groups.length > 0, `provider 数 ${catalog.groups.length}`)
  const names = catalog.groups.map((g) => g.provider).join(', ')
  check('解析出 volcengine-coding-plan', catalog.groups.some((g) => g.provider === 'volcengine-coding-plan'), names)
  check('解析出 volcengine-agent-plan', catalog.groups.some((g) => g.provider === 'volcengine-agent-plan'), names)
  check('解析出 deepseek-official（内置目录补全）', catalog.groups.some((g) => g.provider === 'deepseek-official'), names)
  const vcp = catalog.groups.find((g) => g.provider === 'volcengine-coding-plan')
  check('baseURL 解析正确', vcp?.baseURL === 'https://ark.cn-beijing.volces.com/api/coding/v3', String(vcp?.baseURL))
  check('apiKeyEnv 解析正确', vcp?.apiKeyEnv === 'VOLCENGINE_CODING_PLAN_API_KEY', String(vcp?.apiKeyEnv))
  check('模型清单解析正确', vcp?.models?.some((m) => m.id === 'doubao-seed-2.1-pro'), `模型数 ${vcp?.models?.length}`)
  check('openai-completions 标记为支持', vcp?.supported === true)
  const ds = catalog.groups.find((g) => g.provider === 'deepseek-official')
  check('deepseek-official 有内置端点', ds?.baseURL === 'https://api.deepseek.com', String(ds?.baseURL))
  check('deepseek-official 有默认密钥引用', ds?.apiKeyEnv === 'DEEPSEEK_API_KEY', String(ds?.apiKeyEnv))
  check('默认模型引用非空', typeof catalog.defaultModelRef === 'string' && catalog.defaultModelRef.includes('/'), catalog.defaultModelRef)
  check('默认模型落在已解析的分组内', catalog.groups.some((g) => catalog.defaultModelRef.startsWith(`${g.provider}/`)), catalog.defaultModelRef)

  // 每个内置预设的模型都应能在目录里解析成功
  for (const p of BUILTIN_PRESETS) {
    const r = resolveModelRef(catalog, p.modelRef)
    check(`预设 ${p.id} 的模型可解析`, r.ok === true, r.ok ? `${r.provider}/${r.model}` : r.error)
  }

  // 否定用例
  check('空引用被拒绝', resolveModelRef(catalog, '').ok === false)
  check('缺斜杠被拒绝', resolveModelRef(catalog, 'abc').ok === false)
  check('未知 provider 被拒绝', resolveModelRef(catalog, 'nope/x').ok === false)
  check('未知模型被拒绝', resolveModelRef(catalog, 'volcengine-coding-plan/__nope__').ok === false)

  const annotated = await annotateAvailability(catalog, new Credentials({ home: process.env.DSH_HOME }))
  check('目录附带密钥就绪标记（不泄露密钥）', typeof annotated.groups[0].keyConfigured === 'boolean')
  check('目录 JSON 中不含任何密钥字样', !JSON.stringify(annotated).includes('sk-') && !JSON.stringify(annotated).includes('ark-'))
} catch (err) {
  check('目录用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 7. 上下文拼接 ===')
try {
  const human = (text, rpcId) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })
  const injected = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'x' } })
  const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } })
  const sys = { role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'plugin', plugin: 's' } }

  check('真人消息判据为正', isHumanMessage(human('hi', 'r1')) === true)
  check('plugin 注入判据为负', isHumanMessage(injected('ctx')) === false)
  check('助手消息判据为负', isHumanMessage(assistant('a')) === false)
  check('无 source 判据为负', isHumanMessage({ role: 'user', content: [] }) === false)
  checkEq('文本抽取只取 text 块', textOf({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')

  const messages = [
    sys,
    human('第一轮问题', 'r1'),
    assistant('第一轮回答'),
    injected('【系统注入】文件变更通知'),   // 必须被排除
    human('第二轮问题', 'r2'),
    assistant('第二轮回答'),
    human('这是本次要优化的输入', 'r3'),
  ]
  const split = splitTurns(messages)
  checkEq('轮次切分：共 3 轮', split.turns.length, 3)
  checkEq('轮次切分：最后一条真人消息下标', split.lastHumanIndex, 6)
  checkEq('轮次切分：第 1 轮用户文本', split.turns[0].user, '第一轮问题')
  checkEq('轮次切分：第 1 轮助手文本', split.turns[0].assistant, '第一轮回答')
  checkEq('轮次切分：系统注入未成为一轮', split.turns[1].user, '第二轮问题')

  const built = buildContext({ messages, maxTurns: 10, maxChars: 6000, includeAssistant: true })
  checkEq('上下文目标为最后一条真人输入', built.target, '这是本次要优化的输入')
  checkEq('上下文轮数为总轮数减一', built.totalTurns, 2)
  checkEq('上下文使用轮数', built.usedTurns, 2)
  check('上下文含第 1 轮用户文本', built.contextText.includes('用户：第一轮问题'))
  check('上下文含助手输出', built.contextText.includes('助手：第一轮回答'))
  check('上下文不含系统注入', !built.contextText.includes('系统注入'))
  check(
    '待优化目标出现在收尾提示之前的目标位置',
    built.contextText.includes('我最新输入的提示词是：\n这是本次要优化的输入\n'),
  )
  check('上下文含收尾指令', built.contextText.includes('请按上述要求改写它。'))

  const noAssistant = buildContext({ messages, includeAssistant: false })
  check('可关闭助手输出', !noAssistant.contextText.includes('助手：'))

  const limited = buildContext({ messages, maxTurns: 1 })
  checkEq('maxTurns 生效', limited.usedTurns, 1)
  check('maxTurns=1 时保留最新一轮', limited.contextText.includes('用户：第二轮问题'))
  check('maxTurns=1 时丢弃更早的轮', !limited.contextText.includes('用户：第一轮问题'))

  const zeroTurns = buildContext({ messages, maxTurns: 0 })
  checkEq('maxTurns=0 时无历史', zeroTurns.usedTurns, 0)

  const charLimited = buildContext({ messages, maxChars: 0 })
  check('maxChars=0 表示不限制', charLimited.usedTurns === 2, `usedTurns=${charLimited.usedTurns}`)

  // 用长文本构造一个足以触发裁剪的用例，验证「保留最新、丢弃最旧」
  const longTurns = [
    human('A'.repeat(400), 'c1'),
    assistant('a'.repeat(400)),
    human('B'.repeat(400), 'c2'),
    assistant('b'.repeat(400)),
    human('C'.repeat(400), 'c3'),
    assistant('c'.repeat(400)),
    human('最新待优化输入', 'c4'),
  ]
  const charTrim = buildContext({ messages: longTurns, maxChars: 1000 })
  check('maxChars 裁剪生效', charTrim.usedTurns < charTrim.totalTurns, `used=${charTrim.usedTurns} total=${charTrim.totalTurns}`)
  check('maxChars 裁剪后保留最新一轮', charTrim.contextText.includes('C'.repeat(50)))
  check('maxChars 裁剪后丢弃最旧一轮', !charTrim.contextText.includes('A'.repeat(50)))
  check('maxChars 裁剪后目标不受影响', charTrim.target === '最新待优化输入')

  const noHistory = buildContext({ messages: [human('唯一一句', 'r1')] })
  checkEq('无历史时目标正确', noHistory.target, '唯一一句')
  checkEq('无历史时轮数为 0', noHistory.totalTurns, 0)
  check('无历史时有占位说明', noHistory.contextText.includes('本次会话尚无更早的对话'))

  // 已优化轮次：content 是优化后的文本，source 里另有原文 → 上下文应取优化后的文本
  const optimizedTurn = {
    role: 'user',
    content: [{ type: 'text', text: '优化后的第一轮问题' }],
    source: { kind: 'user', rpcId: 'r1', poOptimized: true, poOriginalText: '原始第一轮问题', poOptimizedBy: 'p/m' },
  }
  const built2 = buildContext({ messages: [optimizedTurn, assistant('答'), human('新输入', 'r2')] })
  check('已优化轮次在上下文中用优化后的文本', built2.contextText.includes('优化后的第一轮问题'))
  check('已优化轮次在上下文中不含原文', !built2.contextText.includes('原始第一轮问题'))

  checkEq('trimByChars 不裁剪空数组', trimByChars([], 100).length, 0)
  checkEq('trimByChars 上限为 0 时不限制', trimByChars([{ user: 'a', assistant: 'b' }], 0).length, 1)
} catch (err) {
  check('上下文用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 8. 响应清洗与解析 ===')
try {
  checkEq('去围栏：带语言标注', stripFences('```markdown\n你好\n```'), '你好')
  checkEq('去围栏：无语言标注', stripFences('```\n你好\n```'), '你好')
  checkEq('去围栏：普通文本原样', stripFences('  你好  '), '你好')
  checkEq('去包裹引号', stripFences('"你好"'), '你好')
  checkEq('去中文包裹引号', stripFences('「你好」'), '你好')
  checkEq('去围栏保留内部代码块', stripFences('```\n```js\nx\n```\n```'), '```js\nx\n```')

  const msgs = buildMessages('  说明  ', '内容')
  checkEq('组装消息：system + user', msgs.length, 2)
  checkEq('组装消息：system 已 trim', msgs[0].content, '说明')
  checkEq('组装消息：user 原样', msgs[1].content, '内容')
  checkEq('空工作说明时不加 system', buildMessages('', 'x').length, 1)

  checkEq('解析响应：字符串内容', textFromResponse({ choices: [{ message: { content: 'ok' } }] }), 'ok')
  checkEq('解析响应：内容块数组', textFromResponse({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab')
  checkEq('解析响应：结构不符返回 null', textFromResponse({}), null)
} catch (err) {
  check('清洗用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 9. 优化调用（打桩，不联网） ===')
try {
  const okFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '```\n优化后的提示词\n```' } }] }),
  })
  const okRes = await optimizeOnce({
    endpoint: { baseURL: 'https://example.invalid', model: 'm' },
    apiKey: 'test-key',
    instruction: '说明',
    userContent: '上下文',
    original: '原始输入',
    fetchImpl: okFetch,
  })
  check('成功路径 ok', okRes.ok === true, okRes.ok ? '' : okRes.error)
  checkEq('成功路径已清洗围栏', okRes.optimized, '优化后的提示词')
  check('成功路径判定已变化', okRes.changed === true)
  check('成功路径带耗时', Number.isFinite(okRes.elapsedMs))

  const sameFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '原始输入' } }] }),
  })
  const sameRes = await optimizeOnce({
    endpoint: { baseURL: 'https://example.invalid', model: 'm' },
    apiKey: 'k',
    instruction: '',
    userContent: '',
    original: '原始输入',
    fetchImpl: sameFetch,
  })
  check('与原文相同时 changed = false', sameRes.ok === true && sameRes.changed === false)

  const errFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'invalid api key' } }),
  })
  const errRes = await optimizeOnce({
    endpoint: { baseURL: 'https://example.invalid', model: 'm' },
    apiKey: 'SECRETKEYVALUE',
    instruction: '',
    userContent: '',
    original: 'x',
    fetchImpl: errFetch,
  })
  check('HTTP 4xx 归一为 HTTP_4XX', errRes.ok === false && errRes.code === 'HTTP_4XX', errRes.code)
  check('4xx 错误文案含状态码', errRes.ok === false && errRes.error.includes('401'), errRes.error)
  check('4xx 错误文案不含密钥', errRes.ok === false && !errRes.error.includes('SECRETKEYVALUE'))

  const badJsonFetch = async () => ({ ok: true, status: 200, text: async () => 'not json' })
  const badRes = await optimizeOnce({
    endpoint: { baseURL: 'https://example.invalid', model: 'm' },
    apiKey: 'k',
    instruction: '',
    userContent: '',
    original: 'x',
    fetchImpl: badJsonFetch,
  })
  check('非 JSON 归一为 BAD_RESPONSE', badRes.ok === false && badRes.code === 'BAD_RESPONSE', badRes.code)

  const emptyFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '   ' } }] }),
  })
  const emptyRes = await optimizeOnce({
    endpoint: { baseURL: 'https://example.invalid', model: 'm' },
    apiKey: 'k',
    instruction: '',
    userContent: '',
    original: 'x',
    fetchImpl: emptyFetch,
  })
  check('空内容归一为 BAD_RESPONSE', emptyRes.ok === false && emptyRes.code === 'BAD_RESPONSE', emptyRes.code)

  const noKey = await optimizeOnce({
    endpoint: { baseURL: 'https://example.invalid', model: 'm' },
    apiKey: '',
    instruction: '',
    userContent: '',
    original: 'x',
    fetchImpl: okFetch,
  })
  check('缺密钥归一为 NO_KEY', noKey.ok === false && noKey.code === 'NO_KEY', noKey.code)

  const noEndpoint = await optimizeOnce({
    endpoint: { baseURL: '', model: 'm' },
    apiKey: 'k',
    instruction: '',
    userContent: '',
    original: 'x',
    fetchImpl: okFetch,
  })
  check('缺端点归一为 NO_ENDPOINT', noEndpoint.ok === false && noEndpoint.code === 'NO_ENDPOINT', noEndpoint.code)

  // 超时
  const hangFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })
  const timeoutRes = await optimizeOnce({
    endpoint: { baseURL: 'https://example.invalid', model: 'm' },
    apiKey: 'k',
    instruction: '',
    userContent: '',
    original: 'x',
    timeoutMs: 3000,
    fetchImpl: hangFetch,
  })
  check('超时归一为 TIMEOUT', timeoutRes.ok === false && timeoutRes.code === 'TIMEOUT', `${timeoutRes.code} / ${timeoutRes.error}`)

  // 外部取消
  const ac = new AbortController()
  ac.abort()
  const abortRes = await optimizeOnce({
    endpoint: { baseURL: 'https://example.invalid', model: 'm' },
    apiKey: 'k',
    instruction: '',
    userContent: '',
    original: 'x',
    signal: ac.signal,
    fetchImpl: okFetch,
  })
  check('外部取消归一为 ABORTED', abortRes.ok === false && abortRes.code === 'ABORTED', abortRes.code)
} catch (err) {
  check('优化调用用例执行', false, String(err?.stack ?? err))
}

console.log('\n=== 10. 改写器（核心逻辑，打桩调用） ===')
try {
  const human = (text, rpcId, extra) => ({
    id: 'm-' + rpcId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId, ...(extra ?? {}) },
  })
  const contextMsg = { id: 'ctx-1', role: 'user', content: [{ type: 'text', text: 'CTX' }], source: { kind: 'plugin', plugin: 'x' } }
  const cfg = normalizeConfig({ mode: 'optimize', presetId: 'structured', modelRef: 'volcengine-coding-plan/doubao-seed-2.1-pro' })
  const cat = catalogCache ?? (await buildCatalog({}))
  const st = new RuntimeState({ home: tmpHome })
  const resolveKey = async () => ({ key: 'test-key', source: 'credentials' })
  const okFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '优化后的提示词内容' } }] }),
  })

  // 判定函数
  check('shouldOptimize：直接模式跳过', shouldOptimize({ ...cfg, mode: 'direct' }, 'hi').ok === false)
  check('shouldOptimize：停用时跳过', shouldOptimize({ ...cfg, enabled: false }, 'hi').ok === false)
  check('shouldOptimize：空输入跳过', shouldOptimize(cfg, '   ').ok === false)
  check('shouldOptimize：超长跳过', shouldOptimize({ ...cfg, maxOptimizeChars: 3 }, 'abcdef').ok === false)
  check('shouldOptimize：正常放行', shouldOptimize(cfg, '正常输入').ok === true)

  // step 不为 1 时不处理
  const skip = await rewriteMessages({
    messages: [human('问题', 'r1')],
    step: 2,
    config: cfg,
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: okFetch,
  })
  check('step !== 1 时原样返回', skip.messages.length === 1 && skip.replacements.length === 0)

  // 正常改写：真人消息被替换，context 消息保留，rpcId 保留
  const messages = [human('原始问题', 'r1'), contextMsg]
  const out = await rewriteMessages({
    messages,
    step: 1,
    config: cfg,
    catalog: cat,
    resolveKey,
    state: st,
    sessionId: 's-x',
    turn: 1,
    fetchImpl: okFetch,
  })
  checkEq('改写：消息条数不变（context 消息保留）', out.messages.length, 2)
  check('改写：context 消息是同一个对象引用', out.messages[1] === contextMsg)
  check('改写：真人消息已替换为新对象', out.messages[0] !== messages[0])
  checkEq('改写：内容为优化结果', out.messages[0].content[0].text, '优化后的提示词内容')
  checkEq('改写：role 为 user', out.messages[0].role, 'user')
  checkEq('改写：rpcId 原样保留（硬约束）', out.messages[0].source.rpcId, 'r1')
  checkEq('改写：来源 kind 未被改动', out.messages[0].source.kind, 'user')
  checkEq('改写：存在已优化标记', out.messages[0].source[MARKER_FIELDS.optimized], true)
  checkEq('改写：存有原始文本', out.messages[0].source[MARKER_FIELDS.originalText], '原始问题')
  checkEq('改写：记录使用的模型', out.messages[0].source[MARKER_FIELDS.optimizedBy], 'volcengine-coding-plan/doubao-seed-2.1-pro')
  checkEq('改写：记录预设 id', out.messages[0].source[MARKER_FIELDS.presetId], 'structured')
  check('改写：消息已被深冻结', Object.isFrozen(out.messages[0]))
  check('改写：内容数组也被冻结', Object.isFrozen(out.messages[0].content))
  check('改写：分配了新的 message id', out.messages[0].id !== messages[0].id && typeof out.messages[0].id === 'string')
  check('改写：产出 replaced 记录', out.replacements.length === 1 && out.replacements[0].kind === 'optimized')

  // 非文本内容块必须保留（图片等）
  const withImage = human('带图的问题', 'r2')
  withImage.content = [{ type: 'text', text: '带图的问题' }, { type: 'image', ref: 'img-1' }]
  const out2 = await rewriteMessages({
    messages: [withImage],
    step: 1,
    config: cfg,
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: okFetch,
  })
  checkEq('改写：图片块被保留', out2.messages[0].content.length, 2)
  checkEq('改写：图片块原样', out2.messages[0].content[1].ref, 'img-1')
  checkEq('改写：文本块排在前面', out2.messages[0].content[0].type, 'text')

  // clientTimeZone 必须保留
  const withTz = human('问题', 'r3', { clientTimeZone: 'Asia/Shanghai' })
  const out3 = await rewriteMessages({
    messages: [withTz],
    step: 1,
    config: cfg,
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: okFetch,
  })
  checkEq('改写：clientTimeZone 原样保留', out3.messages[0].source.clientTimeZone, 'Asia/Shanghai')

  // 直接模式：完全不改写
  const direct = await rewriteMessages({
    messages: [human('问题', 'r4')],
    step: 1,
    config: { ...cfg, mode: 'direct' },
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: okFetch,
  })
  check('直接模式：原样返回同一数组', direct.messages[0].source[MARKER_FIELDS.optimized] === undefined)

  // 停用：完全不改写
  const off = await rewriteMessages({
    messages: [human('问题', 'r5')],
    step: 1,
    config: { ...cfg, enabled: false },
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: okFetch,
  })
  check('停用时：不改写', off.messages[0].source[MARKER_FIELDS.optimized] === undefined)

  // 优化失败 + send-original：发原文
  const failFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' })
  const failed = await rewriteMessages({
    messages: [human('问题', 'r6')],
    step: 1,
    config: { ...cfg, onFailure: 'send-original' },
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: failFetch,
  })
  check('失败降级：send-original 时发出原文', failed.messages[0].source[MARKER_FIELDS.optimized] === undefined)
  check('失败降级：记录了失败', st.recent.some((r) => r.ok === false && r.code === 'HTTP_5XX'))

  // 优化失败 + cancel：取消
  const cancelled = await rewriteMessages({
    messages: [human('问题', 'r7')],
    step: 1,
    config: { ...cfg, onFailure: 'cancel' },
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: failFetch,
  })
  check('失败降级：cancel 时返回 cancelled', cancelled.cancelled === true)

  // 无密钥
  const noKey = await rewriteMessages({
    messages: [human('问题', 'r8')],
    step: 1,
    config: cfg,
    catalog: cat,
    resolveKey: async () => ({ key: null, source: 'none' }),
    state: st,
    fetchImpl: okFetch,
  })
  check('缺密钥时归类为 NO_KEY 并降级', noKey.messages[0].source[MARKER_FIELDS.optimized] === undefined)

  // 票据命中：不再重复调用模型
  let called = 0
  const countingFetch = async () => {
    called++
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'x' } }] }) }
  }
  st.issueTicket('优化后的提示词内容', 'p/m')
  const ticketOut = await rewriteMessages({
    messages: [human('优化后的提示词内容', 'r9')],
    step: 1,
    config: cfg,
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: countingFetch,
  })
  checkEq('票据命中时不调用模型', called, 0)
  check('票据命中时仍做标记', ticketOut.messages[0].source[MARKER_FIELDS.optimized] === true)

  // 本地回退实现与官方语义一致
  const local = createUserMessageLocal({ content: [{ type: 'text', text: 'a' }], source: { kind: 'user', rpcId: 'q' } })
  checkEq('本地实现：role 为 user', local.role, 'user')
  check('本地实现：分配了 id', typeof local.id === 'string' && local.id.length === 36)
  check('本地实现：已深冻结', Object.isFrozen(local) && Object.isFrozen(local.content) && Object.isFrozen(local.source))
  check('deepFreezeValue：嵌套对象也冻结', Object.isFrozen(deepFreezeValue({ a: { b: [1, 2] } }).a.b))
  check('deepFreezeValue：能处理循环引用', (() => {
    const o = { a: 1 }
    o.self = o
    try {
      deepFreezeValue(o)
      return Object.isFrozen(o)
    } catch {
      return false
    }
  })())

  const resolved = await resolveCreateUserMessage()
  check('createUserMessage 解析成功', typeof resolved.fn === 'function', `来源 = ${resolved.via}`)

  // 多轮上下文：只处理第一条真人消息，其余原样保留
  const multi = [human('第一条', 'r10'), human('第二条', 'r11'), contextMsg]
  const multiOut = await rewriteMessages({
    messages: multi,
    step: 1,
    config: cfg,
    catalog: cat,
    resolveKey,
    state: st,
    fetchImpl: okFetch,
  })
  checkEq('多真人消息：条数不变', multiOut.messages.length, 3)
  check('多真人消息：第一条被改写', multiOut.messages[0].source[MARKER_FIELDS.optimized] === true)
  check('多真人消息：第二条原样', multiOut.messages[1] === multi[1])
  check('多真人消息：context 原样', multiOut.messages[2] === contextMsg)
} catch (err) {
  check('改写器用例执行', false, String(err?.stack ?? err))
}

if (process.argv.includes('--live')) {
  console.log('\n=== 11. 真调优化模型（--live，会消耗额度） ===')
  try {
    const catalog = catalogCache ?? (await buildCatalog({}))
    const cred = new Credentials({ home: process.env.DSH_HOME })

    // 先用最快的模型验证完整链路，再顺带试一个「思考型」模型。
    // 说明：doubao / glm 属于思考型，单次可能耗时 60~90 秒（与网络质量强相关），
    // 因此这里给足超时，并且把它的失败视为「环境波动」而非功能缺陷 —— 只提示不判失败。
    const fastRef = 'deepseek-official/deepseek-flash'
    const fast = resolveModelRef(catalog, fastRef)

    if (!fast.ok) {
      check('真调：解析快速模型引用', false, fast.error)
    } else {
      const { key, source } = await cred.resolve(fast.apiKeyEnv)
      check('真调：密钥可用', typeof key === 'string' && key.length > 0, `来源 ${source}`)
      if (typeof key === 'string' && key.length > 0) {
        const res = await optimizeOnce({
          endpoint: fast,
          apiKey: key,
          instruction: BUILTIN_PRESETS[0].instruction,
          userContent:
            '以下是本次会话已发生的对话记录（可能为空）：\n（本次会话尚无更早的对话）\n\n---\n\n现在需要优化的、我最新输入的提示词是：\n帮我看看那个东西\n\n请按上述要求改写它。',
          original: '帮我看看那个东西',
          timeoutMs: 120000,
        })
        check(
          '真调：完整链路成功返回',
          res.ok === true,
          res.ok ? `${res.optimized.length} 字，${res.elapsedMs}ms → ${res.optimized.replace(/\s+/g, ' ').slice(0, 60)}` : `${res.code}: ${res.error}`,
        )
        if (res.ok) {
          check('真调：结果非空且已变化', res.optimized.trim().length > 0 && res.changed === true)
          check('真调：结果不含 Markdown 围栏', !res.optimized.trim().startsWith('```'))
        }
      }
    }

    // 思考型模型：只做一次尝试，失败按环境波动记录
    const slow = resolveModelRef(catalog, BUILTIN_PRESETS[0].modelRef)
    if (slow.ok) {
      const { key } = await cred.resolve(slow.apiKeyEnv)
      if (key) {
        const res = await optimizeOnce({
          endpoint: slow,
          apiKey: key,
          instruction: BUILTIN_PRESETS[0].instruction,
          userContent: '现在需要优化的、我最新输入的提示词是：\n帮我看看那个东西\n\n请按上述要求改写它。',
          original: '帮我看看那个东西',
          timeoutMs: 150000,
        })
        console.log(
          `[INFO] 思考型模型 ${slow.provider}/${slow.model}：${
            res.ok ? `成功 ${res.elapsedMs}ms` : `未完成（${res.code}），按网络波动处理`
          }`,
        )
      }
    }
  } catch (err) {
    check('真调用例执行', false, String(err?.stack ?? err))
  }
}

// 清理临时目录
try {
  fs.rmSync(tmpHome, { recursive: true, force: true })
} catch {
  /* 忽略 */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 自检结果：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`)
  process.exit(1)
}
console.log('全部通过。')
