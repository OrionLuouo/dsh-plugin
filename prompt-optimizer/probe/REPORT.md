# dsh-po-probe 技术探针报告

日期：2026-10-02（本机）
执行者：子代理 session（父代理 `session-7a49f5b1-29f1-4fb1-8a06-12a14f5f1ad8`）
探针源码：`A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\probe\dsh-po-probe\`

## 0. 结论速览

| # | 问题 | 结论 | 证据强度 |
| --- | --- | --- | --- |
| 1 | `agent/pre-step` 能否拿到本轮真人输入文本并成功改写？ | **源码层面成立**：pre-step 的 `decision.messages` 就是被写入 `user/message` 的那批消息。**未能在真实会话中实测**（插件没装上去）。 | 源码确证 + 未能实测 |
| 2 | 给 `source` 追加自定义字段，落盘再读回是否仍在？ | **源码层面成立**（`append` 对 `data` 做无损 JSON 校验与快照，未做字段白名单；`MessageSourceMap` 是声明合并开放的）。**未实测**（`/selftest.json` 未生效）。 | 源码确证 + 未能实测 |
| 3 | `agent/pre-step` 里发旁路 LLM 调用是否可行且不污染主会话？ | **未实测**。 | 未验证 |
| — | 「`dsh plugin add` 自动挂载、不需要手写 profile 配置」 | **未能证伪也未能证实**：`dsh plugin add` 在安装阶段就被挡住（见 §3）。 | 受阻 |

**一句话原因**：`dsh plugin` 实际是 **pnpm 的透传**，`add` 需要在 `C:\Users\18136\.dsh\profiles\web\node_modules\` 下**创建符号链接**。该路径在我的沙箱写权限之外，且本机未开启开发者模式（`HKLM\...\AppModelUnlock` 键不存在），创建符号链接返回 `EPERM / os error 5（拒绝访问）`。所以插件从未挂载，`/dsh-po-probe/*` 全部 404。

---

## 1. 三个问题的确切答案

### Q1 `agent/pre-step` 能否拿到「本轮真人输入文本」并改写？

**能改写的机制已被源码确证，但我没能在真实会话里实测。**

源码证据链（三条互相印证）：

1. 水合契约 —— `...\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts:313-319`：
   ```ts
   'agent/pre-step'(this: Scoped<Agent>, payload: {
       agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal;
   }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
   ```
   返回值 `PreStepDecision`（同文件 `:92-99`）：`{kind:'reject'}` | `{kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true}`。

2. 派发点 —— `...\@deepseek-ai\dsh-agent-loop\lib\index.js:894-901`：
   ```js
   const decision = await this.dispatch.waterfall("agent/pre-step", {
       messages: claimed, ...position, signal
   }, () => Promise.resolve({
       kind: "enter",
       messages: context === void 0 ? claimed : [...claimed, context]
   }));
   ```
   默认 `next()` 返回的就是 `claimed`（本轮从 inbox 取出的真人消息）。

3. **关键：被替换后的消息确实会写入会话日志** —— `...\@deepseek-ai\dsh-agent-loop\lib\index.js:1028`：
   ```js
   if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });
   ```
   写的是 `decision.messages`（即 waterfall 的最终结果），不是 `claimed`。所以监听器返回新数组即可替换进入该 step 的消息，**并且会被写入会话日志**（问题描述里的假设在这点上成立）。

4. 真人判据 —— `...\@deepseek-ai\dsh-api-session-controller\lib\types\types.d.ts:344-355`：
   ```ts
   export type SessionRequestId = Branded<'session-request-id'>;
   declare module '@deepseek-ai/dsh-llm' {
       interface MessageSourceMap {
           'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string; };
       }
   }
   ```
   与问题描述一致：`source.kind === 'user' && 'rpcId' in source`。

**没能实测的部分（诚实声明）**：我没有在真实 GUI 会话里观察到一次 `pre-step` 事件，也没有观察到一次成功改写。探针里已经写好了记录逻辑（`status.json` 的 `preStepCount` / `lastPreStep` / `recentInMemory` 里的 `pre-step` 条目，以及 `rewrite` 条目含 `rpcIdPreserved`），只要插件挂上并有人从 GUI 发一句话就能立刻取证。

**顺带发现的一个实现风险**：`payload.messages` 是「从 inbox 领出」的消息，而 `decision.messages` 默认还会在末尾**追加一个 context 消息**（`index.js:900` 的 `[...claimed, context]`）。因此**不能**用 `decision.messages` 整体替换，必须只替换其中 `isHumanMessage()` 的那部分、其余原样保留 —— 探针就是这么写的。

### Q2 自定义 `source` 字段落盘后能否读回？

**源码层面：能。未实测。**

依据：

1. `Session.append` 的契约（`...\@deepseek-ai\dsh-session\lib\types\index.d.ts:209-238`）明确写：
   > `@param data - The event payload; must be JSON-serializable.`
   > `@throws if data or surface metadata is not losslessly JSON-serializable (BigInt, function, symbol, undefined, ...)`
   > `@returns the logged event — its assigned seq/time plus the SNAPSHOT of data that entered the log, so reading event.data back sees the logged value`

   校验是**无损 JSON 可序列化性**，不是字段白名单。自定义字符串字段 `originalText` / `optimizedBy` 完全在许可范围内。

2. `MessageSourceMap` 是声明合并开放的（`...\@deepseek-ai\dsh-llm\lib\types\message.d.ts:90-104`，注释原文："Merge-extensible sum type — plugins add their own kinds."），追加字段不违反任何不变量校验。

3. 我做的**离线 JSON 往返验证**（`probe\offline-check.mjs` 的实际输出）：
   ```
   localMessage = {"content":[{"type":"text","text":"PO-SELFTEST"}],"source":{"kind":"user","rpcId":"po-selftest-1","originalText":"原始文本","optimizedBy":"x/y"},"role":"user","id":"e13cfb16-..."}
   roundTripSource = {"kind":"user","rpcId":"po-selftest-1","originalText":"原始文本","optimizedBy":"x/y"}
   roundTripPreservesCustomFields = true
   ```
   注意：这只是 JSON 序列化层，**不等于** DSH 的 `append` + `readSession` 链路验证。后者没跑到。

4. 一个已确证的**副作用**（对「标记优化轮次 + 存原始输入」的方案很重要）：`createUserMessage` 会给消息**分配新的 `id`**（`...\@deepseek-ai\dsh-llm\lib\types\message.js:34-50`，`id: brandString(randomUUID())`）。所以改写会换掉 message id；`source.rpcId` 保留才是浏览器乐观回显退休的关键，这个设计判断是对的。

### Q3 旁路 LLM 调用是否可行且不污染主会话？

**未验证。** 插件没加载，`/dsh-po-probe/llmcheck.json` 未生效，一次真实旁路调用都没发出。

已准备好但未执行的东西：
- 探针内用 Node `fetch` 打 `POST {baseURL}/chat/completions`（不依赖 `ctx.llm`），key 从 `%DSH_HOME%\.credentials.yaml` 的 `refs:` 段读。
- 我已离线确证凭据解析可用（真实输出，key 值脱敏）：
  ```
  credentials ok= true refNames= [ 'DEEPSEEK_API_KEY', 'VOLCENGINE_CODING_PLAN_API_KEY', 'VOLCENGINE_AGENT_PLAN_API_KEY' ]
  apiKey present for DEEPSEEK_API_KEY = true
  apiKey present for VOLCENGINE_CODING_PLAN_API_KEY = true
  settings ok= true providers= {
    "volcengine-coding-plan": { "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3", "apiKeyEnv": "VOLCENGINE_CODING_PLAN_API_KEY" },
    "volcengine-agent-plan": { "baseURL": "https://ark.cn-beijing.volces.com/api/plan/v3", "apiKeyEnv": "VOLCENGINE_AGENT_PLAN_API_KEY" }
  }
  ```
- 「不污染主会话」在设计上成立：旁路调用只在 `pre-step` 监听器内部完成，**不 append 任何 session 事件**；唯一写盘是探针自己的 `probe-log.jsonl`。改写时通过 `decision.messages` 替换进入 step 的消息，属于主会话的正常历史，不是污染。

**离线自检脚本**：`probe\offline-check.mjs`（不启动 DSH、纯 Node，`node offline-check.mjs` 即可重跑上面的输出）。

---

## 2. `dsh plugin add` 后 profile `package.json` 的实际内容

**没有变化。** `add` 失败发生在 pnpm 写 `package.json` **之前**（在创建符号链接阶段），所以 profile 的 `package.json` 与安装前逐字相同。我也确认了 `pnpm-lock.yaml` / `cordis.yml` / `cordis.patch.yml` 里没有任何 `dsh-po-probe` 残留。

安装后实测（把 `dsh-whale-widget` 作为既有先例一并列出）：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-whale-widget": "link:A:/document/studio/agent/deepseek harness/plugin/dsh-whale-widget-0.3.2-package"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-whale-widget"
      ],
      "patchReload": "live"
    }
  }
}
```

`node_modules` 目录：只有 `dsh-whale-widget`（Junction）、`.pnpm`、`.modules.yaml`、`.pnpm-workspace-state-v1.json`。

**结论**：「`dsh plugin add` 会自动把包名追加进 `dsh.profile.bundles`、并在 `node_modules` 建链接、从而不需要手写 profile 配置」这个假设 —— **本次未能证实也未能证伪**。`bundles` 里 `dsh-whale-widget` 的存在说明该机制对某个先例确实生效过（但那次也可能是手工装的，因为它是 **Junction** 而 pnpm 默认建的是符号链接）。

---

## 3. 为什么装不上：真实报错与诊断

### 3.1 `dsh plugin` = pnpm 透传（已确证）

```
> dsh.cmd plugin --profile web --help
Package manager

Usage: pnpm [OPTIONS] <COMMAND>
Commands:
  access ... add ... remove ... link ...
```

所以 `add` 的语义就是 `pnpm add <spec>`，在 profile 目录里执行。

### 3.2 三次尝试的原始输出

**尝试 1**（任务给的原始命令，PowerShell 直接传带空格参数）：
```
dsh.cmd : Error: ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST
  × adding a new package
  ╰─▶ Failed to resolve the latest version of harness\plugindev\prompt-
      optimizer\probe\dsh-po-probe: ... HTTP status client error (404 Not Found)
      for url (https://registry.npmjs.org/harness%5Cplugindev%5Cprompt-optimizer%5Cprobe%5Cdsh-po-probe)
dsh: pnpm failed in profile directory C:\Users\18136\.dsh\profiles\web
[exit=1]
```
→ 路径里的空格把参数切开了，只剩前半段被当成包名。顺带确证：**探针路径含空格本身就是一个坑**。

**尝试 2**（用变量持有完整参数，避免外层切分）：
```
× adding a new package
╰─▶ Failed to resolve the latest version of harness\plugindev\prompt-optimizer\probe\dsh-po-probe: ...
```
→ 同样被切开。`dsh.cmd` 这个 `.cmd` shim 在 Windows 命令行重解析时丢掉了引号。**结论：`dsh plugin add link:<含空格的绝对路径>` 在当前 PowerShell → `dsh.cmd` 链路上无法把带空格的路径作为单个参数送达 pnpm。**（这是独立于后续符号链接问题的第二个坑。）

**尝试 3**（把空格换成 `%20` 规避参数切分）：
```
Already up to date
dsh.cmd : Error: ERR_PNPM_PACKAGE_MANAGER_SYMLINK_FAILED
  × adding a new package
  ╰─▶ Failed to symlink "dsh-po-probe" for importer ".": Failed to create
      symlink at "C:\Users\18136\.dsh\profiles\web\node_modules\dsh-po-probe"
      to "A:\document\studio\...\deepseek%20harness\...\probe\dsh-po-probe": 拒绝访问。 (os error 5)
dsh: pnpm failed in profile directory C:\Users\18136\.dsh\profiles\web
[exit=1]
```
→ 参数送达了，但**符号链接创建被拒**（`os error 5`）。注意 `%20` 是字面量没被解码，说明这条路本身也不对，但即便路径正确，符号链接这关也过不去（见下）。

### 3.3 诊断：是权限，不是路径

我用 Node 直接做了能力矩阵测试：

| 操作 | 目标位置 | 结果 |
| --- | --- | --- |
| `fs.symlinkSync(target, link, 'dir')` | 工作区内 `A:\...\plugindev\prompt-optimizer\probe\_symtest` | **EPERM** |
| `fs.symlinkSync(target, link, 'junction')` | 工作区内（同上） | **OK** |
| `fs.symlinkSync(target, link, 'dir')` | profile 的 `node_modules\dsh-po-probe` | **EPERM** |
| `fs.symlinkSync(target, link, 'junction')` | profile 的 `node_modules\dsh-po-probe` | **EPERM** |
| `Set-Content` 任意文件 | `C:\Users\18136\.dsh\profiles\web\.po-write-test` | **拒绝访问**（沙箱标记：`file access denied under workspace-write mode`） |
| `New-Item / Junction` | `A:\dsh-po-probe-link`（工作区外） | **拒绝访问**（同一沙箱标记） |
| `cmd /c mklink /J` | `C:\Users\18136\AppData\Local\Temp\po-junc-c` | **拒绝访问** |

另外：
- 注册表 `HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock` **不存在** → 未开启开发者模式 → 普通权限下创建符号链接必然 `EPERM`。
- 当前进程完整性级别 `Mandatory Label\Medium Mandatory Level`，`BUILTIN\Administrators` 标记为 "Group used for deny only" → **非提升**。

**结论**：`dsh plugin add`（= `pnpm add`）要在 `C:\Users\18136\.dsh\profiles\web\node_modules\` 建符号链接，这一步同时撞上两道墙：**(a) 目标路径在工作区之外，被沙箱拒绝写入；(b) 本机未开开发者模式，符号链接本身就需要更高权限。** 我的权限范围在会话开始时就被固定、且本会话禁用了审批提示，无法提权。

---

## 4. `/dsh-po-probe/*` 的真实 HTTP 状态码与响应体

**结果：全部 404，插件未挂载。**

```
GET http://127.0.0.1:3080/dsh-po-probe/status.json
  → HTTP 404  响应体："远程服务器返回错误: (404) 未找到。"（无 body 内容）
GET http://127.0.0.1:3080/dsh-po-probe/selftest.json
  → HTTP 404  同上
```

为了判断「404 到底意味着没挂载还是被信任栅栏挡了」，我加了三组对照（这几组同时也回答了「栅栏会放行/拦截哪些请求」）：

| 请求 | 状态码 | 含义 |
| --- | --- | --- |
| `GET /dsh-whale/widget.js`（已知存在、由已挂载插件注册） | **401** | 路由存在，但栅栏判定未认证 |
| `GET /dsh-definitely-not-here-xyz`（确定不存在） | **404** | 无此路由 |
| `GET /dsh-po-probe/status.json` | **404** | **无此路由 ⇒ 探针未挂载** |
| `GET /dsh-po-probe/status.json`，伪造 `Host: evil.example` | **404** | 无此路由（404 优先于 403） |
| `GET /dsh-whale/widget.js`，伪造 `Host: evil.example` | **403** | 栅栏的 Host/Origin 判定先于认证 |
| `GET /`，伪造 `Host: evil.example` | **401** | index 走的是另一条授权路径（`authorizeIndex`），不是 `requestRejection` |

**这说明什么**：
- 栅栏顺序是 `isTrustedApiRequest`（Host/Origin 伪造就 403）→ `browserAuth.isAuthenticated`（未认证就 401）→ 放行（`...\@deepseek-ai\dsh-client-connection\lib\index.js:553-556`）。
- **未注册的路由无论如何都是 404，所以 404 可以干净地把「没挂载」和「被栅栏拦」区分开** —— 这正是我确认插件未加载的依据。
- 也从反面说明：任务里担心的「裸 curl 得到 401/403 而不是 200」确实会发生；但**在本机，裸 curl 到已注册路由拿到的是 401**，不带任何凭据时根本到不了 handler。（`GET /` 拿 401 而不是 403，是因为它走 index 的专用授权路径。）

我没有尝试用 `ctx.webServer.tapIndex` 注入前端页面去绕过栅栏 —— 那个页面本身也得先过 index 授权，而且插件压根没加载，所以这条备选路径不可用。

---

## 5. 「是否需要重启 `dsh web`」的结论

**结论：需要重启，而且本次连「装了但没生效」这个阶段都没到 —— 根本原因是没有安装成功。**

依据分两层：

1. **安装就失败了**（§3）。当前进程里的 profile 依然是旧的，插件包从未进入 `node_modules`，也从未进入 `dsh.profile.bundles`。
2. **即便安装成功，也必然需要重启**。探针路由的 404 与「确定不存在的路由」的 404 完全一致，说明运行中的 `dsh web` 进程完全没有加载 `dsh-po-probe`。新增 bundle 属于进程启动期装配的层栈，运行期不会热加载。

**我没有重启 `dsh web`**（按指令保留当前会话）。如果确实要走到「插件生效」这一步，请由你决定何时重启。

---

## 6. 探针留下的痕迹清单与彻底清理方法

### 6.1 profile 侧：**零残留**（已验证）

```
Select-String -Path profile\package.json, profile\pnpm-lock.yaml, profile\cordis.yml, profile\cordis.patch.yml -Pattern 'po-probe|dsh-po'
→ 无任何匹配
```
`node_modules` 里也没有 `dsh-po-probe`。

`remove` 指令我照做过，输出证明本来就没装：
```
dsh.cmd plugin --profile web remove dsh-po-probe
  × removing a package
  ╰─▶ Cannot remove 'dsh-po-probe': no such dependency found
  help: Available dependencies: dsh-whale-widget
[exit=1]
```
→ **profile `package.json` 无残留，不需要手工修改。**（`cordis.yml` 也未被改动 —— 我全程没有执行 `dsh --dump-config`。）

### 6.2 我写入的文件（全部在允许范围内，均为交付证据，**默认保留**）

| 路径 | 说明 |
| --- | --- |
| `...\plugindev\prompt-optimizer\probe\dsh-po-probe\package.json` | 探针包声明（`dsh.bundle.patch`） |
| `...\probe\dsh-po-probe\cordis.patch.yml` | 挂载声明 |
| `...\probe\dsh-po-probe\lib\index.js` | 探针实现（33.7 KB） |
| `...\probe\dsh-po-probe\README.md` | 安装/启用/停用/卸载说明 |
| `...\probe\offline-check.mjs` | 离线自检脚本（可重跑，已验证通过） |
| `...\probe\profile-package.before.json` | 安装前 profile `package.json` 快照（证明零改动） |

**未生成**：`probe\probe-log.jsonl`（因为插件一次都没运行过）、`probe\ENABLE`、`probe\DISABLE`、`probe\probe-config.json`。

### 6.3 临时会话：**没有创建**

`/dsh-po-probe/selftest.json` 从未执行，所以**没有任何临时会话被创建，`C:\Users\18136\.dsh\sessions\` 下没有任何 `session-po-selftest-*` 目录**。当前会话 `session-7a49f5b1-29f1-4fb1-8a06-12a14f5f1ad8` 全程未被触碰。

### 6.4 彻底清理（如果你想回到 100% 原状）

```powershell
# 1) 删掉整个探针目录（含全部证据）
Remove-Item -Recurse -Force 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\probe'
# 2) profile 已经干净，无需任何操作；如不放心可核对 package.json 里只有 dsh-whale-widget
```

无需重启、无需回滚配置、无需动 `cordis.yml`。

---

## 7. 「未知 / 未确认」清单

| 项 | 状态 | 最接近的替代方案 |
| --- | --- | --- |
| Q1 在真实会话中拿到真人文本并改写 | **未实测** | 源码确证（`agent-loop\lib\index.js:894-901` + `:1028`）。挂上插件后从 GUI 发一句话，`GET /dsh-po-probe/status.json` 即可看到 `lastPreStep.messages[].isHuman` 与 `rewrite` 记录 |
| Q1 改写后浏览器乐观回显是否如期退休 | **未实测** | 需 GUI 观察。设计上 `source.rpcId` 原样保留是必要条件（探针里 `rpcIdPreserved` 字段专门记录该断言） |
| Q2 自定义 `source` 字段经 DSH `append` + `readSession` 往返 | **未实测**（只做了 JSON 往返） | `/dsh-po-probe/selftest.json` 已写好，逻辑与注释齐全，装上后一次 GET 即可拿到「写入时 source」与「读回后 source」并排 JSON |
| Q3 旁路 LLM 调用可行性与主会话隔离 | **未验证** | `/dsh-po-probe/llmcheck.json` 已写好。凭据/配置解析已离线验证通过 |
| `dsh plugin add` 自动追加 `dsh.profile.bundles` | **未证实/未证伪** | 需在能写 profile 目录的权限下重跑 `add`；或手工建 Junction + 手改 `package.json` 后对比 |
| `dsh plugin add link:<含空格路径>` 在本机可用性 | **已确认不可用**（参数被切分） | 把探针目录放到**无空格**路径再做 `link:` 安装；或用 `%20`（本次未走通，且符号链接关仍会挡） |
| 是否有删除已创建临时会话的 API | **未查证** | `Session` 类只有 `id/header/snapshotEvents/append/...`，**没有** `dispose()`（`dsh-session\lib\types\index.d.ts:103-304`）。唯一的移除途径是 `SessionStore.create()` 内部注册的 fiber effect 被释放（`dsh-session\lib\index.js:1347-1353`）。探针据此改用「抓 `ctx.effect` 的 disposer → 末尾调用」来做确定性清理 |
| `ctx.webServer.tapIndex` 前端绕栅栏验证 | **未尝试** | 插件未加载，该路径无意义 |

---

## 8. 关键 API 签名（从 `.d.ts` 引用，含文件:行号）

全部位于 `C:\Users\18136\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`：

**1) `createUserMessage`** — `dsh-llm\lib\types\message.d.ts:175-183`
```ts
/**
 * Create one identified user-role message and freeze it before publication.
 * @param input - complete content and source for a new user message.
 * @returns an immutable user message with a fresh stable identity.
 */
export declare function createUserMessage<T extends NewUserMessage>(input: T & {
    readonly id?: never;
    readonly role?: never;
}): T & Pick<UserMessage, 'id' | 'role'>;
```
其中（同文件 `:154-155`）：
```ts
type NewMessage = Omit<Message, 'id'>;
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>;
```
运行时实现在 `dsh-llm\lib\types\message.js:45-50`（`createMessage({...input, role:'user'})`），`createMessage` 在 `:34-39`，`freezeMessage` 在 `:26-28`（`deepFreeze(structuredClone(message))`，id 由 `randomUUID()` 生成，见 `:37`）。

> ⚠️ **对任务描述的一处修正**：`@deepseek-ai/dsh-llm` **不是纯类型包**。`dsh-llm\lib\types\message.js` 是可用的运行时模块，`package.json` 的 `exports` 里 `./message` 同时给了 `types` 与 `default`（`dsh-llm\package.json:33-36`），且 `createUserMessage` 是真函数。我实测过：
> ```
> ABSPATH_IMPORT_OK function
> MSG {"content":[{"type":"text","text":"hi"}],"source":{"kind":"user","rpcId":"r1","originalText":"o","optimizedBy":"a/b"},"role":"user","id":"c08ed338-..."}
> ```
> 但**裸导入会失败**（因为 `link:` 安装的插件实体在 profile 之外，Node 按实路径解析）：
> ```
> BARE_IMPORT_FAIL ERR_MODULE_NOT_FOUND Cannot find package '@deepseek-ai/dsh-llm' imported from A:\...\probe\restest.mjs
> ```
> 探针据此写成「先裸导入 → 再按绝对路径动态 `import(pathToFileURL(...))` → 都失败才用本地等价实现（spread + structuredClone + deepFreeze + randomUUID）」，当前走哪条记录在 `status.json.rewriter`。

**2) `Session.append`** — `dsh-session\lib\types\index.d.ts:201-238`（签名在 `:238`）
```ts
/**
 * Append one typed event to the log and synchronously notify observers ...
 * @param type - The event type (key of {@link SessionEventMap}).
 * @param data - The event payload; must be JSON-serializable.
 * @param opts - Surface metadata: `surfaceOp` controls how the event enters the ordered surface;
 *   `sourceEventSeqs` lists the seq numbers of earlier events this one derives from. REQUIRED for
 *   {@link SurfaceEventType} events ...
 * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of `data` that entered the log ...
 * @throws if `data` or surface metadata is not losslessly JSON-serializable ...
 */
append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>;
```
配套（同一 `.d.ts` / `types.d.ts`）：
- `SurfaceEventType = 'system/message' | 'user/message' | 'assistant/message' | 'tool/result'` —— `dsh-session\lib\types\types.d.ts:413`
- `SurfaceOp = 'append' | { op:'replace'; startSeq: SessionSeq; endSeq: SessionSeq }` —— `types.d.ts:429-433`
- `SurfaceIntent<T> = { surfaceOp: SurfaceOp } & (T extends 'assistant/message' ? { sourceEventSeqs?: never } : { sourceEventSeqs?: SessionSeq[] })` —— `types.d.ts:438-446`

→ **确切的调用形式就是**：
```js
session.append('user/message', createUserMessage({content, source}), { surfaceOp: 'append' })
```
不需要猜。宿主自己也是这么调的（`dsh-agent-loop\lib\index.js:1028`）。

**3) `sessionQuery.readSession` / `readSurface`** — `dsh-session-query\lib\types\index.d.ts:68-74` 与 `:121-127`
```ts
/**
 * Read and replay-validate one complete logical session log without making it live.
 * @param sessionId - live or persisted session id to read.
 * @returns cloned header and complete raw event log from one observation.
 * @throws when persistence, header compatibility, or replay validation fails.
 */
readSession(sessionId: SessionId): Promise<SessionLogSnapshot>;

/**
 * Read one session's complete current model surface from one corpus observation.
 * @param sessionId - live-preferred session id to read.
 * @returns cloned header, current surface, and the last sequence number included in the raw-log capture.
 * @throws when source resolution fails or the session surface is invalid.
 */
readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot>;
```
返回类型（`dsh-session-query\lib\types\types.d.ts:23-41`）：
```ts
export interface SessionSurfaceSnapshot { session: SessionHeader; inheritedEventCount: SessionLogOffset; capturedThroughSeq: OptionalSessionSeq; events: SurfaceEvent[]; }
export interface SessionLogSnapshot { session: SessionHeader; inheritedEventCount: SessionLogOffset; events: SessionEvent[]; }
```

**4) 创建临时会话**（self-test 用）— `dsh-session\lib\types\index.d.ts:317-342`
```ts
export declare class SessionStore extends Service {
    create(id?: SessionId, options?: CreateSessionOptions): Session;   // :342
    prepare(id?: SessionId, options?: PrepareSessionOptions): Session; // :362
    enter(session: Session): () => void;                               // :385
    announce(session: Session): void;                                  // :395
    flush(session: Session): Promise<boolean>;                         // :411
    get(id: SessionId): Session | undefined;                           // :419
}
```
运行时（`dsh-session\lib\index.js:1347-1353`）确证 `create()` 会把 `enter` + `announce` 包进 `this.ctx.effect(...)`：
```js
create(id, options) {
    const session = this.prepare(id, options);
    this.ctx.effect(function* () {
        yield this.enter(session);
        this.announce(session);
    }.bind(this), "sessions.create()");
    return session;
}
```
`PrepareSessionOptions` 的 `meta` 允许 `{ cwd?, parentSession?, createdAt?, isSeeded?, origin?, delegationDepth?, agentPreset? }`（`dsh-session\lib\types\types.d.ts:101-123`），因此 self-test 用 `sessions.create('session-po-selftest-<uuid>', { meta: { cwd: process.cwd() } })` 得到一个 `cwd` 可控的临时会话。

**5) `SessionStore` 没有 `delete`/`remove` 公有方法**，`Session` 类**没有 `dispose()`**（`dsh-session\lib\types\index.d.ts:103-304` 全量方法里只有 `append`/`snapshotEvents`/`ownEvents`/`isOwnSeq`/`seq`/`requestHeader`/`requestContext`/`deriveMessages`/`surface`/`header`/`id` 等）。唯一的移除途径是释放 `create()` 注册的那个 fiber effect。

**6) `ctx.effect` 签名**（用于清理路由与临时会话）— `@deepseek-ai\cordis\lib\types\fiber.d.ts:157-159`
```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
effect(execute: () => Effect, label?: string): Disposable<Promise<void>>;
```

**7) 信任栅栏** — `@deepseek-ai\dsh-client-connection\lib\index.js:552-556`
```js
/** Apply the configured Host/Origin fence, then browser authentication. */
requestRejection(request) {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
    return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
}
```

---

## 9. 如果要把这件事做完：最短路径

**根因**：写权限 + 符号链接权限，两样都缺，且本会话禁用审批提示、无法提权。

**路径 A（推荐给用户手动执行，约 3 条命令，不需要开发者模式）**：模仿 `dsh-whale-widget` 的既有形态 —— 它用的就是 **NTFS Junction**，而 Junction 不需要开发者模式。

```powershell
# 1) 在 profile 的 node_modules 下建 Junction
New-Item -ItemType Junction `
  -Path 'C:\Users\18136\.dsh\profiles\web\node_modules\dsh-po-probe' `
  -Target 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\probe\dsh-po-probe'

# 2) 在 C:\Users\18136\.dsh\profiles\web\package.json 里加两项：
#    dependencies:  "dsh-po-probe": "link:A:/document/studio/agent/deepseek harness/plugindev/prompt-optimizer/probe/dsh-po-probe"
#    dsh.profile.bundles: 追加上 "dsh-po-probe"

# 3) 重启 dsh web（会打断当前会话），然后：
curl.exe -i http://127.0.0.1:3080/dsh-po-probe/status.json
```

**路径 B（给父代理/更宽权限的会话）**：用可写 profile 目录的权限重跑
```
dsh.cmd plugin --profile web add "link:<无空格的探针路径>"
```
→ 这样既能完成安装，也能**顺带证实/证伪**「`dsh plugin add` 自动追加 `dsh.profile.bundles`」这个假设。注意必须先把探针目录挪到**无空格**路径（本机 `A:\document\studio\agent\deepseek harness\` 这个空格会把参数切断，已实测）。

**路径 C（不想动 profile 的最轻做法）**：把探针当作「离线源码证据 + 计划中的自检端点」交付 —— 也就是本文档现在的状态。三个问题的机制层面结论已经由源码确证到行号级别，缺的只是运行时的那一次观测。
