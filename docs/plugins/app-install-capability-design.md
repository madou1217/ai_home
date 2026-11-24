# 插件式应用安装能力槽设计（`app.install` v1）

日期：2026-11-25

状态：设计稿，未实现。

目标：让第三方以**签名/可发现的能力插件**声明桌面客户端、IDE 或 CLI 的安装、
更新、卸载、状态与打开，WebUI 的 Toolkit 与 Accounts 自动出现对应入口；核心只保留
作业编排、确认、超时、代理、脱敏、审计与通用 UI，不再新增厂商安装脚本。

## 1. 结论先行

1. 新增能力槽 `app.install`（mode=`collect`，version=1），语义与
   `network.connector` 一致：插件负责 **describe / status / operate**，宿主负责
   把结果映射到现有 `app-install` 作业、应用清单和账号入口。
2. **安装动作在插件进程内执行**，宿主不执行插件返回的命令字符串。这是与
   “插件返回 LifecyclePlan、宿主代跑”方案的关键区别，见 §3。
3. 插件必须声明 `permissions.installers: true` 才能贡献 `app.install`；
   安装插件本身仍走现有信任流程，不改变“未签名默认放过并标记”的策略。
4. 内置应用（如当前 Antigravity、Codex、Claude 的安装计划）保留为兜底；
   插件应用是**增量**，v1 不做覆盖内置应用。
5. 账号页的 Provider 级安装/打开条、Toolkit 应用卡、无桌面 Server 隐藏逻辑
   全部复用现有数据面，不需要新增厂商分支。

## 2. 能力合同

### 2.1 清单声明

```json
{
  "manifestVersion": 1,
  "kind": "capability",
  "protocolVersion": 2,
  "pluginId": "antigravity.desktop",
  "version": "1.0.0",
  "engines": { "aih": ">=1.0.0" },
  "runtime": "process",
  "entry": "desktop.py",
  "exec": { "argv": ["python3", "desktop.py"] },
  "permissions": {
    "network": ["https://antigravity.google", "https://storage.googleapis.com"],
    "filesystem": { "read": ["state"], "write": ["state"] },
    "secrets": [],
    "environment": [],
    "installers": true
  },
  "contributes": [
    {
      "id": "antigravity.desktop.apps",
      "capability": "app.install",
      "version": 1,
      "failurePolicy": "delegate",
      "scope": { "providers": ["agy"] }
    }
  ]
}
```

- `permissions.installers` 是新字段，布尔值，缺省 false。安装预检时：
  - 贡献 `app.install` 但未声明 `installers:true` → `plugin_capability_requires_installers`。
  - 声明了 `installers:true` 但没贡献 `app.install` → 允许，但 Doctor 给
    `plugin_installers_unused` 警告。
- `scope.providers` 只做展示分组与冲突检查，不限制插件能报告哪些 appId。
- `targets` 继续用于平台/架构过滤；插件仍应在 describe 里给出 `platforms`，
  两者取交集。

### 2.2 贡献项调用协议

宿主对每个贡献项依次调用（与 `network.connector` 同形）：

| kind | 方向 | 超时 | 说明 |
|---|---|---|---|
| `describe` | 宿主 → 插件 | 10s | 返回该插件声明的应用；结果按代次缓存 |
| `status` | 宿主 → 插件 | 5s | 批量查询 appId 状态；30s 缓存 |
| `operate` | 宿主 → 插件 | install/update 30m；uninstall 5m；open 30s | 执行动作并返回步骤与最终状态 |

请求统一带 `schemaVersion: 1` 与 `kind`。

#### describe

```json
{
  "schemaVersion": 1,
  "kind": "describe"
}
```

响应：

```json
{
  "apps": [
    {
      "appId": "antigravity-desktop",
      "provider": "agy",
      "name": "Antigravity",
      "kind": "desktop",
      "platforms": ["macos", "windows", "linux"],
      "order": 10,
      "capabilities": {
        "install": true,
        "update": true,
        "uninstall": true,
        "open": true,
        "accountScope": false
      },
      "install": {
        "requiresConfirmation": true,
        "requiresAdmin": false,
        "downloadBytes": 242043825
      },
      "uninstall": { "removesUserData": false },
      "open": { "mode": "plugin" }
    }
  ]
}
```

字段约束：

- `appId`：`^[a-z0-9][a-z0-9._-]{0,127}$`，全局唯一；与内置 `AppView.ID`
  冲突时整条拒绝（`app_install_duplicate`），不做覆盖。
- `provider`：现有 Provider ID 或空串（纯工具应用）。空串时只进 Toolkit，
  不进账号页。
- `kind`：`desktop` | `ide` | `cli`。`ide` 在作业层归一到 `desktop`，
  与现有 `normalizeLifecycleKind` 一致。
- `platforms`：`macos` | `windows` | `linux`；空数组表示全平台。
- `capabilities.open.mode`：`plugin`（默认，插件自己拉起）或 `host`
  （宿主按 `executable` 拉起；v1 仅允许无账号投影的应用）。
- 每个贡献项最多 32 个应用；文本最长 160 字符；描述最长 512 字符。

#### status

```json
{
  "schemaVersion": 1,
  "kind": "status",
  "appIds": ["antigravity-desktop"]
}
```

响应：

```json
{
  "apps": [
    {
      "appId": "antigravity-desktop",
      "installed": true,
      "state": "installed",
      "version": "2.35.0",
      "executable": "/Users/me/Applications/Antigravity.app",
      "running": false,
      "updateAvailable": false
    }
  ]
}
```

- 一次调用返回插件所有被查询的 appId；缺失的 appId 视为 `unknown`。
- 宿主对 `executable` 做本机存在性校验（非空且是绝对路径时）。校验失败 →
  `installed=false, state="invalid"`，防止插件只靠布尔值冒充已安装。
- `executable` 在 HTTP 响应中按宿主 HOME 脱敏为 `~/...`。
- `running` 只用于展示角标，不作为打开/关闭的依据。

#### operate

```json
{
  "schemaVersion": 1,
  "kind": "operate",
  "appId": "antigravity-desktop",
  "action": "install",
  "platform": "macos",
  "arch": "arm64",
  "proxyUrl": "http://127.0.0.1:50219",
  "jobId": "app-install-..."
}
```

- `action`：`install` | `update` | `uninstall` | `open` | `close`。
- `proxyUrl`：只允许 **无认证的 loopback HTTP 代理**；没有可用出口时为空。
  插件不得把它写入日志或状态。
- `jobId`：仅用于插件日志关联，不参与鉴权。
- 不传 `confirmed`：确认是宿主授权事实，插件不应重复判断。

响应：

```json
{
  "ok": true,
  "changed": true,
  "status": { "appId": "antigravity-desktop", "installed": true, "version": "2.35.0" },
  "steps": [
    { "id": "download", "label": "下载 Antigravity 2.35.0", "ok": true },
    { "id": "install", "label": "安装到 ~/Applications", "ok": true }
  ],
  "output": ["installed: ~/Applications/Antigravity.app"],
  "progress": { "percent": 100, "label": "安装完成" }
}
```

- `steps` 映射到现有 `JobView.Attempts`；`output` 最多 40 行、每行 512 字符。
- `progress` v1 只在结束时返回；长时间安装期间作业显示 `phase="installing"`
  与不定进度。v1.1 再评估宿主进度回调（见 §8）。
- 失败时 `ok=false` + `message`；宿主映射为作业 `failed`，保留已完成步骤。

### 2.3 错误码

在 `contracts/plugins/contract.json#errorCodes` 追加：

- `app_install_descriptor_invalid`
- `app_install_duplicate`
- `app_install_status_invalid`
- `app_install_operation_unsupported`
- `app_install_confirmation_required`
- `app_install_payload_too_large`
- `app_install_plugin_unavailable`
- `app_install_proxy_invalid`

宿主内部作业错误继续用 `*_not_supported` / `install_failed` 等现有词表。

## 3. 为什么不让宿主执行插件返回的安装计划

备选方案：插件 describe 返回 `LifecyclePlan`（command/args/env/timeout），
宿主复用现有 `apps.JobManager` 直接执行。

不采用的原因：

1. **执行边界**：`command` 是插件提供的任意可执行文件与参数；等于把“安装一个
   插件”升级为“以服务用户身份执行任意命令”。现有 process 插件本来就没有沙箱，
   但至少安装逻辑在插件自己的代码里，受插件安装确认与代码审查约束；宿主代跑会
   把风险扩大到所有声明了该能力的清单。
2. **代理与凭据**：宿主的代理租约、匿名 loopback、环境变量注入都在宿主侧；
   插件代跑时由宿主把 `proxyUrl` 作为数据传入，边界更清晰。
3. **平台差异**：DMG/NSIS/tar.gz、UAC、签名校验、安装后探测都在插件里演进，
   不必改核心；这与 `network.connector` 的既有分工一致。
4. **可预览性**：宿主代跑的唯一优势是 `/apps/plan` 预览命令；插件模式用
   describe 的 `install.requiresAdmin/downloadBytes` 与 operate 的确认文案替代。

代价：宿主无法在计划阶段展示具体命令；v1 接受。

## 4. 宿主结构

### 4.1 新增/修改文件

| 文件 | 变更 |
|---|---|
| `contracts/plugins/contract.json` | 能力 `app.install`、错误码、limits |
| `contracts/plugins/manifest.schema.json` | `permissions.installers` |
| `internal/runtime/pluginhost/app_install.go` | 新文件：describe/status/operate、校验、脱敏、缓存 |
| `internal/runtime/pluginhost/service.go` | 装配 `AppInstallService`，代次变更时失效缓存 |
| `internal/runtime/toolkit/apps/types.go` | `PluginApp`、`PluginAppStatus`、`PluginAppSource` 接口 |
| `internal/runtime/toolkit/apps/discovery.go` | 应用清单合并插件应用 |
| `internal/runtime/toolkit/apps/jobs.go` | 目标解析与执行分支：插件应用走 `PluginAppSource.Operate` |
| `internal/transport/http/webuiappentriesapi/detector.go` | 合并插件状态（只读缓存快照） |
| `internal/host/aihserver/*` | 组合注入 pluginhost 实现 |
| `web/src/components/toolkit/AppManagerPanel.tsx` | 可选：来源标签“插件” |

### 4.2 端口

```go
// internal/runtime/toolkit/apps
type PluginApp struct {
    AppID      string
    Provider   string
    Name       string
    Kind       string // desktop | ide | cli
    Platforms  []string
    Order      int
    Capabilities PluginAppCapabilities
    Install    PluginAppInstallHint
}

type PluginAppStatus struct {
    AppID           string
    Installed       bool
    State           string
    Version         string
    Executable      string
    Running         bool
    UpdateAvailable bool
}

type PluginAppSource interface {
    Apps() []PluginApp
    Snapshot() map[string]PluginAppStatus // 只读缓存，不阻塞
    Refresh(ctx context.Context) error
    Operate(ctx context.Context, appID, action string, req PluginOperateRequest) (PluginOperateResult, error)
}
```

- `Apps` 来自激活代次的 describe 缓存；插件代次切换时整体替换。
- `Snapshot` 永不调用插件；未刷新时返回空 map，UI 先显示“未安装”并在下一轮
  轮询补全（符合“列表先出内容再异步补数据”）。
- `Refresh` 单飞 + 30s TTL；一次 `status` 调用批量查询该插件的全部 appId。
- `Operate` 由 `JobManager` 在作业 goroutine 中调用，宿主负责确认、超时、
  代理租约与审计。

### 4.3 作业映射

`JobManager.Start` 当前要求 `getInstaller(provider) != nil`。新增顺序：

1. `ResolveInstallTarget` 先查插件应用注册表；命中则用插件声明填充
   `Provider/Kind/AppID`，不要求内置 installer。
2. `CanInstall` 同时看内置计划与插件 `capabilities.install/update/uninstall`。
3. `runJob` 分支：插件应用 →
   `PluginAppSource.Operate(ctx, appID, action, req)`，把 `steps` 写入
   `Attempts`、`status` 写入 `Result`、`progress` 写入 `Progress`。
4. 失败不改重试语义：v1 不自动换插件出口重试；自动代理仍由宿主选择后传入。
5. 取消：作业 context 取消 → 插件 RPC `cancel`；插件应终止子进程并清理临时文件。

### 4.4 应用清单合并

`apps.List` 在内置 CLI/Desktop/IDE 之后追加插件应用：

- `AppView.ID = appId`，`Type = kind`，`Categories = ["ALL", kind 对应分类]`；
- `Installed/Version` 来自 `Snapshot`；
- `InstallAvailable/CanUpdate/CanUninstall` 来自 capabilities；
- 新增 `Source: "plugin"`、`PluginID` 字段，UI 可显示来源标签；
- 与内置 appId 冲突的插件应用在 describe 阶段就拒绝，不会进入清单。

### 4.5 账号入口

`app-entries` 的 `capabilities[provider][kind]` 与
`entries[provider][kind]` 改为内置 ∪ 插件：

- capability：任一插件应用声明该 provider+kind 且平台匹配；
- installed：内置探测为真，或插件 `Snapshot` 中该 provider+kind 任一为真；
- 插件状态未知时 installed=false，不阻塞 capability，UI 显示“安装”；
- `serverRuntime` 逻辑不变：无桌面系统不出现安装/打开。

Accounts 页现有的 Provider 级条与账号行按钮无需改代码。

## 5. 安全与权限

1. **确认**：install/uninstall/update 必须 `confirmed=true`；与
   `network.connector` 一致，非 UI 调用默认拒绝。
2. **权限声明**：`installers:true` 是安装确认页的显式条目，文案固定为
   “此插件会下载并运行安装程序，等同于以服务用户身份执行代码”。
3. **信任**：沿用现有策略（未签名默认放过并如实标记）；不为该能力单独强制签名，
   但插件详情页对 installers 能力做高亮。
4. **代理**：只传匿名 loopback HTTP 代理；拒绝带 userinfo 的 URL、非 loopback、
   非 http(s)。插件网络目标必须在 `permissions.network` 内。
5. **输出脱敏**：`output` 去掉 URL 凭据、把宿主 HOME 替换为 `~`、截断长度；
   不返回原始 stdout/stderr。
6. **审计**：每次 operate 写 `plugins/audit.log`：pluginId、appId、action、
   ok、耗时、错误码；不写代理 URL、不写凭据。
7. **不执行插件命令**：宿主只调用插件 RPC，不把 `steps`/`output` 当命令。
8. **超时**：describe/status 快速失败；install/update 30 分钟，uninstall 5 分钟；
   超时即失败并释放代理租约。

## 6. UI

- Toolkit → 应用管理：插件应用与内置卡同形，多一个“插件”来源标签；安装/更新/
  卸载按钮走现有作业队列与 SSE。
- Accounts：Provider 级条与账号行沿用 `app-entries`；插件应用出现在对应
  Provider tab，无需新增分支。
- 无桌面 Server：`serverRuntime=true` 时不显示安装/打开；Toolkit 仍可安装
  CLI（现有行为）。
- 失败展示：作业卡显示失败步骤与脱敏输出，不弹大块 Alert。

## 7. 兼容与迁移

1. **增量**：内置应用不迁移，插件应用不能覆盖内置 appId；同 provider+kind
   允许多个插件应用，账号入口取 OR。
2. **Antigravity 参考插件**：
   - Phase 1：`plugins/antigravity-desktop` 只实现 `status`/`open`，与内置
     安装计划并行，验证注册、缓存、账号入口、Server 隐藏。
   - Phase 2：实现 install/uninstall/update，用真实 DMG/NSIS 在 Mac/Windows
     验证；内置计划继续兜底。
   - Phase 3（可选）：在插件稳定后移除 `catalog_installers.go` 里的 agy 桌面
     安装计划；Provider 合同里的 DesktopClient 保留给账号级启动投影。
3. **插件代次**：插件卸载/禁用 → describe/status 缓存整体失效；应用清单与
   app-entries 下一轮刷新后消失；进行中的作业立即失败并给出
   `app_install_plugin_unavailable`。

## 8. 后续（v1.1+）

- **进度回调**：扩展 host service `aih.progress`（插件 → 宿主 call），
  作业实时更新 percent/label；需要给 RPC 增加宿主方法分发与鉴权。
- **账号级打开**：`accountScope:true` 的应用由宿主准备账号投影/环境，再把
  `runtimeDir`、`env` 传给插件；v1 只支持无账号 open 或宿主 open。
- **内置覆盖**：显式 `replacesBuiltinAppId` + 信任确认，用于把内置安装计划
  平滑迁出核心。
- **命令预览**：若未来仍要计划预览，可让插件返回**脱敏的步骤描述**，而不是
  可执行命令。

## 9. 验证计划（不新增测试文件，全部真机）

1. **参考插件**：安装/启用后 Toolkit 出现 Antigravity 卡；Accounts 空 tab 出现
   安装条；Mac 与 Windows 真实安装、打开；Linux 无桌面不显示。
2. **失败路径**：插件返回非法 appId、重复 appId、installed=true 但 executable
   不存在、operate 超时、installers 未声明 → 分别得到对应错误码，UI 不崩。
3. **信任与确认**：未确认的 install/uninstall 被拒绝；确认后执行；审计有记录。
4. **代理**：带 userinfo 的 proxyUrl 被拒绝；匿名 loopback 可用；作业结束租约释放。
5. **代次切换**：禁用插件后清单与账号入口消失；重新启用后恢复；进行中作业失败。
6. **回归**：内置 Antigravity 安装/打开路径不受影响；其他 Provider 的 app-entries
   与 Toolkit 结果不变。

## 10. 待定问题

- 一个 provider+kind 有多个插件应用时，账号行只显示一个图标；是否需要选择器？
  倾向 v1 取 OR、不提供选择器，避免 UI 复杂度。
- `kind:ide` 是否应进入 Toolkit 的 IDE 扩展页，而不是 Desktop 分类？倾向
  与内置 IDE 客户端一致，进入 IDE 页。
- 插件安装的 CLI 是否允许被账号命令行直接使用（例如 PATH 注入）？v1 只保证
  应用清单可见与打开，PATH 注入仍由内置安装器负责。
