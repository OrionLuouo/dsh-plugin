# 阶段二 · 探针报告（已完成部分 + 权限阻塞）

> 探针目标：验证三处技术不确定性。**代码已全部写好并通过语法检查，但安装阶段被权限墙挡住，
> 因此只有「源码确证」，没有「运行时实测」。** 按纪律未尝试提权/重启/手改 profile。

## 1. 结果速览

| # | 待验证问题 | 状态 |
|---|---|---|
| 1 | `agent/pre-step` 能否拿到真人输入并改写 | **源码确证成立**（`dsh-agent-loop/lib/index.js:1028` 写入的正是 `decision.messages` 而非 `claimed`）；**未实测** |
| 2 | 自定义 `source` 字段落盘后能否原样读回 | **源码确证成立**（`append` 只做"无损 JSON 可序列化"校验，**不是字段白名单**）；离线 JSON 往返实测通过；**未做 DSH 落盘往返实测** |
| 3 | `pre-step` 内旁路 LLM 调用可行性/隔离 | **未验证**（凭据与配置解析已离线实测通过） |
| — | `dsh plugin add` 自动追加 `dsh.profile.bundles` | **未能证实也未能证伪**（add 阶段即失败） |

## 2. 阻塞点（精确定位）

`dsh plugin` 实为 pnpm 透传；`add` 需要在 `C:\Users\18136\.dsh\profiles\web\node_modules\` 建立链接。

```
ERR_PNPM_PACKAGE_MANAGER_SYMLINK_FAILED
Failed to create symlink at "C:\Users\18136\.dsh\profiles\web\node_modules\dsh-po-probe"
→ 拒绝访问 (os error 5)
```

能力矩阵（实测）：

| 操作 | 位置 | 结果 |
|---|---|---|
| 符号链接（目录） | workspace 内 | ❌ EPERM（未开开发者模式，`AppModelUnlock` 不存在） |
| **目录联接（Junction）** | **workspace 内** | ✅ **成功** |
| 目录联接（Junction） | `A:\` 根 / 系统 temp | ❌ Access is denied |
| 任意写操作 | `~/.dsh/profiles/web/` | ❌ Sandbox 拒绝（`file access denied under workspace-write mode`） |

**结论：真正的阻塞是「安装目标 `~/.dsh/profiles/web/` 在 workspace 之外，被 file sandbox 拒绝」。**
这不是脚本写法问题，也不是网络问题，无法在不放宽权限的前提下绕过。

副带发现（与权限无关的独立坑）：**`link:` 规格中的空格无法通过 `dsh.cmd` 的 `.cmd` shim 正确传递**
（参数被切开，pnpm 只拿到 `harness\plugindev\...` 去 registry 查 → 404）。换 `%20` 也走不通。
→ **安装规格必须使用不含空格的路径**；而 workspace 内可以建立 Junction 来得到这样的路径（已验证）。

## 3. 探针验证过的其它事实

- **不能整体替换 `decision.messages`**：默认 `next()` 返回的数组末尾还有一个 context 消息
  （`dsh-agent-loop/lib/index.js:894-901`），所以必须**只替换真人消息、其余原样保留**。
- **`createUserMessage` 会分配新的 message id**（`dsh-llm/lib/types/message.js:34-50`，
  `id: brandString(randomUUID())`）。因此**保留 `source.rpcId` 才是浏览器乐观回显退休的关键**——
  我原设计中的这条判断被证实是对的。
- **`@deepseek-ai/dsh-llm` 不是纯类型包**（修正我先前给探针的一条错误前提）：
  `lib/types/message.js` 是可用运行时模块，`createUserMessage` 是真函数。
  但**裸导入会失败**（`ERR_MODULE_NOT_FOUND`）——因为 `link:` 安装的插件实体位于 profile 之外，
  Node 按真实路径解析。→ 代码里需要**三级回退**：裸导入 → 绝对路径 `import()` → 本地等价实现。
- 确切签名（均已从 `.d.ts` 与宿主源码核实，非猜测）：
  - `session.append('user/message', createUserMessage({content, source}), { surfaceOp: 'append' })`
    （`dsh-session/lib/types/index.d.ts:238`；宿主在 `dsh-agent-loop/lib/index.js:1028` 就是这样调的）
  - `createUserMessage(input)` — `dsh-llm/lib/types/message.d.ts:175-183`
  - `sessionQuery.readSession(id)` / `readSurface(id)` — `dsh-session-query/lib/types/index.d.ts:74 / :127`
  - `ctx.sessions.create(id?, options?)` — `dsh-session/lib/types/index.d.ts:342`
  - **`SessionStore` 没有 delete/remove，`Session` 没有 dispose()**；唯一移除途径是释放
    `create()` 注册的 fiber effect。且 `SessionStore` 文档明说没有 agent loop 接管的会话**本来就不落盘**。
- 信任栅栏的判定顺序（`dsh-client-connection/lib/index.js:553-556`）：
  `isTrustedApiRequest` → 403；`browserAuth.isAuthenticated` → 401；否则放行。
  **未注册的路由一律 404** ⇒ 404 可干净地区分「没挂载」与「被栅栏拦」。
  裸 curl 到已注册路由得到 401 是预期行为。

## 4. 痕迹与清理

**profile 侧零残留**：`add` 失败发生在写 `package.json` 之前；`remove` 回执证明本就没装
（`ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS ... Available dependencies: dsh-whale-widget`）。
`package.json` / `pnpm-lock.yaml` / `cordis.yml` / `cordis.patch.yml` 均无 `dsh-po-probe` 字样。

**未创建任何临时会话**，当前会话 `session-7a49f5b1-...` 全程未被触碰。
未执行 `dsh --dump-config`，未重启 `dsh web`，未手改 profile 配置。

留下的探针文件（保留作为证据）：

| 路径 | 说明 |
|---|---|
| `probe/dsh-po-probe/package.json` | 声明 `dsh.bundle.patch` |
| `probe/dsh-po-probe/cordis.patch.yml` | 挂载声明 |
| `probe/dsh-po-probe/lib/index.js` | 33.7 KB，默认关闭（`ENABLE` 文件开关）+ `DISABLE` 止血 |
| `probe/dsh-po-probe/README.md` | 探针说明 |
| `probe/offline-check.mjs` | 可重跑的离线自检（已验证通过） |
| `probe/profile-package.before.json` | 安装前 profile 快照 |
| `probe/REPORT.md` | 探针原始报告 |

探针特性：三条路由（`status.json` / `selftest.json` / `llmcheck.json`）全部先过
`connection.requestRejection` 信任栅栏；每次 pre-step 重新读盘；内存日志 + `probe-log.jsonl` 落盘；
`ctx.effect` 清理路由。

## 5. 解除阻塞的三条路径

### 路径 A —— 由你手动执行安装（推荐做首次验证）

不需要放宽我的权限，且恰好能**验证「自动追加 bundles」这个假设**。
在 **workspace 内**建无空格联接、再用 `dsh plugin add`：

```powershell
# 1) 在插件目录内建一个无空格的联接（workspace 内，已验证可建）
#    注意：不要在 A:\ 根或 temp 建，会被拒绝
New-Item -ItemType Junction `
  -Path 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\_link' `
  -Target 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\probe\dsh-po-probe'

# 2) 用「项目目录」的方式安装（避免 link: 规格，也就避开了空格传递问题）
cd 'A:\document\studio\agent\deepseek harness\plugindev\prompt-optimizer\_link'
& 'C:\Users\18136\AppData\Roaming\npm\dsh.cmd' plugin --profile web add .

# 3) 检查是否自动追加进 bundles（这一步就是在验证假设）
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" -Raw
```

若第 3 步的 `dsh.profile.bundles` 出现了 `dsh-po-probe` ⇒ **假设成立**，
后续正式安装本插件时我完全不需要碰 profile 配置。

### 路径 B —— 授权我放宽沙箱完成安装与端到端实测

我用一次 `danger-full-access` 重试安装命令，随后立即验证并卸载探针。
**建议合并执行**：等阶段三代码写完，一次性用这条路径完成「安装 → 实测 → 验收 → 卸载探针」，
把需要你介入的次数降到最少。

### 路径 C —— 先写代码，最后统一安装

阶段三先把宿主侧与浏览器侧代码全部写完，配套**离线自检脚本**
（不依赖挂载即可验证：模型目录解析、凭据解析、上下文拼接、优化调用、配置读写）。
需要挂载才能验证的只有「pre-step 改写是否真的生效」「路由是否可达」「前端 UI 是否挂上」三条。
**这是我最推荐的推进方式**：它让你只需授权一次，且授权时产品已经完整，验收一次到位。

## 6. 未验证清单（不推测）

1. 真实会话中 `agent/pre-step` 的观测与改写是否生效
2. 浏览器乐观回显是否靠 `rpcId` 正确退休（未见跳变/重复）
3. DSH 实际的 `append` + `readSession` 落盘往返是否保留自定义 `source` 字段
   （仅做了纯 JSON 往返）
4. `pre-step` 内旁路 LLM 调用的可行性与主会话隔离性
5. `dsh plugin add` 是否自动追加 `dsh.profile.bundles`
6. `link:` 含空格路径 —— **已确认不可用**
7. 删除临时会话的 API —— **已确认不存在**
8. `tapIndex` 前端能否绕开栅栏访问自有路由（探针未加载，无意义）
