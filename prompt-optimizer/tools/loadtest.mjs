/**
 * 加载验证：模拟 DSH 的安装形态，把插件作为模块导入，确认：
 *   1. 导出形状正确（具名 name / inject / apply，且**没有** export default）
 *   2. apply 能在最小桩上下文里跑完，不抛异常
 *   3. 注册了预期的路由与 tapIndex
 *   4. pre-step 监听确实挂上了
 *
 * 用法: node tools/loadtest.mjs
 *
 * 这个验证不需要重启 dsh web，因此可以在不打断会话的前提下先确认装配无误。
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// 路径含空格，必须用 fileURLToPath 正确解码（手写 replace 会导致 %20 二次编码）
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 记录已注册的路由。 */
const routes = []
/** 记录 tapIndex 变换。 */
const taps = []
/** 记录事件监听。 */
const listeners = []
/** 记录 effect 清理器数量。 */
let effectCount = 0

const logger = { info() {}, warn() {}, error() {}, debug() {} }

/** 最小桩上下文。 */
const ctx = {
  logger,
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  },
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {
      const i = listeners.findIndex((l) => l.handler === handler)
      if (i >= 0) listeners.splice(i, 1)
    }
  },
  effect(fn) {
    effectCount++
    fn()
    return () => {}
  },
  webServer: {
    register(route) {
      if (routes.some((r) => r.path === route.path)) throw new Error(`duplicate route: ${route.path}`)
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {
        const i = taps.indexOf(fn)
        if (i >= 0) taps.splice(i, 1)
      }
    },
  },
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  —— ${detail}` : ''}`)
}

console.log('=== 1. 模块导出形状 ===')
const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
check('具名导出 name', mod.name === 'dsh-prompt-optimizer', String(mod.name))
check('具名导出 inject，且只依赖 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject))
check('导出 apply 函数', typeof mod.apply === 'function')
check(
  '没有 export default（否则会丢失 inject）',
  mod.default === undefined,
  mod.default === undefined ? '' : '存在 default 导出！',
)

console.log('\n=== 2. apply 装配（最小桩上下文） ===')
let applyError = null
try {
  mod.apply(ctx)
} catch (err) {
  applyError = err
}
check('apply 未抛异常', applyError === null, applyError ? String(applyError?.stack ?? applyError) : '')

console.log('\n=== 3. 路由注册 ===')
const expectedPaths = [
  '/dsh-prompt-optimizer/config.json',
  '/dsh-prompt-optimizer/optimize.json',
  '/dsh-prompt-optimizer/status.json',
  '/dsh-prompt-optimizer/ui.js',
]
for (const p of expectedPaths) {
  check(`注册了 ${p}`, routes.some((r) => r.path === p))
}
check('全部路由都是 exact 类型', routes.every((r) => r.kind === 'exact'))
check('路由都有 handler', routes.every((r) => typeof r.handler === 'function'))
check(
  '路由路径前缀正确',
  routes.every((r) => r.path.startsWith('/dsh-prompt-optimizer/')),
  routes.map((r) => r.path).join(', '),
)

console.log('\n=== 4. index 注入 ===')
check('注册了 1 个 tapIndex 变换', taps.length === 1, `实际 ${taps.length}`)
if (taps.length === 1) {
  const html = '<html><body><div id="root"></div></body></html>'
  const out = taps[0](html)
  check('注入了 ui.js 的 script 标签', out.includes('/dsh-prompt-optimizer/ui.js'))
  check('script 位于 </body> 之前', out.indexOf('ui.js') < out.indexOf('</body>'))
  check('对已注入的 html 幂等', taps[0](out) === out)
}

console.log('\n=== 5. 事件监听 ===')
check('挂了 agent/pre-step 监听', listeners.some((l) => l.event === 'agent/pre-step'), listeners.map((l) => l.event).join(', '))

console.log('\n=== 6. 用一个真实形状的 pre-step 调用验证端到端（直接模式应零改动） ===')
const preStep = listeners.find((l) => l.event === 'agent/pre-step')
if (!preStep) {
  check('pre-step 监听存在', false)
} else {
  const humanMsg = {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: '测试输入' }],
    source: { kind: 'user', rpcId: 'rpc-1' },
  }
  const contextMsg = {
    id: 'c1',
    role: 'user',
    content: [{ type: 'text', text: 'CTX' }],
    source: { kind: 'plugin', plugin: 'x' },
  }
  const payload = {
    agent: { session: { id: 's-test', deriveMessages: () => [humanMsg], requestHeader: () => undefined } },
    messages: [humanMsg, contextMsg],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  const next = async () => ({ kind: 'enter', messages: [humanMsg, contextMsg] })
  let out = null
  let callError = null
  try {
    out = await preStep.handler(payload, next)
  } catch (err) {
    callError = err
  }
  check('pre-step 处理未抛异常', callError === null, callError ? String(callError?.stack ?? callError) : '')
  check('返回了 enter 决策', out?.kind === 'enter', JSON.stringify(out?.kind))
  // 默认配置是 direct 模式，因此必须原样返回（零副作用）
  check('直接模式下消息未被改动', out?.messages?.[0] === humanMsg && out?.messages?.[1] === contextMsg)
  check('直接模式下消息条数不变', out?.messages?.length === 2, String(out?.messages?.length))
}

console.log('\n=== 7. ctx.effect 清理器 ===')
check('注册了清理 effect', effectCount >= 1, `实际 ${effectCount}`)

console.log('\n=== 8. 资源文件可读性 ===')
const uiPath = path.join(root, 'assets', 'ui.js')
check('assets/ui.js 存在', fs.existsSync(uiPath))
if (fs.existsSync(uiPath)) {
  const text = fs.readFileSync(uiPath, 'utf8')
  check('ui.js 非空', text.length > 1000, `${text.length} 字符`)
  check('ui.js 是 IIFE', text.includes('(function ()') || text.includes('(function('))
  check('ui.js 有防重复初始化旗标', text.includes('__dshPromptOptimizer'))
  check('ui.js 引用了正确的接口前缀', text.includes('/dsh-prompt-optimizer'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 加载验证：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`)
  process.exit(1)
}
console.log('全部通过。')
