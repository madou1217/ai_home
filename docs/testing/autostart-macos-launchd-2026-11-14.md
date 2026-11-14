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

## 3. 验证项与结果（只读复核，2026-11-14 21:19 CST）

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

原始输出见附录 A（22:35 CST 捕获；期间作业被重新 bootstrap，`pid`/`runs` 已重置，与上表不是同一时刻的快照）。

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

## 附录 A：launchctl print 原始输出

捕获时间：2026-11-14 22:35 CST（机器本地时区）。命令：

```bash
launchctl print gui/$(id -u)/com.meadeo.ai_home
```

输出：

```
gui/501/com.meadeo.ai_home = {
	active count = 1
	path = /Users/model/Library/LaunchAgents/com.meadeo.ai_home.plist
	type = LaunchAgent
	state = running

	program = /Users/model/projects/feature/ai_home/bin/native/darwin-arm64/aih-server
	arguments = {
		/Users/model/projects/feature/ai_home/bin/native/darwin-arm64/aih-server
		--host
		127.0.0.1
		--front-door
		--supervise-node
	}

	stdout path = /Users/model/.ai_home/logs/services/background-supervisor.log
	stderr path = /Users/model/.ai_home/logs/services/background-supervisor.log
	inherited environment = {
		SSH_AUTH_SOCK => /var/run/com.apple.launchd.Q88Mb6yO6N/Listeners
	}

	default environment = {
		PATH => /usr/bin:/bin:/usr/sbin:/sbin
	}

	environment = {
		OSLogRateLimit => 64
		PATH => /Users/model/.qoder-cn/entry:/Users/model/.qoder/entry:/Users/model/.volta/bin:/Users/model/.codex/packages/standalone/releases/0.167.2-aarch64-apple-darwin/codex-path:/Users/model/.kimi-code/bin:/Users/model/.grok/bin:/Users/model/.antigravity-ide/antigravity-ide/bin:/Users/model/.antigravity-ide/antigravity-ide/bin:/Users/model/.local/bin:/Users/model/Library/pnpm:/Users/model/.opencode/bin:/Users/model/.antigravity/antigravity/bin:/opt/homebrew/opt/mysql-client@8.0/bin:/Users/model/.npm-global/bin:/Users/model/.codebuddy/bin:/Users/model/.local/bin:/Applications/Docker.app/Contents/Resources/bin:/Users/model/.nvm/versions/node/v22.21.0/bin:/opt/homebrew/opt/openjdk/bin:/opt/homebrew/opt/php@8.3/sbin:/opt/homebrew/opt/php@8.3/bin:/Users/model/.composer/vendor/bin:/Users/model/projects/shalou/vendor/bin:/Applications/Docker.app/Contents/Resources/bin:/Users/model/.nvm/versions/node/v22.21.0/bin:/opt/homebrew/bin:/Users/model/bin:/Users/model/.local/bin:/usr/local/bin:/Users/model/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/pkg/env/global/bin:/Library/Apple/usr/bin:/Users/model/.volta/bin:/Users/model/.codex/tmp/arg0-macos/codex-arg0YDl9QY:/Users/model/.codex/packages/standalone/releases/0.167.2-aarch64-apple-darwin/codex-path:/Users/model/.kimi-code/bin:/Users/model/.grok/bin:/Users/model/.antigravity-ide/antigravity-ide/bin:/Users/model/.local/bin:/Users/model/Library/pnpm:/Users/model/.opencode/bin:/Users/model/.antigravity/antigravity/bin:/opt/homebrew/opt/mysql-client@8.0/bin:/Users/model/.npm-global/bin:/Users/model/.codebuddy/bin:/Applications/Docker.app/Contents/Resources/bin:/Users/model/Library/pnpm/bin:/opt/homebrew/opt/openjdk/bin:/opt/homebrew/opt/php@8.3/sbin:/opt/homebrew/opt/php@8.3/bin:/Users/model/.composer/vendor/bin:/Users/model/projects/shalou/vendor/bin:/Users/model/.nvm/versions/node/v22.21.0/bin:/opt/homebrew/bin:/Users/model/bin:/opt/homebrew/sbin:/Users/model/Library/Application Support/JetBrains/Toolbox/scripts:/Applications/Warp.app/Contents/Resources/bin:/Users/model/Library/Application Support/JetBrains/Toolbox/scripts
		AIH_HOME_DIR => /Users/model/.ai_home
		HOME => /Users/model
		XPC_SERVICE_NAME => com.meadeo.ai_home
	}

	domain = gui/501 [100014]
	asid = 100014
	minimum runtime = 5
	exit timeout = 12
	runs = 1
	pid = 24202
	immediate reason = speculative
	forks = 2427
	execs = 1
	initialized = 1
	trampolined = 1
	started suspended = 0
	proxy started suspended = 0
	checked allocations = 0 (queried = 1)
	checked allocations reason = no host
	checked allocations flags = 0x0
	last exit code = (never exited)

	semaphores = {
		successful exit => 0
	}

	resource coalition = {
		ID = 161331
		type = resource
		state = active
		active count = 1
		name = com.meadeo.ai_home
	}

	jetsam coalition = {
		ID = 161332
		type = jetsam
		state = active
		active count = 1
		name = com.meadeo.ai_home
	}

	spawn type = daemon (3)
	jetsam priority = 40
	jetsam memory limit (active) = (unlimited)
	jetsam memory limit (inactive) = (unlimited)
	jetsamproperties category = daemon
	jetsam thread limit = 32
	cpumon = default
	sanitizer flags = 0x0

	properties = runatload | inferred program
}
```
