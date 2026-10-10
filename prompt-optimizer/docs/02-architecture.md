# 02 — 阶段二：架构设计（修订版）

> 本文档在阶段一侦察完成、三份专项调研报告到齐后修订。**相比阶段一计划，核心技术路线发生了方向性变更**，
> 变更理由与依据见 §1。

---

## 1. 方向性变更：从「客户端 DOM 改写」改为「宿主侧官方改写点」

阶段一计划里我给出的首选路线是「客户端改写 composer 后由页面自身发送」（路线 B），
理由是当时没找到官方的提示词改写接入点。**专项调研推翻了这个判断**，找到了官方唯一且语义精确的改写点：

### 1.1 官方改写点：`agent/pre-step`（waterfall 事件）

```ts
// dsh-agent/lib/types/runtime-types.d.ts:313
'agent/pre-step'(this: Scoped<Agent>, payload: {
    agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal;
}, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>

// 同文件 :91-99
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

已核实的语义（全部有 `.d.ts` / 源码出处）：

| 性质 | 结论 |
|---|---|
| 支持异步 | 是，waterfall 的 `next()` 返回 Promise，监听器可为 `async` |
| 可改写 | 返回 `{kind:'enter', messages}` 即替换进入该 step 的消息 |
| 改写会持久化 | `decision.messages` 被逐条 `session.append('user/message', …)`（`dsh-agent-loop/lib/index.js:1028`） |
| 改写对模型可见 | 请求由 `deriveMessages()` 派生，模型看到的是改写后的文本 |
| 可挂在插件根 ctx | 是，收到**所有** agent 的事件 |
| 消息对象不可原地改 | `Message` 经 `createUserMessage` → `deepFreeze` 深冻结（`dsh-llm/lib/types/message.js:26-50`），必须造新对象 |
| 每个 step 都触发 | 是，**必须只处理 `step === 1`**，否则会重复处理 |

**被否决的其它候选点**（均已核实不可行）：

| 候选点 | 否决理由 |
|---|---|
| `llm/stream` waterfall | loop 构造的请求 deep-frozen，文档明令 "listeners read it, **never rewrite it**"（`dsh-llm/lib/types/index.d.ts:33-45`） |
| `agent/request` waterfall | 文档明写 "this waterfall **cannot mutate messages**"（只换 provider/model 路由） |
| `system-prompt/assemble` | 只影响系统提示词 |
| Claude Code / Codex 的 `hooks.json` | `UserPromptSubmit` 只支持 reject + 追加 context；`updatedInput` 被解析但**不落地**（`dsh-hook-protocol/lib/types/types.d.ts:126`） |
| 客户端包装 `ISession.prompt` | 页面内没有客户端 cordis 句柄的全局暴露点，拿不到该对象 |
| 客户端 DOM 改写 composer | 能work但有 React 受控组件一致性风险，且**无法被其它入口（队列/steer/子代理）复用**。降级为仅承担「预览确认」职责 |

### 1.2 「不改日志结构」的可行性：`MessageSourceMap` 是声明合并开放的

原需求里你担心"这可能需要对日志结构进行一点修改"。调研结论：**不需要改日志结构，只需要扩展消息来源的元数据**，
因为 DSH 的消息来源类型本身就是为插件扩展设计的：

```ts
// dsh-llm/lib/types/message.d.ts:90-104
/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
export interface MessageSourceMap {
    user: { kind: 'user' };
    plugin: { kind: 'plugin'; plugin: string } & ContextFormed;
    model: ModelMessageSource;
    tool: ToolMessageSource;
}
```

而且官方自己就是这么扩展的：

```ts
// dsh-api-session-controller/lib/types/types.d.ts:346-355
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Browser prompt correlation and optional Host-validated time zone. */
        'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string };
    }
}
```

**本插件的设计**：不新增 `kind`，而是在已有 `'user-rpc'` 变体上**追加可选字段**——这样既保留了
`rpcId`（浏览器乐观回显靠它退休、prompt 幂等去重 `hasPromptRequest` 靠它生效），又携带了原始输入：

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    // 追加到既有的 'user-rpc' 变体（同 kind，不影响任何既有判据）
    'user-rpc': {
      kind: 'user';
      rpcId: SessionRequestId;
      clientTimeZone?: string;
      // ↓ 本插件追加
      /** 优化前的原始输入；仅当本轮经过优化时存在。 */
      poOriginalText?: string;
      /** 执行优化的模型，形如 "volcengine-coding-plan/doubao-seed-2.1-pro"。 */
      poOptimizedBy?: string;
      /** 使用的预设 id。 */
      poPresetId?: string;
      /** 标记位：便于消费方快速判断而不必检查其它字段。 */
      poOptimized?: true;
    };
  }
}
```

> **这仍是本设计的唯一技术不确定性**，已启动探针任务验证「追加字段能否在写入会话日志后原样读回」
> （见 `probe/probe-log.jsonl` 与探针报告）。若结论为「会被序列化器剥离」，退路是：
> 插件自持一个 `rpcId → {originalText, optimizedBy}` 的映射持久化在 `DSH_HOME/prompt-optimizer.json`，
> 前端通过 `GET /original.json?rpcId=` 反查。**功能等价，只是多一次查询**，不影响架构。

---

## 2. 修订后的总体架构

```
┌────────────────────────── 宿主侧 (Node, lib/index.js) ─────────────────────────┐
│  export const name = 'dsh-prompt-optimizer'                                    │
│  export const inject = ['webServer']                                           │
│                                                                                │
│  ┌─ 提示词改写（核心）───────────────────────────────────────────────────────┐  │
│  │ ctx.on('agent/pre-step', async ({agent, messages, turn, step, signal}, next)│ │
│  │   → await next()                                                            │ │
│  │   → step !== 1 或 mode !== 'optimize' → 原样返回                            │ │
│  │   → 对 source.kind==='user' && 'rpcId' in source 的消息：                    │ │
│  │       取文本 → 采集上下文 → 调优化模型 → createUserMessage(保留 source+追加标记) │ │
│  │   → 返回 {kind:'enter', messages: rewritten}                                │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  [A] 模型目录读取器   解析 DSH settings.yaml → provider/baseURL/model 清单       │
│  [B] 凭据解析器       .credentials.yaml 的 refs[apiKeyEnv] → 环境变量兜底        │
│  [C] 优化执行器       OpenAI 兼容 POST /chat/completions，带超时/降级           │
│  [D] 上下文采集       从 decision.messages / agent.session.deriveMessages() 取历史 │
│  [E] 配置存取         DSH_HOME/prompt-optimizer.json（原子写）                  │
│  [F] HTTP 路由        /dsh-prompt-optimizer/{config,optimize,preview,status}.json │
│                       全部套 connection.requestRejection 信任栅栏               │
│  [G] 前端注入         tapIndex → <script defer src="/dsh-prompt-optimizer/ui.js"> │
└────────────────────────────────────────────────────────────────────────────────┘
                                     ▲ HTTP (同源)
┌────────────────────────── 浏览器侧 (纯 JS, assets/ui.js) ───────────────────────┐
│  [H] composer 挂载        轮询 #root 找到输入区，插入「提示词优化」按钮          │
│  [I] 上拉菜单             模式切换（直接/优化）+ 优化模型选择 + 预设选择         │
│  [J] 预览确认（可选形态）  当 sendStrategy==='preview'：按发送 → 调 /preview.json │
│                           → 弹窗展示并允许编辑 → 确认后写回 composer 并放行发送  │
│  [K] 轮次标记与切换        对已优化的轮次渲染「已优化 / 原文」切换               │
│  [L] 设置区注入            在 Settings 视图挂载预设编辑器                        │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 两种发送形态如何共存而不重复优化

这是修订后必须解决的关键问题。

- **形态一：静默直发（默认）** —— 前端**完全不介入发送流程**。用户按发送，
  浏览器走原生 `ISession.prompt`；宿主在 `agent/pre-step` 里完成优化后才交给模型。
  用户感知：等待时间略增（优化调用耗时），但不需要任何额外操作。
- **形态二：预览确认（可切换）** —— 前端**接管**发送：按发送 → `preventDefault` →
  调 `POST /preview.json` 拿优化结果 → 弹窗（可编辑）→ 用户确认 → 把结果写回 composer 并
  由页面自身发送。

> **重复优化的风险与规避**：形态二里，前端已经优化过一次，但宿主侧的 `agent/pre-step`
> 仍会看到这条提示词并再次优化。
>
> **规避方案**：`/preview.json` 返回优化结果的同时返回一个一次性票据 `ticket`；
> 前端把结果写回 composer 时，在**插件自己的待发队列**里登记 `{textHash → ticket}`。
> 宿主侧 `agent/pre-step` 收到提示词时，先查「文本 hash 是否命中未消费的票据」：
> 命中 → 直接放行（但仍执行标记逻辑），并消费该票据；未命中 → 正常优化。
> 票据由 `DSH_HOME/prompt-optimizer.json` 的旁路文件 `tickets.json` 承载，带 TTL（默认 5 分钟）。

### 2.1.1 形态二的两个已知副作用（需在设计评审时确认取舍）

认真推演形态二的数据流后，有两个**无法靠票据机制消除**的副作用，必须明说：

**副作用 A —— 本地乐观回显会先用原文显示。**

浏览器在提交时会先插入一条本地乐观回显（`PendingSubmission`，字段注释原文：*"Prompt text exactly as
it will be sent (one text block)"*，`dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts:58`），
随后才用 `rpcId` 与持久消息对账（*"the durable `user/message` source echoes it as `rpcId`"*，同文件 `:52`）。

- **形态一（静默直发）**：宿主改写发生在提交**之后**，所以浏览器先显示原文，优化完成后才被对账替换为优化文本
  → 用户可能看到一次「原文闪现后变优化文」的跳变。
- **形态二（预览确认）**：前端写回 composer 的**已经是优化文本**，所以乐观回显从一开始就是优化文本，无跳变。

**副作用 B —— 对账时可能有可见跳变。**

由于改写在 `agent/pre-step` 里 `await next()` **之后**才发生（必须先调用 `next()` 才能拿到本轮消息），
宿主处理耗时会叠加在浏览器的 pending 状态上。这段延迟内界面显示原文；对账完成后切换为优化文本。

> **取舍结论**：这两点是**视觉层面的轻微瑕疵，不是功能缺陷**——模型始终收到优化后的文本，
> 且持久日志里的也是优化文本。若评审认为难以接受，可选处置（按侵入性递增）：
>
> 1. **接受现状**并在 UI 上明示「优化中…」状态（推荐，零额外风险）；
> 2. 让 `input.left` 的按钮在优化期间显示进度，把跳变解释为"优化完成"；
> 3. 改为「前端先优化再发送」的**唯一**路径（即形态二成为唯一形态），彻底消除跳变，
>    代价是宿主侧 `agent/pre-step` 退化为只做标记与兜底（其它入口仍能受益）。
>
> 我倾向 **1**；若你更看重观感一致性，选 **3** 也很干净。此项留待第一次验收时定稿。

> **待探针回答的关联问题**：`createUserMessage` 是否允许指定/保留消息 `id`，
> 以及改写是否必须复用原 `message.id` 才能让浏览器对账严格命中。探针任务已一并覆盖。

### 2.2 上下文如何组织

```text
system: <当前预设的工作说明>

user:   以下是本次会话已发生的对话记录：
        [第 1 轮]
        用户：<第 1 轮用户输入>
        助手：<第 1 轮助手输出>
        ...
        [本轮]
        用户：<用户刚刚输入的、待优化的提示词>

        请只输出优化后的提示词本身，不要任何解释、前后缀或 Markdown 代码块。
```

- **只采集真人输入**：`source.kind === 'user' && 'rpcId' in source`，
  排除 `agent.inject()` 的系统上下文注入（那类 source 是 `{kind:'plugin'}`）。
- **助手输出**：优先取 `assistant/message` 事件的文本块。
- **按要求，上下文中拼接的是"优化后的输入提示词"**（你补充的要求）：
  若某轮已被优化，`poOriginalText` 存在，则**上下文里用优化后的文本**（即消息当前 content）。
- 上限可配（默认最近 10 轮 / 最多 6000 字符，取先到者），超出从最旧截断。

### 2.3 轮次标记与「原文 / 优化文」切换

- **标记**：改写后的消息 `source` 带 `poOptimized: true` 与 `poOriginalText`（见 §1.2）。
  这既是持久标记，也是 UI 的数据来源，**零日志结构改动**。
- **切换 UI**：前端在会话渲染区找到对应的用户消息节点，注入一个「已优化 ▾」标记，
  点击后在「优化后 / 原文」之间切换显示。原文从 `source.poOriginalText` 取；
  若退路方案生效（字段被剥离），则改调 `GET /original.json?rpcId=` 反查。
- **上下文拼接**：如 §2.2，始终拼**优化后**的文本。

---

## 3. 兼容性与风险

| 风险 | 等级 | 处置 |
|---|---|---|
| `source` 追加字段被序列化器剥离 | 中 | 探针正在验证；有等价的映射表退路方案（§1.2） |
| `agent/pre-step` 改写在某些入口不触发（子代理） | 低 | 只处理真人 `user-rpc` 来源；子代理输入非 `rpcId` 来源，天然不受影响 |
| 优化调用耗时拖慢首字响应 | 中 | 默认 45s 超时；失败降级策略可选「发原文」；UI 在 `input.left` 显示"优化中"状态 |
| 前端 DOM 结构随 DSH 升级变化 | 中 | 沿用 whale-widget 已验证的探测策略（轮询 `#root` 找 composer），并在选择器上做多重回退 |
| 新增 bundle 必须重启 `dsh web` | 确定 | 实机安装时需你在合适时机重启；我会先把一切准备好再通知你 |
| 破坏浏览器乐观回显 | 高（若处置不当） | **始终保留原 `source.rpcId`**，这是硬约束，写进代码注释 |

## 4. 阶段二交付物与验收标准

| 交付物 | 状态 |
|---|---|
| `docs/00-recon.md` | ✅ 完成 |
| `docs/01-phase1-and-phase2-plan.md` | ✅ 完成（阶段一成果 + 初版计划） |
| `docs/02-architecture.md` | ✅ 本文（修订版架构） |
| `docs/02-api.md` | 待写（接口冻结，前端可独立开发） |
| `probe/` 探针与验证报告 | 进行中 |

**第一次验收标准**：

- [ ] `agent/pre-step` 改写在真实会话中生效，且 `rpcId` 保留（不破坏回显）—— 探针验证
- [ ] `source` 追加字段的持久化结论明确（成立则按 §1.2 主方案；不成立则启用退路方案）
- [ ] 旁路 LLM 调用在 `agent/pre-step` 内可行且不污染会话 —— 探针验证
- [ ] `dsh plugin add` 自动挂载到 profile 成立（不需手写 profile 配置）—— 探针验证
- [ ] `docs/02-api.md` 接口冻结

## 5. 阶段三、四预告（不变）

- **阶段三 代码编写**：宿主侧改写器 + 执行器 + 路由；浏览器侧挂载、菜单、标记切换、设置区。
- **阶段四 打包测试**：实机安装 + 四场景端到端验收（直接模式零副作用 / 优化模式生效 /
  预览确认 / 标记切换 / 设置页预设编辑生效 / 失败降级）+ 彻底卸载验证。
