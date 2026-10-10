# dsh-prompt-optimizer —— DSH 提示词优化插件

在 DeepSeek Harness 的输入框旁加一个「提示词优化」开关：让你输入的一句话先经过**优化模型**
改写得更清晰具体，再交给当前会话模型。支持多套预设（模型 + 工作说明）、直接/优化两种输出模式、
静默直发与预览确认两种发送方式，以及已优化轮次的「原文 / 优化后」切换。

---

## 一、它做什么

- **两种输出模式**
  - *直接输出*：与原版完全一致，插件对会话**零副作用**。
  - *优化输出*：本轮输入先交给优化模型改写，改写结果才进入当前会话。
- **优化模型可选**：从 DSH 已接入的 provider / 模型里挑（自动读取 `settings.yaml`，未配置密钥的会标注）。
- **上下文感知**：把本次会话已发生的「每轮用户输入 + 助手输出」拼成对话记录一并发给优化模型，
  因此优化能理解你在聊什么。已优化过的轮次，上下文里用的是**优化后**的文本。
- **轮次标记**：被优化过的输入会带「已优化」标记，可一键切回原文对照。
- **多套预设**：5 套内置预设（结构化重写 / 精简明确 / 编码任务专用 / 分析研究专用 / 保守润色），
  每套含一个默认模型与一段可编辑的「工作说明」。
- **失败可降级**：优化超时或报错时，可按配置选择「照发原文」或「取消发送」。

## 二、安装

前置条件：`pnpm` 在 PATH 中（`dsh plugin` 是 pnpm 的透传）。

> ## ⚠️ 路径绝对不能含空格
>
> 实测确认：`dsh plugin` 会把 `add` 之后的参数**按空白切分**——
> 路径里的空格会让 pnpm 只拿到后半段（例如 `harness\plugindev\...`）去 npm registry 查，
> 报 `ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST` 404。
> 这不是引号问题（加引号、用数组传参、走 `.cmd`、用 8.3 短名都试过，均无效）。
>
> **解决办法**：用目录联接（Junction）把插件目录映射到一个无空格的路径再安装。
> Junction 不需要管理员权限，也不需要开启开发者模式。

```powershell
# 1) 建一个无空格的工作路径（Junction 指向插件源码，源码留在原地不动）
New-Item -ItemType Junction -Path 'C:\Users\18136\.dsh-po-link' `
  -Target 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer'

# 2) 安装（注意：dsh 必须用 .cmd 调用，本机 PowerShell 禁用 .ps1）
& 'C:\Users\18136\AppData\Roaming\npm\dsh.cmd' plugin --profile web add 'C:\Users\18136\.dsh-po-link'

# 3) 确认自动挂载（无需手工编辑任何 profile 配置）
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" -Raw -Encoding UTF8
```

第 3 步应在 `dsh.profile.bundles` 里看到 `dsh-prompt-optimizer` 已被**自动追加**。

**新增 bundle 需要重启 `dsh web` 才会生效**（配置树只在启动时装配）：

```powershell
# 在运行 dsh web 的终端里 Ctrl+C，然后重新启动
dsh web
```

之后浏览器强制刷新一次页面。

### 一键回退（安装可一步撤销）

安装前已对 profile 做了逐字节备份 + SHA256 清单（`profiles\web\.dsh-po-backup\`）。
任何时候都可以用下面这一条命令完全复原：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\tools\rollback.ps1"
```

它会：删联接（**只删链接、绝不动目标目录**）→ 还原备份文件 → 双保险剔除 bundles 条目 → SHA256 校验。
加 `-DryRun` 可先看它要做什么而不改动任何东西。回退后同样需要重启 `dsh web`。

### 卸载

```powershell
& 'C:\Users\18136\AppData\Roaming\npm\dsh.cmd' plugin --profile web remove dsh-prompt-optimizer
```

随后可用上面的 `rollback.ps1` 还原 profile 配置。

## 三、使用

1. 打开 DSH Web 界面（默认 `http://127.0.0.1:3080`）。
2. 在输入框下方的工具行里、**权限选择器右侧**会出现一个 **「提示词优化」** 胶囊按钮。点击展开上拉菜单。
   该按钮只是工具行里新增的一个 flex 子项，不改动 DSH 的任何既有节点，因此不会影响原有布局。
3. 在菜单里：
   - 切换 **输出模式**（优化输出 / 直接输出）
   - 选择 **优化模型**
   - 选择 **预设**
   - 点 **优化并发送**：立即用当前输入走一次优化并发送（无论当前是哪种模式）
   - 点 **打开设置**：编辑全部配置，并**新增 / 编辑 / 删除预设**
4. 之后正常输入并按 Enter 发送即可：
   - *静默直发* 方式下，插件在后台完成优化，你直接看到模型基于优化后提示词的回答。
   - *预览确认* 方式下，会先弹出优化结果供你修改，确认后才发送。

排障入口（浏览器控制台）：

```js
fetch('/dsh-prompt-optimizer/status.json').then(r => r.json()).then(console.log)
window.__dshPromptOptimizerSettings()   // 直接打开设置面板
window.__dshPromptOptimizerMenu.open()  // 直接展开上拉菜单
```

## 四、配置

配置文件：`C:\Users\18136\.dsh\prompt-optimizer.json`（首次运行自动生成）。

| 字段 | 含义 | 默认 |
|---|---|---|
| `enabled` | 插件总开关 | `true` |
| `mode` | `direct` 直接输出 / `optimize` 优化输出 | `direct` |
| `presetId` | 当前预设 id | `structured` |
| `modelRef` | 覆盖预设自带模型；`null` 表示沿用预设 | `null` |
| `sendStrategy` | `auto` 静默直发 / `preview` 预览确认 | `auto` |
| `context.maxTurns` | 上下文最多回溯轮数 | `10` |
| `context.maxChars` | 上下文总字符上限 | `6000` |
| `context.includeAssistant` | 上下文是否含助手输出 | `true` |
| `timeoutMs` | 优化调用超时 | `90000` |
| `onFailure` | `send-original` 发原文 / `cancel` 取消 | `send-original` |
| `maxOptimizeChars` | 超过此长度的输入不优化 | `8000` |
| `presets` | 预设列表（模型 + 工作说明） | 5 套内置 |

运行时状态单独存放：`C:\Users\18136\.dsh\prompt-optimizer.state.json`
（票据表与最近记录；**只记长度与元数据，不记提示词正文**）。

## 五、内置预设

| id | 名称 | 默认模型 |
|---|---|---|
| `structured` | 结构化重写 | `volcengine-coding-plan/doubao-seed-2.1-pro` |
| `concise` | 精简明确 | `volcengine-agent-plan/glm-5.3` |
| `coding` | 编码任务专用 | `volcengine-coding-plan/doubao-seed-2.1-pro` |
| `analysis` | 分析研究专用 | `volcengine-agent-plan/glm-5.3` |
| `faithful` | 保守润色 | `deepseek-official/deepseek-flash` |

工作说明可在设置面板里逐条编辑，并支持**新增预设**（点「新增预设」后会插入一张新卡片，
填名称、选模型、写工作说明即可）与**删除预设**：

- **自定义预设**可以真正删除。
- **内置预设不可删除**（删除会在同一次保存里被补回），但其**名称、模型、工作说明都可以随意修改**。
  这样设计是为了避免误删导致插件不可用。

## 六、它是怎么实现的（简述）

宿主侧 `lib/index.js` 注册两条东西：

1. **`agent/pre-step` waterfall 监听**：这是 DSH 官方唯一能**改写**即将发给模型的消息的接入点。
   插件在本轮第一个 step 里把真人提示词替换为优化后的版本，并在消息来源上追加 `po*` 标记字段
   （原文、模型、预设），**同时原样保留 `rpcId`** —— 浏览器靠它把本地回显与持久消息对账。
2. **同源 HTTP 接口** + **`tapIndex` 注入前端脚本**：浏览器侧 UI 是一个自包含脚本，
   由宿主路由原样吐出，纯 DOM 挂载，不需要构建链。

设计细节见 `docs/`：

| 文档 | 内容 |
|---|---|
| `docs/00-recon.md` | 环境与插件机制侦察（含实测证据） |
| `docs/01-phase1-and-phase2-plan.md` | 阶段一成果与阶段二计划 |
| `docs/02-architecture.md` | 架构设计与关键取舍 |
| `docs/02-api.md` | **冻结的接口契约**（配置、HTTP、日志标记、UI） |
| `docs/03-probe-report.md` | 探针结论与权限阻塞记录 |
| `docs/03-dev-plan.md` | 阶段三实施计划 |

## 七、开发与自检

```powershell
# 离线自检：覆盖除「挂载/路由/UI」之外的全部逻辑（打桩，不联网）
node tools/selfcheck.mjs

# 加载验证：模拟安装形态导入插件，检查导出形状、路由注册、tapIndex 注入、
# pre-step 挂载与「直接模式零副作用」。不需要重启 dsh web 即可跑。
node tools/loadtest.mjs

# 界面文案编码检查（确保全部为 ASCII 转义，防止乱码）
node tools/check-ui-encoding.mjs

# 额外真调一次优化模型（会消耗额度）
node tools/selfcheck.mjs --live
```

`tools/` 下另有 `diag-live*.mjs` 一次性诊断脚本（用于定位特定环境的延迟问题）
与 `rollback.ps1` 回退脚本。诊断脚本不参与打包，可安全删除。

## 八、已知限制与后续迭代清单

- **关闭优化模型的「思考模式」**：实测 `doubao-seed-2.1-pro` 在思考模式下单次优化可耗时
  60~115 秒（与网络质量强相关），若关闭思考可降到约 2.7 秒
  （`thinking: {type:'disabled'}`；`deepseek-flash` 用 `reasoning_effort:'none'` 约 1.5 秒；
  `glm-5.3` 不支持关闭）。当前**未启用**该优化，按需求留待后续版本决定是否实装。
- **设置页位置**：设置面板目前是插件自持弹窗（从输入框菜单进入），未注入 DSH 设置页。
  要注入需要引入官方客户端插件构建链（tsdown + 自建 externalization），属独立工作量。
- **发送拦截的健壮性**：预览确认方式依赖「找到原生发送按钮」的启发式探测。
  Enter 键路径更可靠；若某个 DSH 版本改动了按钮结构，预览确认可能失效，
  此时仍可用菜单里的「优化并发送」按钮，或在设置里切回静默直发。
- **轮次标记的定位**：轮次标记依赖会话消息节点的 `data-*` 属性探测；若 DSH 改用别的标注方式，
  标记会不显示（但优化功能本身不受影响）。

## 九、许可

MIT。见 `LICENSE`。
