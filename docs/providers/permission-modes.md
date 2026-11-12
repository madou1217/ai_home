# Provider 权限模式基线（aih 托管）

> 事实来源：`lib/providers/permission-flag-catalog.js`（取值枚举 / 互斥 / 文案）+
> `contracts/providers/manifest.json` 的 `nativeBoundary.permissions`（有哪些旗标）。
> 本机实测版本见每节标题；升级 CLI 后按 `agent-cli-usage.md` 的流程重采，再回来核对。
>
> 本文回答的是「**全放开档**叫什么、写在哪、TUI 里怎么切、桌面端在哪设」。
> 参数落点与互斥拦截的实现见 `cli-version-restrictions.md`。

## 名词澄清

各家对「不再询问」的称呼完全不同，混用会直接选错档：

| 俗称 | 真实含义 | 谁是最高档 |
| --- | --- | --- |
| YOLO | 源自 "You Only Live Once"，指「全都直接执行」 | 视 provider 而定，**不是通用最高档** |
| bypassPermissions | Claude 系（claude / codebuddy / workbuddy / grok）的模式名 | claude/codebuddy 是；**kimi 不是** |
| danger-full-access | codex 的**沙箱**档位（与审批是独立维度） | 是，但要配 `-a never` 才是全放开 |
| always-approve | grok 的产品名，等价 `bypassPermissions` | 是 |
| always-proceed | agy 配置项 `toolPermission` 的最高取值 | 是 |

**两个高频陷阱**：
1. **kimi 的 `--yolo` 不是最高档**。它只是「需要时再问」（高风险仍会问）；最高档是 `--auto`。
2. **codex 的沙箱和审批是两个独立维度**。只给 `-s danger-full-access` 不给 `-a never`，仍会在联网等场景停下等确认。

## 全放开档速查

| provider | CLI 全放开 | 配置文件全放开 |
| --- | --- | --- |
| codex 0.163.0 | `--dangerously-bypass-approvals-and-sandbox`<br>或 `-s danger-full-access -a never` | `sandbox_mode = "danger-full-access"`<br>`approval_policy = "never"` |
| claude 2.1.306 | `--permission-mode bypassPermissions`<br>或 `--dangerously-skip-permissions` | `permissions.defaultMode = "bypassPermissions"` |
| gemini 0.65.0 | `--approval-mode yolo` 或 `-y` | `general.defaultApprovalMode = "yolo"` |
| agy 1.4.5 | `--dangerously-skip-permissions` | `toolPermission = "always-proceed"` |
| opencode 2.1.1 | `--auto`（别名 `--yolo`、`--dangerously-skip-permissions`） | `permission = "allow"` |
| grok 1.0.46 | `--always-approve` 或 `--permission-mode bypassPermissions` | `[ui] permission_mode = "always-approve"` |
| kimi 2.3.0 | `--auto`（**不是 `--yolo`**） | `default_permission_mode = "auto"` |
| qoder 1.1.74 | `--permission-mode bypass_permissions`<br>或 `--dangerously-skip-permissions` | `general.defaultPermissionMode = "bypass_permissions"` |
| codebuddy 2.161.4 | `--permission-mode bypassPermissions` | `permissions.defaultMode = "bypassPermissions"` |
| kiro 2.32.0 | `kiro-cli chat --trust-all-tools`（`-a`） | agent 配置的工具信任（无全局开关） |
| cline 3.0.73 | `--auto-approve true`（默认即 true）<br>`-y` 只放开**受限**工具集 | `autoApprovalSettings`（逐项，无单一开关） |

## 各 provider 明细

### codex（codex-cli 0.163.0）

**命令行**
- `-s, --sandbox` → `read-only` / `workspace-write` / `danger-full-access`
- `-a, --ask-for-approval` → `on-request` / `never`
- `--approve-for-me`：审批交给自动复核，自动用 workspace-write 沙箱
- `--dangerously-bypass-approvals-and-sandbox`：同时跳过确认与沙箱
- `--dangerously-bypass-hook-trust`：只放开 hook 来源信任，**不算权限选择**

**TUI**：`Shift+Tab` 循环，状态栏显示 → `Read Only` → `Workspace` → `(network access enabled)`
→ `Custom permissions` → `Full Access` → `Approve for me`。
其中 `Full Access` 对应 `danger-full-access`/`full-access`，文案为「可编辑工作区外的文件并联网，不再请求批准」。

**配置文件** `~/.codex/config.toml`：`sandbox_mode`、`approval_policy`、`approvals_reviewer`、`[profiles.*]` 可按 profile 覆盖。

**互斥**（上游直接报错）
- `--approve-for-me` × `-a/--ask-for-approval`
- `--approve-for-me` × `-s/--sandbox`
- `--dangerously-bypass-approvals-and-sandbox` × `-a/--ask-for-approval`
- 全放行与 `-s` 并存时**覆盖** `-s`（不报错，但要在 UI 说明）

**位置约束**：`-a` 在 `exec` 子命令下不接受；`resume`/`fork` 一旦走远程 app-server，任何权限覆盖都被上游拒绝
（`Permission overrides are not supported when resuming a remote task.`）。

### claude（2.1.306）

**命令行**
- `--permission-mode` → `default` / `acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan`
- `--dangerously-skip-permissions`：跳过全部检查
- `--allow-dangerously-skip-permissions`：只是把「跳过权限检查」变成可选，默认不启用
- `--allowedTools` / `--disallowedTools`：工具白/黑名单

**TUI**：`Shift+Tab` 切换模式；`/permissions` 管理 allow / deny / ask 规则。

**配置文件** `~/.claude/settings.json`
- `permissions.defaultMode`（全放开 = `bypassPermissions`）
- `permissions.allow` / `deny` / `ask`
- `skipDangerousModePermissionPrompt`：只跳过「确认进入危险模式」那一次提示
- `permissions.disableBypassPermissionsMode`：企业策略，设 true 后请求 bypassPermissions 会被降级

### gemini（0.65.0）

**命令行**
- `--approval-mode` → `default` / `auto_edit` / `yolo` / `plan`
- `-y, --yolo`：等价于 `--approval-mode yolo`
- `-s, --sandbox`：与权限模式**相互独立**的维度
- `--allowed-tools`（官方已弃用，改用策略引擎）、`--policy`、`--admin-policy`

**配置文件** `~/.gemini/settings.json`：`general.defaultApprovalMode`（旧键 `tools.approvalMode` 自动迁移）、
`security.disableYoloMode`（设为 true 时 yolo 不可用）。

**互斥**：`-y/--yolo` × `--approval-mode` 上游报错，要求改写成 `--approval-mode yolo`。

### agy（1.4.5）

**命令行**
- `--dangerously-skip-permissions`：自动批准全部工具权限请求
- `--mode` → `accept-edits` / `auto` / `plan`
- `--sandbox`：带终端限制的沙箱

**配置文件** `~/.gemini/antigravity-cli/settings.json`
- `toolPermission` → `always-proceed`（自动批准）/ `request-review`（文件编辑先展示再应用）/ `strict` / `proceed-in-sandbox`
- 相关：`enableTerminalSandbox`、`allowNonWorkspaceAccess`

### opencode（2.1.1）

**命令行**：`--auto`（自动批准未被显式拒绝的权限）。
别名 `--yolo`、`--dangerously-skip-permissions` 在源码里是**同一组参数**（三者完全等价）。

**位置约束（实测）**：只能写在 `run` 之后，或不带子命令的 TUI 里。
- `opencode run --auto …` ✅
- `opencode --auto run …` ❌ `Unrecognized flag: --auto in command opencode run`
- `opencode serve --auto` ❌（serve / models / session / mcp 等子命令都不接受）

**配置文件** `opencode.json`：`permission` 可以是字符串（`"allow"` / `"ask"` / `"deny"`）
或对象，对象键含 `edit` / `bash` / `webfetch` / `websearch` / `doom_loop` / `question`，值为 `ask` / `allow` / `deny`。
agent 级 `permission` 可覆盖 provider 级。

### grok（1.0.46）

**命令行**
- `--always-approve`：自动批准全部工具执行
- `--permission-mode` → `default` / `acceptEdits` / `auto` / `dontAsk` / `bypassPermissions` / `plan`
- `--allow`（别名 `--allowedTools`）/ `--deny`（别名 `--disallowedTools`）
- `--sandbox`：文件系统与网络的沙箱档位

**TUI**：`Shift+Tab` 循环 `Normal / Plan / Auto-review / Always-approve`；`Ctrl+O`；或 slash 命令
`/always-approve`、`/auto`、`/settings`。状态栏显示当前模式。

**配置文件** `~/.grok/config.toml`：`[ui] permission_mode = "always-approve" | "auto" | "ask"`；
也读 `.claude/settings.json` 的 `defaultMode`（Claude 兼容）。CLI 覆盖配置。

**注意**：grok 对外发出的 `permission_mode` 值只有 `default` / `auto` / `plan` / `bypassPermissions`。
没有 `acceptEdits` / `dontAsk`（`auto` 最接近），hook 里按 `acceptEdits` 判断永远不匹配。
Always-approve 与 auto 互斥，同时给时 always-approve 优先。

### kimi（2.3.0）

**命令行**
- `-y, --yolo`：「需要时再问」—— 常规编辑与命令自动执行，**高风险操作、提问、计划仍会询问**
- `--auto`：「从不询问」—— 全部自动执行并自动决定 ← **这才是全放开档**

**配置文件** `config.toml`
- `default_permission_mode` → `yolo` / `manual` / `auto`
- 旧键 `default_yolo: true` 自动迁移为 `default_permission_mode = "yolo"`
- 规则块 scope 分级：`turn-override` / `session-runtime` / `project` / `user`

**互斥**：`-y/--yolo` × `--auto` 上游报错。

### qoder（qodercli 1.1.74）

**模式映射链（实测）**
- 配置 `general.defaultPermissionMode`，取值 `default` / `accept_edits` / `auto` / `bypass_permissions` / `dont_ask` / `plan`
- 别名：`yolo` = `bypass_permissions`、`acceptEdits` = `accept_edits`、`dontAsk` = `dont_ask`（大小写不敏感）
- **GUI 里 `bypass_permissions` 的显示标签就是 "YOLO"**
- 内部代号：`bypass_permissions` → `c = "yolo"`
- `security.disableYoloMode` 为 true 时，yolo 被降级为 default 并告警

**命令行**：`--permission-mode bypass_permissions`（**注意下划线**，与 claude 的 `bypassPermissions` 不同）、
`--dangerously-skip-permissions`、`--allowed-tools`、`--disallowed-tools`、`--tools`（`""` 全关、`"default"` 全开）。

### codebuddy（2.161.4，workbuddy 同源）

**档位**（二进制内注册表）
- `dontAsk`：只跑预先批准的与安全只读操作，其余直接拒绝
- `bypassPermissions`：跳过所有权限提示
- **`fullAccess`：跳过全部检查，包括所有 agent 的危险命令**（比 bypassPermissions 更高）

**命令行**
- `--permission-mode` → `acceptEdits` / `bypassPermissions` / `default` / `plan` / `dontAsk` / `auto`
- `-y, --dangerously-skip-permissions`：跳过提示，但 **HIGH/CRITICAL 仍会询问**；完全放开需额外
  `export CODEBUDDY_IS_SANDBOX=1`（仅进程 env，不从 settings.json 的 env 读，高风险）
- `--allowedTools` / `--disallowedTools` / `--tools` / `--sandbox`

**TUI**：`Shift+Tab` 循环模式（`chat:cycleMode`）；`/permissions` 管理 allow / deny 规则。

**配置文件** `~/.codebuddy/settings.json`：与 claude 同一套 `permissions.defaultMode` 等字段。

### kiro（kiro-cli 2.32.0）

**命令行**
- `kiro-cli chat --trust-all-tools`（`-a`）：允许使用任何工具执行命令而不请求确认
- `kiro-cli chat --trust-tools <list>`：只信任名单里的工具（`--trust-tools=` 表示一个都不信任）

**位置约束**：属于 `chat` 子命令；写在根命令或其它子命令下会被拒（退出码 2）。

**配置文件**：`~/.kiro/settings/cli.json` 目前只有 UI 类键，没有权限键；信任按 agent 配置设置。

### cline（3.0.73）

**命令行**
- 默认即全放开：直接给 prompt 就「以 act 模式启动并启用 auto-approve」
- `--auto-approve <boolean>`：为所有工具设置自动批准（默认 `true`）
- `-y, --yolo`：只自动批准**受限**工具集，用于无人值守（benchmark / CI），官方标注 DANGEROUS
- `-p, --plan`：计划模式（只读）
- `-i, --tui`：进入 TUI

**配置文件** `~/.cline/data/globalState.json` 的 `autoApprovalSettings`（**逐项开关，没有单一全放开档**）：
- `enabled`：总开关
- `actions`：`readFiles` / `readFilesExternally` / `editFiles` / `editFilesExternally` /
  `executeSafeCommands` / `executeAllCommands` / `useBrowser` / `useMcp`
- `maxRequests`：自动批准的最大请求数（默认 20）
- `favorites`：UI 里置顶的项

本机当前值：`enabled: true`，`readFiles: true`、`executeSafeCommands: true`，
`editFiles: false`、`executeAllCommands: false`、`useBrowser: false`、`useMcp: false`，
`maxRequests: 20`。

## aih 侧现状与缺口

| 层面 | 现状 |
| --- | --- |
| 存储 | `app-state` 的 `toolkit:tool-permission-settings`（`{ version, apps: { <provider>: { maxPermission, applyToHost, permissionArgs, updatedAt } } }`） |
| provider 级 | `maxPermission` 开关 + `permissionArgs` 逐旗标选择；WebUI 路由 `webui-tool-app-settings-routes.js`；保存时经 `validatePermissionArgs` 校验互斥与取值 |
| 账户级 | **未实现** |
| 读取配置文件作为默认 | **未实现** |
| 启动注入优先级 | **未实现**（当前只有「用户没显式传权限旗标时才注入默认最大权限」） |

设计目标（待实现）：`账户级设置 > provider 级设置 > 该 provider 配置文件里的现值`，
在 `aih <provider>` 打开 TUI / 桌面端时注入；账号 `set-default` 后默认采用账户级设置。

## 维护流程

1. 升级任一 CLI 后，重跑 `npm run providers:usage -- --write` 更新用法快照。
2. 对照本文与 `lib/providers/permission-flag-catalog.js`，核对新增/改名的旗标与取值。
3. 只登记**实测**结论：互斥没实测就不写（宁可漏拦，不可误拦）；每个 provider 标 `verifiedCliVersion`。
4. 发现上游拒绝的参数组合，记到 `cli-version-restrictions.md`。
