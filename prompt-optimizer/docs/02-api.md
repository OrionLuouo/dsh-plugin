# 02-api — 接口冻结（阶段二交付物）

> 本文件冻结插件对外/对内全部契约。阶段三写码时**不得再改动本文档定义的接口**；
> 若确需变更，必须回到阶段二重新评审。

---

## 1. 包与挂载

| 项 | 值 |
|---|---|
| 插件包名 | `dsh-prompt-optimizer` |
| 显示名 | 提示词优化 |
| 包根目录 | `prompt-optimizer/`（即本仓库根，`package.json` 位于此） |
| host 入口 | `lib/index.js`（ESM，零 npm 依赖） |
| 浏览器入口 | `assets/ui.js`（自包含普通 JS，由 host 路由原样吐出） |
| 挂载声明 | `cordis.patch.yml`：`- insert: [{ id: dsh-prompt-optimizer, name: dsh-prompt-optimizer }]` |
| 所需宿主服务 | `inject: ['webServer']`；`connection` 用 `ctx.get()` 可选获取（信任栅栏） |
| 命名空间前缀 | 路由 `/dsh-prompt-optimizer/`；DOM class 前缀 `dshpo-`；全局旗标 `window.__dshPromptOptimizer*` |

## 2. 配置文件

**路径**：`DSH_HOME/prompt-optimizer.json`（本机为 `C:\Users\18136\.dsh\prompt-optimizer.json`）
**写入方式**：临时文件 + rename 原子替换
**缺失时**：用下文的默认值即时生成并落盘

```jsonc
{
  "version": 1,

  // —— 总开关与模式 ——
  "enabled": true,              // 插件总开关；false 时对会话零副作用
  "mode": "direct",             // "direct" | "optimize"   直接输出模式 / 优化输出模式

  // —— 优化模型与预设 ——
  "presetId": "structured",     // 当前预设
  "modelRef": "volcengine-coding-plan/doubao-seed-2.1-pro",  // 覆盖预设自带模型；null 表示用预设自带的

  // —— 发送形态 ——
  "sendStrategy": "auto",       // "auto" 静默直发 | "preview" 预览确认

  // —— 上下文 ——
  "context": {
    "maxTurns": 10,             // 最多回溯多少轮
    "maxChars": 6000,           // 上下文总字符上限（先到者为准）
    "includeAssistant": true    // 是否包含助手输出
  },

  // —— 调用与降级 ——
  "timeoutMs": 45000,
  "onFailure": "send-original", // "send-original" 发原文 | "cancel" 取消发送 | "notify" 发原文并提示
  "maxOptimizeChars": 8000,     // 超过此长度的输入不优化，直接放行

  // —— 预设列表 ——
  "presets": [ /* 见 §3 */ ]
}
```

### 2.1 运行时状态（与配置分离，避免互相污染）

`DSH_HOME/prompt-optimizer.state.json`：

```jsonc
{
  "version": 1,
  "tickets": { "<sha256(optimizedText).slice(0,32)>": { "ticket": "...", "ts": 1730000000000, "modelRef": "..." } },
  "recent":  [ { "ts": 1730000000000, "sessionId": "...", "turn": 3, "ok": true, "modelRef": "...", "elapsedMs": 2100 } ]
}
```

- `tickets`：预览确认路径的一次性票据，TTL 5 分钟，消费即删。
- `recent`：最近 50 条优化记录，仅供 UI 显示与排障；**不含任何密钥、不含提示词正文**（只记长度）。

## 3. 内置预设（默认值，首次运行时写入配置）

每个预设 = 一个模型引用 + 一段工作说明。工作说明填入下列默认文本。

| id | 名称 | 默认模型 | 工作说明默认文本 |
|---|---|---|---|
| `structured` | 结构化重写 | `volcengine-coding-plan/doubao-seed-2.1-pro` | 见下方 P1 |
| `concise` | 精简明确 | `volcengine-agent-plan/glm-5.3` | 见下方 P2 |
| `coding` | 编码任务专用 | `volcengine-coding-plan/doubao-seed-2.1-pro` | 见下方 P3 |
| `analysis` | 分析研究专用 | `volcengine-agent-plan/glm-5.3` | 见下方 P4 |
| `faithful` | 保守润色 | `deepseek-official/deepseek-flash` | 见下方 P5 |

> 预设的 `modelRef` 只是**默认值**；用户在设置页或上拉菜单里改选模型后，写到顶层 `modelRef` 覆盖它。
> 每个预设的形状：
> ```jsonc
> { "id": "structured", "name": "结构化重写", "modelRef": "...", "instruction": "...", "builtin": true }
> ```
> `builtin: true` 的预设可编辑、可停用，但删除后会在下次启动时按 id 恢复（避免用户误删导致不可用）。

预设工作说明文本（正式实现时写入 `lib/presets.js`，此处为冻结内容）：

**P1 structured**
```
你是提示词工程专家。请把用户的最新输入改写为一条更高质量的提示词。

要求：
1. 保留用户的全部原始意图与约束，不新增用户未提出的需求。
2. 明确任务类型（问答／分析／编码／写作／翻译等）与期望的输出形态。
3. 把含糊的表述具体化：补全缺失的上下文、对象、范围与验收标准。
4. 如用户在历史对话中已有明确偏好或约束，应在新提示词中体现。
5. 语言与用户输入保持一致。
6. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。
```

**P2 concise**
```
你是提示词工程专家。请把用户的最新输入改写为一条简洁、无歧义、可直接执行的提示词。

要求：
1. 删除冗余寒暄、重复表述与无关背景，但不得删掉任何实质约束。
2. 一句话能说清就不写两句话；优先使用明确的动词与可核查的目标。
3. 保留用户的全部原始意图。
4. 语言与用户输入保持一致。
5. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。
```

**P3 coding**
```
你是资深软件工程师兼提示词工程专家。请把用户的最新输入改写为一条面向编码任务的高质量提示词。

要求：
1. 明确目标代码库／文件范围、当前行为与期望行为。
2. 明确技术栈、运行环境与约束（语言版本、依赖限制、兼容性要求）。
3. 明确验收标准：改完后如何验证（命令、测试、可观察结果）。
4. 指出已知的坑与不可破坏的既有行为。
5. 不改写用户的技术选型，只把需求表达具体化。
6. 语言与用户输入保持一致。
7. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。
```

**P4 analysis**
```
你是研究分析专家。请把用户的最新输入改写为一条结构化的分析型提示词。

要求：
1. 明确分析对象、分析目的与决策用途。
2. 明确需要覆盖的维度与希望得到的结论形态（对比表／优劣清单／建议方案等）。
3. 明确已知前提、待验证假设与信息缺口。
4. 要求给出依据与不确定性说明，而非只给结论。
5. 语言与用户输入保持一致。
6. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。
```

**P5 faithful**
```
你是细心的文字编辑。请对用户的最新输入做最小必要的改写，使其表达清晰、无歧义。

要求：
1. 严格保持原意、原有语气与原有详细程度，不做任何扩写或收缩。
2. 只修正语法、标点、指代不明与歧义表述。
3. 不添加用户没有提出的要求、约束或验收标准。
4. 语言与用户输入保持一致。
5. 只输出改写后的提示词本身，不要任何解释、前言、后缀或 Markdown 代码块包裹。
```

## 4. 发给优化模型的请求（冻结）

以 OpenAI 兼容方式调用：

```
POST {baseURL}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "<modelId>",
  "messages": [
    { "role": "system", "content": "<当前预设的 instruction>" },
    { "role": "user",   "content": "<下文的上下文 + 待优化输入>" }
  ],
  "max_tokens": 2048,
  "temperature": 0.3,
  "stream": false
}
```

user 消息体格式（冻结）：

```
以下是本次会话已发生的对话记录（可能为空）：
[第 1 轮]
用户：<该轮用户输入（若该轮经过优化，用优化后的文本）>
助手：<该轮助手输出；includeAssistant=false 时整行省略>
...
[第 N 轮]
用户：...

---

现在需要优化的、我最新输入的提示词是：
<待优化输入>

请按上述要求改写它。
```

**响应解析**：取 `choices[0].message.content`；`reasoning_content` 忽略。
**清洗**：去掉整体包裹的 ``` 代码块围栏与首尾空白；若结果为空或与原文完全相同，视为未优化。

## 5. HTTP 契约（冻结）

全部路由先过信任栅栏：`ctx.get('connection')?.requestRejection(req)`。
`kind: 'exact'`，响应一律 `Content-Type: application/json; charset=utf-8` 且 `Cache-Control: no-store`
（`ui.js` 除外，见 §5.6）。

### 5.1 `GET /dsh-prompt-optimizer/config.json`

```jsonc
{
  "ok": true,
  "config": { /* §2 的完整配置 */ },
  "catalog": {
    "groups": [
      { "provider": "volcengine-coding-plan", "displayName": "火山 Coding Plan", "api": "openai-completions",
        "models": [ { "id": "doubao-seed-2.1-pro", "name": "doubao-seed-2.1-pro" } ],
        "supported": true, "error": null }
    ],
    "defaultModelRef": "volcengine-coding-plan/doubao-seed-2.1-pro"
  },
  "sessions": { "currentContextTurns": 3, "sessionId": "..." }
}
```

- `supported: false` 的 provider（`api` 不是 `openai-completions`）在 UI 上置灰并给出 `error` 文案。

### 5.2 `POST /dsh-prompt-optimizer/config.json`

请求体为**局部更新**（深合并到用户层）：

```jsonc
{ "enabled": true, "mode": "optimize", "modelRef": "...", "presetId": "coding",
  "sendStrategy": "preview", "context": { "maxTurns": 6 },
  "presets": [ { "id": "structured", "instruction": "..." } ] }
```

响应：`{ "ok": true, "config": { /* 更新后的完整配置 */ } }`
校验失败：`{ "ok": false, "error": "可读的中文原因" }` + HTTP 400。

### 5.3 `POST /dsh-prompt-optimizer/optimize.json`

```jsonc
// 请求
{ "prompt": "待优化的提示词", "modelRef": "可选，覆盖配置", "presetId": "可选，覆盖配置",
  "sessionId": "可选，用于取上下文", "issueTicket": true }
```

```jsonc
// 成功
{ "ok": true, "optimized": "优化后的提示词", "modelRef": "...", "presetId": "...",
  "elapsedMs": 2100, "ticket": "预览确认路径用的一次性票据或 null",
  "changed": true }
// 失败（降级由前端按 onFailure 处理）
{ "ok": false, "error": "可读的中文原因", "code": "TIMEOUT|NO_KEY|HTTP_4XX|HTTP_5XX|BAD_RESPONSE|DISABLED" }
```

### 5.4 `GET /dsh-prompt-optimizer/status.json`

```jsonc
{ "ok": true, "enabled": true, "mode": "optimize", "modelRef": "...", "presetId": "...",
  "rewriter": { "createUserMessage": "bare|abspath|local", "preStepBound": true },
  "recent": [ /* §2.1 的 recent */ ], "pending": 0 }
```

用于排障与「优化中」状态的兜底轮询。

### 5.5 `GET /dsh-prompt-optimizer/original.json?sessionId=&rpcId=`

**仅在 `source` 追加字段被证实不可持久化时才会被前端使用**（退路方案）。

```jsonc
{ "ok": true, "original": "原始输入", "optimizedBy": "...", "presetId": "..." }
```

### 5.6 `GET /dsh-prompt-optimizer/ui.js`

`Content-Type: application/javascript; charset=utf-8`，`Cache-Control: no-store`。
文件内容按 mtime 缓存重读（沿用既有范例做法），改完硬刷新页面即生效。

## 6. 日志标记契约（冻结）

改写后的用户消息，`source` 在原 `'user-rpc'` 变体上追加：

```ts
'user-rpc': {
  kind: 'user'
  rpcId: SessionRequestId        // 硬约束：必须原样保留
  clientTimeZone?: string        // 原样保留
  // ↓ 本插件追加，全部可选
  poOptimized?: true
  poOriginalText?: string
  poOptimizedBy?: string         // "provider/model"
  poPresetId?: string
}
```

**硬约束（写进代码注释）**：

1. `rpcId` 与 `clientTimeZone` **必须原样保留**，否则浏览器乐观回显不退休、prompt 幂等去重失效。
2. **只替换真人消息**（`source.kind === 'user' && 'rpcId' in source`），
   `decision.messages` 里其余条目（尤其是末尾追加的 context 消息）**必须原样保留**。
3. 只处理 `step === 1`。

## 7. 前端 UI 契约（冻结）

| 元素 | 选择器/class | 行为 |
|---|---|---|
| 挂载点 | 轮询 `#root` 内 `textarea` 或 `[contenteditable="true"]` 的 composer | 与既有范例一致 |
| 主按钮 | `.dshpo-trigger` | 位于 composer 卡片**左侧**（同一行）；显示当前模式；点击展开上拉菜单 |
| 布局行 | `[data-dshpo-node="row"]` | 插在卡片与其父元素之间的横向 flex 行，使按钮排在卡片左侧 |
| 上拉菜单 | `.dshpo-menu` | 挂在 `document.body` 上、按按钮坐标 `position: fixed` 定位（避免被 composer 的 `overflow` 裁切）；含模式切换、优化模型、预设选择 |
| 优化中指示 | `.dshpo-busy` | 按钮文案变为「优化中…」，优化调用期间显示 |
| 失败提示 | `.dshpo-toast` | 降级为发原文时提示原因 |
| 轮次标记 | `.dshpo-badge` | 挂在已优化的用户消息上，文案「已优化」；点击在「优化后 / 原文」之间切换 |
| 设置面板 | `.dshpo-settings` | 自持弹窗：总开关、模式、发送方式、失败策略、上下文上限、各预设的模型与工作说明编辑 |

### 7.2 主题适配（必须遵守的约定）

前端脚本**不得硬编码任何颜色**，所有颜色必须取自 DSH 的主题 token：

- 深色模式标记：`body[data-ds-dark-theme]`
- token 前缀：`--dsw-*`（全部 token 都在该标记下被重新定义，因此用 token 即自动适配明暗两套）

本插件实际使用的 token（均已逐个核验存在）：

| 用途 | token |
|---|---|
| 弹窗/菜单底色 | `--dsw-specific-menu`、`--dsw-alias-bg-layer-1` / `-2` |
| 文字 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-primary-foreground` |
| 描边 | `--dsw-alias-border-inverted`、`--dsw-alias-border-l1` / `-l2` |
| 交互背景 | `--dsw-alias-interactive-bg-hover` / `-active`、`--dsw-alias-button-tool-bar-fill` / `-hover` |
| 强调色 | `--dsw-alias-brand-primary`（**注意：这是单色品牌色，亮色近黑、暗色近白，不是蓝色**） |
| 蓝色强调（选中态） | `--dsw-static-blue-500`(`#3b82f6`) / `--dsw-static-blue-600`(`#2563eb`)，明暗两套同值 |
| 反馈 | `--dsw-alias-state-error-primary`、`--dsw-alias-toast-bg`、`--dsw-alias-state-warn-primary` |
| 阴影/遮罩 | `--dsw-elevation-prominent`、`--dsw-alias-bg-mask-1` |

> 教训：最初实现用了 `--dsh-color-surface` / `--dsh-color-text` 这类**并不存在**的变量名，
> 回退值恰好是白色，导致深色模式下白底白字完全看不清。**写样式前必须先核验 token 名。**

### 7.1 关于「设置页」的实现方式（对 `02-architecture.md` 的修订）

架构文档原计划把设置区**注入到 DSH 的设置视图**（`settings.section` slot）。实机情况与修订后的做法：

- `settings.section` 是**官方客户端插件**（预打包 lazy-CJS bundle）才能注册的 slot；
  DSH 的 `clientBundle` 构建预设**未随安装包发布**，官方 README 明说出树插件必须自行复刻该构建链。
  本仓库要求零构建依赖，因此无法走这条 slot 路线。
- **实际做法**：设置面板做成**插件自持的弹窗**，从输入框旁的「提示词优化」菜单里的「打开设置」进入。
  它的能力与计划中的设置区**完全等价**（开关、模式、发送方式、失败策略、上下文上限、
  每个预设的模型与工作说明编辑、保存与校验），且不依赖 DSH 设置页的 DOM 结构，
  升级 DSH 时更不易坏。
- 该弹窗同时可通过 `window.__dshPromptOptimizerSettings()` 从控制台打开，便于排障。

若后续你希望它出现在 DSH 设置页里，可行路径是补上官方客户端插件构建链（需引入 tsdown 与
自建 externalization 配置），属于独立工作量，已列入后续迭代清单。

**全局旗标**：`window.__dshPromptOptimizer`（已初始化）、`window.__dshPromptOptimizerMenu`（菜单实例）、
`window.__dshPromptOptimizerBusy`（当前是否正在优化）。

## 8. 模块划分（阶段三实施清单）

宿主侧 `lib/`：

| 文件 | 职责 | 是否可离线自检 |
|---|---|---|
| `config.js` | 配置读写＋默认值＋深合并＋原子写 | ✅ |
| `presets.js` | 5 个内置预设与工作说明文本 | ✅ |
| `catalog.js` | 解析 `DSH_HOME/settings.yaml` → provider/模型清单 | ✅ |
| `credentials.js` | 解析 `.credentials.yaml` 的 `refs` → 密钥；环境变量兜底 | ✅ |
| `context.js` | 从消息数组拼优化上下文（含上限截断） | ✅ |
| `optimize.js` | OpenAI 兼容调用＋超时＋清洗＋降级 | ✅（可打桩） |
| `rewriter.js` | `agent/pre-step` 监听与改写（含 CREATE_USER_MESSAGE 三级回退） | ⚠️ 需挂载 |
| `routes.js` | 全部 HTTP 路由＋信任栅栏 | ⚠️ 需挂载 |
| `index.js` | 组装、`inject`、`ctx.effect` 清理、`tapIndex` 注入 | ⚠️ 需挂载 |

浏览器侧 `assets/ui.js`：自包含单文件，按 §7 的职责分段实现。

**离线自检**：`tools/selfcheck.mjs`，覆盖标记 ✅ 的全部模块，不依赖挂载。
