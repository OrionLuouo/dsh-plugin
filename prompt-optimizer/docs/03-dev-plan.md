# 03 — 阶段三（代码编写）实施计划

> 阶段二已交付：`docs/02-architecture.md`（修订版架构）、`docs/02-api.md`（接口冻结）、
> `docs/03-probe-report.md`（探针结论与权限阻塞）。
>
> 本阶段：按已冻结的接口把插件写完，并配套**离线自检**，让你只需授权一次即可完成实机验收。

## 0. 执行纪律（本次明确）

- **不再调用任何 subagent。** 全部代码由我自己读写，避免额外计费。
- 所有写入限制在 `prompt-optimizer/` 子目录内。
- 不触碰 `~/.dsh/profiles/web/`，不重启 `dsh web`（需你授权时才做）。
- 遇到网络/权限问题最多自行尝试 1~2 轮，仍不通即汇报等待指示。

## 1. 前置决策（已由你确认）

| 决策 | 结论 |
|---|---|
| 插件安装方式 | 路径 C：代码全部写完 → 你一次性授权 → 安装/实测/验收一次到位 |
| 发送交互 | 默认**静默直发**（`sendStrategy: "auto"`），设置页可切**预览确认**（`"preview"`） |
| 视觉副作用 | **接受现状**，UI 明示「优化中」状态 |
| 配置存储 | `DSH_HOME/prompt-optimizer.json` |
| 阶段确认节奏 | 每阶段「计划→确认」「成果→确认」各一次 |

## 2. 实施顺序（先纯函数、后可挂载部分）

这样安排的原因：纯函数部分能靠离线自检验证，把「必须挂载才能验证」的范围压到最小 ——
也就是把需要你授权的窗口压到最小。

### 第 1 步：配置与预设（离线可验）

- `lib/presets.js` —— 5 个内置预设及其工作说明文本（内容已在 `02-api.md` §3 冻结）
- `lib/config.js` —— 读/写 `prompt-optimizer.json`；默认值生成；深合并局部更新；**原子写**（临时文件 + rename）
- `lib/state.js` —— `prompt-optimizer.state.json`：票据表（TTL 5 分钟）＋ 最近 50 条记录（**只记长度，不记正文**）

### 第 2 步：模型目录与凭据（离线可验）

- `lib/catalog.js` —— 解析 `DSH_HOME/settings.yaml` 的 `llm-*.providers`（`baseURL`/`api`/`apiKeyEnv`/`models`）
  与 `agent-default-model`，产出分组模型清单；非 `openai-completions` 的 provider 标 `supported:false`
- `lib/credentials.js` —— 解析 `.credentials.yaml` 的 `refs`，按 `apiKeyEnv` 取密钥；环境变量兜底；
  **密钥不外泄、不写日志、不回传前端**

### 第 3 步：上下文与优化调用（离线可验，可打桩）

- `lib/context.js` —— 从消息数组拼优化上下文；只取真人输入（`source.kind==='user' && 'rpcId' in source`）；
  已优化轮次用**优化后**文本；按 `maxTurns`/`maxChars` 从最旧截断
- `lib/optimize.js` —— OpenAI 兼容 `POST {baseURL}/chat/completions`；超时；围栏清洗；
  `changed` 判定（与原文完全相同视为未优化）；错误码归一到 `TIMEOUT|NO_KEY|HTTP_4XX|HTTP_5XX|BAD_RESPONSE|DISABLED`

### 第 4 步：改写器（需挂载才能实测）

- `lib/rewriter.js` —— `ctx.on('agent/pre-step', …)`：
  - **只处理 `step === 1`**
  - **只替换真人消息**，`decision.messages` 其余条目原样保留（末尾有 context 消息，不能整体替换）
  - **必须原样保留 `source.rpcId` 与 `clientTimeZone`**（硬约束，写进注释）
  - 追加 `poOptimized` / `poOriginalText` / `poOptimizedBy` / `poPresetId`
  - `createUserMessage` **三级回退**：裸导入 → 绝对路径 `import()` → 本地等价实现
    （探针已证实裸导入会 `ERR_MODULE_NOT_FOUND`）
  - 并发保护：同一 `turn+step` 只处理一次；`signal.aborted` 检查
  - 失败降级：按 `onFailure` 决定「发原文 / 取消 / 提示后发原文」
  - 票据命中检查（预览确认路径不重复优化）

### 第 5 步：路由与组装（需挂载才能实测）

- `lib/routes.js` —— `02-api.md` §5 的 6 条路由，全部先过 `connection.requestRejection` 信任栅栏
- `lib/index.js` —— `export const name` / `export const inject = ['webServer']` / `export function apply`；
  **不使用 `export default`**（会丢失 inject）；`tapIndex` 注入 `ui.js`；`ctx.effect` 统一清理

### 第 6 步：浏览器侧（需挂载才能目视验证）

- `assets/ui.js` —— 自包含单文件，按 `02-api.md` §7：
  composer 挂载探测 → 主按钮 + 上拉菜单 → 「优化中」指示 → 失败提示 →
  轮次标记与「原文/优化文」切换 → Settings 视图注入设置区

### 第 7 步：离线自检与打包

- `tools/selfcheck.mjs` —— 覆盖第 1~3 步全部模块（这些不需要挂载）
- `package.json` / `cordis.patch.yml` / `LICENSE` / `README.md`
- **不执行安装**，等你授权

## 3. 阶段三验收标准（第二次验收）

- [ ] `tools/selfcheck.mjs` 全绿：配置读写往返、预设默认值、模型目录解析（能读出本机 3 个 provider）、
      凭据解析（不外泄）、上下文拼接与截断、优化调用（真实打一次桩/真调）、清洗与 `changed` 判定
- [ ] 全部模块语法检查通过（`node --check`）
- [ ] 代码中无 `export default`；`rpcId` 保留约束有显式注释
- [ ] 插件包结构完整、零 npm 依赖
- [ ] 交付一份**给用户的安装/验收脚本**（含重启 `dsh web` 的时机说明），待你授权后执行

## 4. 阶段四（实机测试）预告

授权后一次性完成：安装 → 重启 → 四场景端到端验收（直接模式零副作用 / 优化模式生效 /
标记切换 / 设置页预设编辑 / 失败降级）→ 记录证据 → 彻底卸载验证。
