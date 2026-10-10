# 00 — 侦察报告（DSH 插件机制 · 本机实测）

> 阶段一「概念理解优化」的过程性文档。所有结论均来自本机已安装代码的实测与阅读，不是推测。

## 1. 本机 DSH 环境事实

| 项 | 值 | 来源 |
|---|---|---|
| `dsh` CLI 版本 | `0.1.5-rc.1` | `dsh.cmd --version` |
| CLI 安装位置 | `C:\Users\18136\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` | 环境侦察 |
| `DSH_HOME` | `C:\Users\18136\.dsh` | 环境变量 |
| Web GUI | `http://127.0.0.1:3080` | `DSH_WEB_URL` |
| Node | `v24.21.0` | `node -v` |
| npm / pnpm | `11.19.0` / `12.4.2` | `npm.cmd -v` / `pnpm.cmd -v` |
| 使用的 profile | `web`（`C:\Users\18136\.dsh\profiles\web`） | profile 目录 |
| 当前会话 | `session-7a49f5b1-29f1-4fb1-8a06-12a14f5f1ad8` | `DSH_SESSION_ID` |

**注意（环境坑）**：本机 PowerShell 执行策略禁止运行 `.ps1`，因此 `dsh` / `npm` / `pnpm` 必须通过 `.cmd` 包装调用
（`dsh.cmd`、`npm.cmd`、`pnpm.cmd`）。这不是缺陷，是调用方式。

## 2. 插件体系结构（Cordis）

DSH 是 Cordis 插件系统。插件的 `package.json` 声明 `dsh.bundle.patch` 指向一个 cordis patch YAML，
该 YAML 把插件插入 profile 的配置树：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

```yaml
# cordis.patch.yml —— 唯一的"挂载声明"
- insert:
    - id: <plugin-id>
      name: <npm-package-name>
```

安装（无需手工改 profile）：

```
dsh.cmd plugin --profile web add link:<插件目录绝对路径>
```

`dsh plugin` 的实际行为（读自 `lib/plugin-Ddi42qoW.js`）：在 profile 目录里转发给 pnpm，
然后把「解析出的、声明了 `dsh.bundle` 的依赖」自动追加进 profile `package.json` 的
`dsh.profile.bundles` 层栈。**因此不需要手写 profile 的 cordis.patch.yml。**

本机 profile（`C:\Users\18136\.dsh\profiles\web\package.json`）现状：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-whale-widget"], "patchReload": "live" } }
```

## 3. 决定性发现：本机已有可用的第三方外挂插件范例

`dsh-whale-widget`（`A:\document\studio\agent\deepseek harness\plugin\dsh-whale-widget-0.3.2-package`）
已以 `link:` 方式安装并正在本机运行。它**没有**走 DSH 官方 client-plugin 预打包链路，而是：

1. **宿主侧**（`lib/index.js`，Node）用 `ctx.webServer.register()` 注册自有 HTTP 路由；
2. 用 `ctx.webServer.tapIndex(html => ...)` 往 `index.html` 注入 `<script defer src="...">`；
3. **浏览器侧**代码是一个**独立、自包含的普通 JS 文件**，由宿主路由以 `application/javascript` 原样吐给页面；
4. 浏览器侧纯 DOM 操作（`#root` 内找 composer）挂载 UI，通过自有 HTTP 路由读写状态；
5. 状态落盘在 `C:\Users\18136\.dsh\.dshw-*.json`。

**这条路线的价值**：完全绕开 TypeScript / tsdown / React 构建链与网络依赖，
与本机既有成功案例一致，风险最低。**本项目采用同一路线。**

核心 API（读自 `dsh-host-webserver/lib/types/index.d.ts`，已确认存在）：

```ts
interface WebServer {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler(req, res): void | Promise<void> }): () => void
  tapIndex(transform: (html: string) => string): () => void
  // 另有结构化注入：ctx.on('webserver/index-inject', table => table.push({ kind: 'script-src', placement: 'body', src }))
}
```

## 4. 宿主侧能力（已确认）

| 能力 | API | 证据 |
|---|---|---|
| 注册 HTTP 路由 | `ctx.webServer.register({kind,path,handler})` | `dsh-host-webserver/lib/types/index.d.ts:90` |
| 注入 index.html | `ctx.webServer.tapIndex(fn)` | 同上 `:114` |
| 信任栅栏（防 DNS 重绑定/未认证） | `connection.requestRejection(req)` | whale-widget `lib/index.js:537-555`；官方插件同样调用 |
| 读取凭据 | `await ctx.credentials.resolve('DEEPSEEK_API_KEY')` | whale-widget `lib/index.js:721` |
| 写入凭据 | `await ctx.credentials.set(ref, value)` | whale-widget `lib/index.js:1816` |
| 监听会话事件流 | `ctx.on('session/event', (session, event) => …)` | whale-widget `lib/index.js:670` |
| 会话销毁 | `ctx.on('session/disposed', session => …)` | whale-widget `lib/index.js:675` |
| 资源清理 | `ctx.effect(() => () => { …disposers… })` | whale-widget `lib/index.js:3230` |
| 服务注入声明 | `inject: ['webServer', 'credentials', 'connection']` | whale-widget `lib/index.js:531` |

### 4.1 会话事件里能拿到什么（读自 `dsh-session/lib/types/types.d.ts:242-340`）

- `turn/start` → `{ turn }`
- `turn/end` → `{ turn, reason }`
- `user/message` → `UserMessage`（含 `content` 与 `source`；`source` 可区分真人输入 / `agent.inject()` 合成上下文 / goal 轮次）
- `assistant/message` → `{ turn, step, message: AssistantMessage, usage? }`
- `step/start` / `step/end` / `tool/call` / `tool/result`

**结论**：宿主侧订阅 `session/event` 即可增量拼出「每轮用户输入文本 + 助手输出文本」，
正是本插件所需的优化上下文来源；`source` 字段还能用来**只取真人输入、排除系统注入**。

## 5. 优化模型调用链路：实测已打通

插件自行以 **OpenAI 兼容** `POST {baseURL}/chat/completions` 调用已接入模型即可。
本机 `settings.yaml` 中已配置的 provider（含 baseURL / apiKeyEnv / 模型清单）：

| provider | baseURL | 凭据 ref | 代表模型 |
|---|---|---|---|
| `volcengine-coding-plan` | `https://ark.cn-beijing.volces.com/api/coding/v3` | `VOLCENGINE_CODING_PLAN_API_KEY` | `doubao-seed-2.1-pro` |
| `volcengine-agent-plan` | `https://ark.cn-beijing.volces.com/api/plan/v3` | `VOLCENGINE_AGENT_PLAN_API_KEY` | `glm-5.3` |
| `deepseek-official` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-flash`（当前 agent 默认模型） |

实测结果（`node docs/probe-llm.mjs`，三条全部 HTTP 200）：

```
OK   volcengine-coding-plan / doubao-seed-2.1-pro  http=200  2054ms  -> 可用
OK   volcengine-agent-plan / glm-5.3               http=200  1048ms
OK   deepseek-official / deepseek-flash            http=200  1106ms
```

凭据实际存储在 `C:\Users\18136\.dsh\.credentials.yaml` 的 `refs:` 段，三个 key 均已存在。

> **风险等级结论**：本插件唯一的高不确定性点（能否直连已接入模型）**已验证为低风险**。
> 剩余不确定性集中在**客户端「拦截/改写外发提示词」的接入点**，见第 6 节。

## 6. 待定技术点：如何把优化后的提示词交给当前会话模型

已确认的事实：

- 前端是 React SPA，构建产物 `dsh-web-frontend/dist/assets/index-*.js`（555 KB，纯构建产物，无源码）。
- 输入框在新版为 `contenteditable` div（whale-widget 注释 `assets/whale-widget.js:9`）。
- 客户端提交走 Typert Remote：`ISession.prompt(content, mode, signal, requestId)`
  （`dsh-api-session-controller/lib/types/client/contract/session.d.ts:81`）；
  一元调用经 `connection.rpc.call('/api', endpoint, …)`（HTTP），流式经 WebSocket `/api/remote.mux`。
- 客户端 cordis 服务在页面内的**全局句柄尚未发现**（shell 产物中未见 `window.__DSH_*` 暴露点）。

**三条候选路线（阶段二架构设计时定稿）**：

- **A. 宿主侧注入改写**：在宿主 `session/event` 上判定本轮真人输入，交由优化模型改写，
  以某种「替换本轮提示词」的名义写回。语义最干净，但需要确认宿主是否存在可改写的接入点。
- **B. 客户端 DOM 改写**：优化完成后把结果写回 composer，再由页面自身逻辑发送。
  与既有范例同源、零构建依赖；需处理 React 受控组件一致性与"不重复发送"。
- **C. 客户端 RPC 包装**：页面内定位会话对象的 `prompt` 并包装，在参数上替换文本块。
  最精确，前提是能在页面里拿到该对象。

阶段二将对这些路线逐一做可行性验证（读官方 client 插件的 service 契约 + 本机实测），
选定一条并给出明确取舍理由。

## 7. 阶段一结论

| 问题 | 结论 |
|---|---|
| 插件能否挂进本机 DSH？ | 能，`dsh.cmd plugin --profile web add link:<dir>`，机制与 whale-widget 完全一致 |
| 能否在输入框加 UI？ | 能，`tapIndex` + 自服务 JS 已是本机验证过的成熟路线 |
| 能否调已接入模型？ | 能，已实测 3 个 provider 全通 |
| 能否拿到每轮输入/输出文本？ | 能，宿主 `session/event`（`user/message` + `assistant/message`） |
| 能否加设置页？ | 待阶段二确认：设置页仍是 SPA 视图，客户端注入路线与输入框一致，可行 |
| 需要多语言/构建链吗？ | 不需要。纯 JS + YAML，零 npm 依赖 |
