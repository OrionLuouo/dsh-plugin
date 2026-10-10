# dsh-po-probe —— DSH 真人提示词优化器「技术探针」

> ⚠️ 一次性技术探针，用于回答三个问题（见下）。**默认关闭**：只有 `..\ENABLE` 文件存在时才会真正改写进入 step 的消息；否则只记录、原样放行。验证完请按文末「完全卸载」清理。
>
> 📌 **本次执行状态：探针源码已就绪，但安装被权限挡住、从未挂载运行。** 完整报告（含真实报错、诊断、证据链、未验证清单）见 `..\REPORT.md`。
> 一句话原因：`dsh plugin` 是 pnpm 透传，`add` 需要在 `C:\Users\18136\.dsh\profiles\web\node_modules\` 建**符号链接**；该路径在工作区之外被沙箱拒绝写入，且本机未开启开发者模式（`AppModelUnlock` 注册表键不存在），符号链接本身也返回 `EPERM`。

- 包名：`dsh-po-probe`
- 目录：`A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\probe\dsh-po-probe`
- 形态：纯 JS ESM，**零 npm 依赖**，`package.json` 用 `dsh.bundle.patch` 声明挂载到 Web profile。

---

## 1. 它装了什么

| 项 | 内容 |
| --- | --- |
| 挂载方式 | `dsh.cmd plugin --profile web add "link:<本目录>"` → profile `package.json` 的 `dsh.profile.bundles` 自动追加 `dsh-po-probe`（无需手写 profile 配置） |
| bundle patch | `cordis.patch.yml`：`- insert: [{ id: dsh-po-probe, name: dsh-po-probe }]`（照抄 `dsh-whale-widget` 格式） |
| 导出 | `export const name = 'dsh-po-probe'`、`export const inject = ['webServer']`、`export async function apply(ctx)`。**没有 `export default`**（避免丢失 `inject`） |
| 事件 | `ctx.on('agent/pre-step', ...)` —— 根 ctx 上监听，接收所有 agent 的 pre-step waterfall |
| 路由 | `GET /dsh-po-probe/status.json`、`GET /dsh-po-probe/selftest.json`、`GET /dsh-po-probe/llmcheck.json`（全部先过 `connection.requestRejection` 信任栅栏） |
| 清理 | `ctx.effect(() => () => { ... })` 释放全部路由 |

### 开关

| 文件 | 作用 |
| --- | --- |
| `..\ENABLE`（即 `probe\ENABLE`） | **存在 = 真正改写**进入 step 的真人消息 |
| `..\DISABLE` | 存在 = 强制关闭（优先级高于 ENABLE），用于快速止血 |
| `..\probe-config.json`（可选） | 覆盖旁路优化模型，见下 |

开关状态每次 pre-step 都重新读盘，改文件不需要重启。

### 旁路优化调用

用 Node `fetch` 直接调 OpenAI 兼容接口 `POST {baseURL}/chat/completions`（**不依赖 `ctx.llm`**）。
默认目标：`deepseek-official` / `deepseek-flash` / `https://api.deepseek.com` / `DEEPSEEK_API_KEY`（读自 `%DSH_HOME%\.credentials.yaml` 的 `refs:`）。

可选覆盖（`probe\probe-config.json`）：

```json
{
  "provider": "volcengine-coding-plan",
  "model": "doubao-seed-2.1-pro",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
  "apiKeyEnv": "VOLCENGINE_CODING_PLAN_API_KEY",
  "timeoutMs": 12000,
  "systemPrompt": "把用户输入改写得更清晰具体，只输出改写结果。"
}
```

`baseUrl` / `apiKeyEnv` 留空时会从 `%DSH_HOME%\settings.yaml` 的 `llm-pi-ai.providers` 里按 `provider` 名解析。

---

## 2. 启用 / 停用

```powershell
# 启用改写
New-Item -ItemType File -Path 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\probe\ENABLE' -Force

# 停用（只记录不改写）
Remove-Item 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\probe\ENABLE' -Force

# 强制止血（优先级最高）
New-Item -ItemType File -Path 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\probe\DISABLE' -Force
```

查看状态（DSH 有浏览器信任栅栏，裸 curl 可能被 401/403 拦下，这是预期）：

```powershell
curl.exe -i http://127.0.0.1:3080/dsh-po-probe/status.json
curl.exe -i http://127.0.0.1:3080/dsh-po-probe/selftest.json
curl.exe -i http://127.0.0.1:3080/dsh-po-probe/llmcheck.json
```

---

## 3. 完全卸载

```powershell
& 'C:\Users\18136\AppData\Roaming\npm\dsh.cmd' plugin --profile web remove dsh-po-probe
```

然后核对 `C:\Users\18136\.dsh\profiles\web\package.json`：

- `dependencies` 里不应再有 `dsh-po-probe`
- `dsh.profile.bundles` 里不应再有 `dsh-po-probe`
- `C:\Users\18136\.dsh\profiles\web\node_modules\dsh-po-probe` 应消失

可能残留（按需手工处理，需要重启 `dsh web` 才会真正从运行中的进程里消失）：

1. 运行中的 `dsh web` 进程仍持有已加载的插件，直到重启。
2. `C:\Users\18136\.dsh\profiles\web\cordis.yml` 若曾被 `--dump-config` 之类重写，可能残留 insert 项。
3. 本探针的副产品文件（**属于交付证据，默认保留**）：
   - `probe\probe-log.jsonl`
   - `probe\ENABLE` / `probe\DISABLE` / `probe\probe-config.json`
   - `probe\offline-check.mjs`（离线自检脚本）
   - `C:\Users\18136\.dsh\sessions\<workspace-key>\session-po-selftest-*\`（若 self-test 落盘了临时会话）

---

## 4. 三个问题与探针的对应关系

| 问题 | 探针如何回答 |
| --- | --- |
| Q1 `agent/pre-step` 能否拿到真人输入并改写？ | `agent/pre-step` 监听器记录 payload/decision 摘要（`status.json.recentInMemory` 的 `pre-step` 条目 + `lastPreStep`）；`ENABLE` 存在时实际改写并记录 `rewrite` 条目（含 `rpcIdPreserved`） |
| Q2 自定义 `source` 字段能否落盘后读回？ | `GET /dsh-po-probe/selftest.json`：新建**临时会话** → `session.append('user/message', createUserMessage({... source:{kind:'user',rpcId,originalText,optimizedBy}}), { surfaceOp:'append' })` → `ctx.sessionQuery.readSession()` 读回 → 并排给出写入/读回的 source 原始 JSON |
| Q3 旁路 LLM 调用是否可行且不污染主会话？ | `GET /dsh-po-probe/llmcheck.json` 独立验证 fetch 链路；`pre-step` 改写路径下 `rewrite` 记录会带上实际调用耗时/状态码。旁路调用只写探针自己的 jsonl，不 append 任何 session 事件 |

self-test **绝不触碰** `session-7a49f5b1-29f1-4fb1-8a06-12a14f5f1ad8`（当前会话），它只操作自己新建的临时会话，并在 handler 末尾通过 `ctx.effect` 的 disposer 释放。

> 补充（源码确证）：`SessionStore` 没有 `delete`/`remove` 公有方法，`Session` 类也没有 `dispose()`。临时会话唯一的释放途径就是释放 `ctx.sessions.create()` 自己注册的那个 fiber effect（`dsh-session\lib\index.js:1347-1353`），本探针就是抓取外层 `ctx.effect` 的 disposer 来做到这一点。
> 另外 `SessionStore` 的文档明确写着「a session published outside that lifecycle persists nothing」（`dsh-session\lib\types\index.d.ts:310-316`）—— 即没有 agent loop 接管的临时会话**本来就不落盘**，所以 self-test 理论上不会在 `%DSH_HOME%\sessions\` 留下任何文件。

---

## 5. 实现细节备忘

- `createUserMessage` 优先用宿主**真实现**（先试裸导入 `@deepseek-ai/dsh-llm/message`，失败则用绝对路径 `...\dsh\node_modules\@deepseek-ai\dsh-llm\lib\types\message.js` 动态导入）；两者都失败才用本地等价实现（`spread + structuredClone + deepFreeze + randomUUID`）。当前用的是哪一条记录在 `status.json.rewriter`。
  - 原因：DSH 从 profile 的 `node_modules` 加载插件，而 `link:` 安装的插件实体在 profile 之外，Node 默认按实路径解析，裸导入 `@deepseek-ai/*` 会 `ERR_MODULE_NOT_FOUND`。
- 消息是 deep-frozen 的，因此改写必须用 `createUserMessage({ content, source })` 造新对象；`source` 直接展开原 source 再追加字段，`rpcId` 原样保留。
- `Session.append` 对消息事件必须传第三个参数 `{ surfaceOp: 'append' }`（`SurfaceEventType` 的必填 surface 元数据）。
- 所有自有路由都先过 `ctx.get('connection').requestRejection(req)`；缺失该服务时 fail-open 并打 warn（照抄 whale-widget）。
