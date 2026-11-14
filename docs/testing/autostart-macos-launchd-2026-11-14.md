# 自启验证报告：macOS launchd

- 日期：2026-11-14
- 范围：`aih server start` 在 macOS 上安装的 LaunchAgent，是否由 launchd 直接运行 Go 服务，以及重启路径是否可用
- 结论：**通过**。launchd 作业主体是 `aih-server --front-door --supervise-node`，Node 只是它的子进程；现网作业 `state = running`、`readyz` 200、`/v1/models` 224、`/v0/webui/accounts` 41
- 相关提交：`90f11588`（监督关系反转，plist 改为 Go-first）、`ad6d5804`（host 收敛，修复崩溃循环）、`c8014265`（重启改走 launchctl）、`f442f6ef`（plist 钉住 AIH_HOME_DIR）

## 1. 环境

| 项 | 值 |
|---|---|
| 平台 | macOS（Apple Silicon / arm64），launchd `gui/<uid>` 域 |
| 作业 | `com.meadeo.ai_home` |
| 被测二进制 | `bin/native/darwin-arm64/aih-server` |
| Node | v22，仅作为 Go 的子进程运行尚未迁移的 `/v0` 路由 |

## 2. 被测产物（当前安装的 plist）

```xml
ProgramArguments = [
  "<repo>/bin/native/darwin-arm64/aih-server",
  "--host", "127.0.0.1",
  "--front-door", "--supervise-node"
]
RunAtLoad = true
KeepAlive = { SuccessfulExit = false }
ExitTimeOut = 12
ThrottleInterval = 5
ProcessType = Standard
StandardOutPath/StandardErrorPath = <aiHome>/logs/services/background-supervisor.log
EnvironmentVariables = {
  HOME = /Users/<user>,
  AIH_HOME_DIR = /Users/<user>/.ai_home,
  PATH = <安装时的登录 PATH>
}
```

说明：host/port/密钥由 Go 自读 `config:server`，plist 只显式钉住 loopback host 与 home；端口不写进参数（本次现网即按持久化的 9527 监听）。

## 3. 验证项与结果（只读复核，2026-11-14）

| 检查 | 结果 |
|---|---|
| `launchctl list` | 作业已加载，PID 98914 |
| `launchctl print` | `state = running`、`job state = running`、`runs = 6`、`properties = runatload` |
| 作业主体 | `aih-server --host 127.0.0.1 --front-door --supervise-node`，PPID = 1（launchd） |
| Node 关系 | `ai-home.js server serve --host 127.0.0.1 --port 52299`，PPID = Go 进程 |
| `readyz` | 200（`ready:true`） |
| `/v1/models` | 200，224 个模型 |
| `/v0/webui/accounts` | 200，41 个账号 |
| 生成器与安装态一致性 | ProgramArguments、RunAtLoad、KeepAlive、日志路径、AIH_HOME_DIR 与 HEAD 生成器输出一致 |

### 重启路径（本会话内已验证）

- `POST /v1/management/webui/server/restart` 返回 `202 {"restarting":true,...}`，随后 launchd 以新 PID 重建 Go 与 Node 子进程（`c8014265`）；
- 原生重启实现：`launchctl kickstart -k gui/<uid>/com.meadeo.ai_home`；没有受管作业时明确返回 503，不退回 Node；
- 安装/重装路径：写 plist → `launchctl bootstrap gui/<uid> <plist>` → `kickstart`；会话内两次重装后均由 launchd 正常拉起。

## 4. 验证中发现并修复的问题

### 4.1 plist 仍先起 Node（`90f11588`）

原 `ProgramArguments` 是 `aih __background run`（Node 主体，Go 为子进程）。已反转为 `aih-server --front-door --supervise-node`：Go 持有公开端口并拉起/守护 Node；Node 以 `AIH_GO_CORE_EXTERNAL_URL` 外部模式运行，不再自己 spawn Go。

### 4.2 重装 plist 后 Go 启动失败、launchd 崩溃循环（`ad6d5804`）

一次重装丢了 `--host`，Go 读到持久化的 `host=0.0.0.0`（Node 时代 openNetwork 遗留），因只允许 loopback 而启动即退出，launchd 进入 `runs=127` 的崩溃循环，服务短暂不可用。修复：

- 持久化 host 非 loopback 时回落到 `127.0.0.1`（显式 env/flag 仍严格拒绝非 loopback）；
- plist 生成器固定写入 `--host 127.0.0.1`。

### 4.3 plist 未钉住 home（`f442f6ef`）

launchd 不继承安装者 shell 环境，自定义 `AIH_HOME_DIR` 会丢失。生成器现写入 `EnvironmentVariables.AIH_HOME_DIR`；当前安装的 plist 已包含该键。

## 5. 边界

- **未做真实重启**（该机是工作站，不能为了验证重启）；开机等价路径由 `RunAtLoad=true` + `launchctl bootstrap`/`kickstart -k` 的重建行为覆盖。
- 现网 plist 的 PATH 是安装时的登录 PATH 快照；之后新增的工具路径不会自动进入服务环境（已知行为）。
- 端口来自 `config:server`；改动端口需要写配置并重启作业，而不是改 plist。

## 6. 复现要点

1. 生成 plist：`createMacosLaunchAgent({ aiHomeDir, hostHomeDir, launchdPlist })`，检查 ProgramArguments = `aih-server --host 127.0.0.1 --front-door --supervise-node`、`RunAtLoad`、`KeepAlive.SuccessfulExit=false`、AIH_HOME_DIR。
2. 装载：`launchctl bootstrap gui/<uid> <plist>`；重装用 `bootout` → `bootstrap`。
3. 判定：`launchctl print` 中 `state=running` 且 program 指向 aih-server；进程树里 Node 是 Go 的子进程；`readyz` 200。
4. 重启：`launchctl kickstart -k gui/<uid>/com.meadeo.ai_home`，或管理端点 `POST /v1/management/webui/server/restart`（202）。
