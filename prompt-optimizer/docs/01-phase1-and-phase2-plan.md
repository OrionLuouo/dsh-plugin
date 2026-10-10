# 01 — 阶段一成果 & 阶段二（架构设计）计划

## 第一部分：阶段一「概念理解优化」成果汇报

### 1.1 关键概念的精确化

原需求里的说法 → 落地后的工程含义：

| 需求原话 | 工程含义 |
|---|---|
| 「在输入框添加一个选项」 | 在 composer（输入区）工具栏插入一个按钮 + 上拉菜单 |
| 「按钮切换直接输出 / 优化输出」 | 一个持久化的 `mode` 状态：`direct` \| `optimize` |
| 「上拉菜单选择优化模型」 | 一个持久化的 `modelRef`，从 DSH 已接入 provider/model 清单中选取 |
| 「会话中每轮输入的提示词和输出的文本拼接作为优化上下文」 | 从宿主 `session/event` 增量采集 `user/message` + `assistant/message` 的文本 |
| 「工作说明」 | 每个预设一段可编辑的 system 指令文本 |
| 「优化后的提示词再输出给当前会话模型」 | 用优化结果替换本轮外发提示词 |
| 「设置页面加入设置选项，提供多种预设」 | 在 Settings 视图注入本插件的设置区，编辑预设列表（模型 + 工作说明） |

### 1.2 环境与可行性结论（实测，非推测）

- 本机 DSH `0.1.5-rc.1`，profile 为 `web`，已存在一个正在运行的**第三方外挂插件**范例
  `dsh-whale-widget`（`link:` 安装）。它的做法是：宿主侧用 `ctx.webServer.register()` 提供 HTTP 路由 +
  `ctx.webServer.tapIndex()` 往 `index.html` 注入一个**自包含普通 JS 文件**作为前端，前端纯 DOM 挂载 UI。
- **本插件沿用同一路线**：不引入 TypeScript / tsdown / React 构建链，零 npm 依赖，纯 JS + YAML。
- **最大风险点已消除**：插件能否直接调用"已接入模型"——已实测本机三个 provider 的
  `POST {baseURL}/chat/completions` 全部 HTTP 200（`docs/probe-llm.mjs`）。
- **上下文来源已确认**：宿主 `ctx.on('session/event')` 的事件流里有
  `user/message`（含 `source.kind === 'user'`，可区分真人输入与系统注入）与 `assistant/message`。
- **唯一待决点**：如何把「优化后的提示词」交回给当前会话（详见第二部分 2.2 的路线取舍）。

完整证据链见 `docs/00-recon.md`。

### 1.3 阶段一交付物

| 文件 | 说明 |
|---|---|
| `docs/00-recon.md` | 侦察报告：插件机制、宿主 API、事件模型、模型链路实测 |
| `docs/probe-llm.mjs` | 模型链路探针（一次性验证脚本，不参与打包） |

---

## 第二部分：阶段二「架构设计建设」计划

### 2.1 总体架构

```
┌───────────────────────── 宿主侧 (Node, lib/index.js) ─────────────────────────┐
│  inject: ['webServer', 'credentials', 'connection']                          │
│                                                                              │
│  [A] 模型目录读取器   读 DSH settings.yaml → provider/baseURL/apiKeyEnv/models │
│                      读 .credentials.yaml → 解析 apiKeyEnv → 真实密钥         │
│  [B] 会话上下文采集器 ctx.on('session/event') → 按 sessionId 维护每轮         │
│                      {userText, assistantText} 环形缓冲（带条数/字数上限）     │
│  [C] 优化执行器       以 OpenAI 兼容 HTTP 调优化模型，带超时/重试/降级         │
│  [D] 配置存取         读: DSH_HOME/prompt-optimizer.json  写: 原子写回         │
│  [E] HTTP 路由        /dsh-prompt-optimizer/{config,optimize,models}.json     │
│                      全部套 connection.requestRejection 信任栅栏               │
│  [F] 前端注入         tapIndex → <script defer src="/dsh-prompt-optimizer/ui.js"> │
└──────────────────────────────────────────────────────────────────────────────┘
                                     ▲ HTTP (同源, 带浏览器会话凭据)
┌───────────────────────── 浏览器侧 (纯 JS, assets/ui.js) ──────────────────────┐
│  [G] composer 探测与挂载   轮询 #root 找输入区，插入「提示词优化」按钮        │
│  [H] 上拉菜单              模式切换(直接/优化) + 优化模型选择 + 预设选择      │
│  [I] 发送拦截              捕获阶段拦截 Enter/发送键 与 发送按钮点击          │
│  [J] 优化往返              调 /optimize.json → 拿回优化文本                    │
│  [K] 文本回填并放行        把优化文本写回 composer，再触发原生发送            │
│  [L] 设置区注入            在 Settings 视图挂载预设编辑器                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策：如何把优化结果交回会话

| 路线 | 做法 | 可行性 | 结论 |
|---|---|---|---|
| **A. 宿主改写本轮提示词** | 在宿主拦截本轮用户输入并替换后再入库 | 会话日志是 append-only 事件溯源，插件无"替换本轮提示词"的公开接入点；强行改需要伪造事件，破坏不变量 | ❌ 否决（不可靠且侵入） |
| **B. 客户端改写后由页面自身发送** | 优化完成后把文本写回 composer，再触发页面原生发送 | 与既有范例同源；`contenteditable` 可用 `selectAll + insertText` 走浏览器原生输入路径，与框架一致；零构建依赖 | ✅ **采用** |
| **C. 客户端包装 `ISession.prompt`** | 在页面内拿到会话对象并包装其 `prompt`，直接替换文本块 | 页面内未发现客户端 cordis 句柄的全局暴露点（shell 产物经检索无 `window.__DSH_*`），拿不到该对象 | ❌ 暂不可行（已记录为未来优化项） |

**路线 B 的两种交互形态（需你确认，见第四部分）**：

- **B-1 静默替换直发**：按发送 → 后台优化 → 直接发出优化后的提示词。最贴近"输出给当前会话模型"的原话，速度最快。
- **B-2 预览确认**：按发送 → 优化完成后弹出预览（可编辑）→ 你确认或取消。可控性最好，多一步点击。
- **建议**：默认 **B-1**，并在设置里提供开关切到 **B-2**——两种都实现，由设置决定。

### 2.3 关键设计决策：优化上下文如何组织

发给优化模型的请求结构（一次调用，无状态）：

```
system: <当前预设的工作说明>
user:   以下是本次会话已发生的对话记录：
        [第 1 轮]
        用户：<第 1 轮用户输入>
        助手：<第 1 轮助手输出>
        ...
        [本轮]
        用户：<用户刚刚输入的、待优化的提示词>      ← 优化目标

        请只输出优化后的提示词本身，不要任何解释、前后缀或 Markdown 代码块。
```

- 只采集 `source.kind === 'user'` 的真人输入（排除 `agent.inject()` 的系统上下文注入）与 `assistant/message` 的文本块。
- 上下文上限可配（默认：最近 10 轮 / 最多 6000 字符，取先到者），超出时从最旧截断。
- 助手输出仅取文本块，不取思考过程与工具调用。

### 2.4 关键设计决策：模型目录与凭据

- 从 `DSH_HOME/settings.yaml` 读取 `llm-*` 插件配置里的 `providers`（`baseURL` / `api` / `apiKeyEnv` / `models`），
  以及 `agent-default-model`。
- 密钥解析顺序：`.credentials.yaml` 的 `refs[apiKeyEnv]` → 进程环境变量 `apiKeyEnv`。（本机前三个 key 均在 `refs` 中。）
- 请求协议：`api: openai-completions` → `POST {baseURL}/chat/completions`（本机三个 provider 均此类）。
  其他 `api` 类型遇到时**不猜**，明确报"暂不支持"并在 UI 上置灰该模型。

### 2.5 数据与契约设计

**配置文件**（`DSH_HOME/prompt-optimizer.json`，原子写）：

```jsonc
{
  "version": 1,
  "enabled": true,
  "mode": "optimize",              // "direct" | "optimize"
  "modelRef": "volcengine-coding-plan/doubao-seed-2.1-pro",
  "presetId": "structured",
  "sendStrategy": "auto",          // "auto"(B-1) | "preview"(B-2)
  "context": { "maxTurns": 10, "maxChars": 6000 },
  "timeoutMs": 45000,
  "onFailure": "send-original",    // "send-original" | "cancel" | "notify"
  "presets": [
    {
      "id": "structured",
      "name": "结构化重写",
      "modelRef": "volcengine-coding-plan/doubao-seed-2.1-pro",
      "instruction": "<工作说明默认文本>",
      "builtin": true
    }
  ]
}
```

**HTTP 契约**（全部要求通过 `connection.requestRejection` 信任栅栏）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-prompt-optimizer/config.json` | 取当前配置 + 模型目录 + 预设列表 |
| POST | `/dsh-prompt-optimizer/config.json` | 局部更新配置并落盘 |
| POST | `/dsh-prompt-optimizer/optimize.json` | 入参 `{prompt, modelRef?, presetId?}`，出参 `{ok, optimized, model, elapsedMs, error?}` |
| GET | `/dsh-prompt-optimizer/ui.js` | 前端脚本 |
| GET | `/dsh-prompt-optimizer/state.json` | 前端读取当前会话上下文轮数与健康状态（用于 UI 提示） |

### 2.6 阶段二实施步骤

1. 复刻 `dsh-whale-widget` 的骨架（`package.json` + `cordis.patch.yml` + `lib/index.js` 路由与 tapIndex）。
2. 实现 `[A]` 模型目录读取器，写单测脚本验证能正确解析本机 `settings.yaml`。
3. 实现 `[B]` 会话上下文采集器，验证能拿到真实会话的输入/输出文本对。
4. 实现 `[C]` 优化执行器 + `[E]` 路由，用 `curl`/Node 端到端验证 `/optimize.json`。
5. 输出**接口冻结文档** `docs/02-api.md`（前端可独立开发所依赖的全部契约）。

### 2.7 阶段二验收标准（第一次验收）

- [ ] 目录骨架与 `cordis.patch.yml` 就绪，`package.json` 声明正确
- [ ] 模型目录读取器能从本机配置解析出 3 个 provider 及其模型清单（有实测输出）
- [ ] 会话上下文采集器能打印真实会话的 `{用户输入, 助手输出}` 轮次（有实测输出）
- [ ] `/optimize.json` 端到端跑通：给一句粗糙提示词，返回结构化优化结果（有实测输出）
- [ ] `docs/02-api.md` 接口冻结，前端实现不再需要改动后端契约

---

## 第三部分：后续阶段（代码编写 / 打包测试）预告

- **阶段三 代码编写**：按已冻结契约实现浏览器侧 `assets/ui.js`（composer 挂载、上拉菜单、发送拦截、回填放行、设置区注入）；
  实现全部内置预设的工作说明默认文本。产出 `docs/03-dev.md`。
- **阶段四 打包测试**：`dsh.cmd plugin --profile web add link:<dir>` 实机安装；
  在 `http://127.0.0.1:3080` 内实测四种场景（直接模式无副作用 / 优化模式生效 / 设置页预设编辑生效 / 失败降级）；
  产出 `docs/04-acceptance.md` 与使用说明 `README.md`。

**安全与范围约束**（贯穿全程）：

- 所有写入限制在 `prompt-optimizer/` 子目录内；插件运行时状态写 `DSH_HOME/prompt-optimizer.json`（经你确认）。
- 默认不启用；未启用时对页面**零副作用**。
- 所有自有路由强制走信任栅栏，防 DNS 重绑定与未认证访问。
- 密钥不落插件自有文件，只从 DSH 凭据/环境变量读取，且不写日志、不回传前端。

---

## 第四部分：需要你确认的事项

三项决策（交互形态、设置存储位置、修订范围）见本次提问。确认后我即进入阶段二。
