# Node 运行时边界（2026-11-22）

## 结论

Go 服务端不再需要 Node：没有 Node 进程时，管理面、WebUI、网关、CLI、Codex 各类
wrapper 全部可用。Node 只在这四类位置上继续存在：

1. **`runtime: node` 插件宿主**（用户装 node 插件时才启动）；
2. **外部/第三方程序**：DSH harness、Provider CLI 的 JS 入口、npm、WorkBuddy 的
   Electron 解码器；
3. **注入到第三方桌面/IDE 进程里的 JS 资产**（ZCode、CodeBuddy IDE 桥）；
4. **仓库开发脚本**（`scripts/**`、打包/发布工具），不进入产品运行路径。

代码贡献方向：新增运行期行为一律写 Go；只有上述四类位置可以带 Node。

## 本轮删除

| 提交 | 内容 | 依据 |
|---|---|---|
| `fbef4f1c` | `lib/plugins/host/{supervisor,dispatcher}.js`、`lib/plugins/transport/{address,rpc-client}.js` | Node 侧宿主客户端；唯一客户端是 Go 的 `pluginhost.Supervisor`，这四个文件互相引用之外无入边 |
| `b39981d0` | `lib/server/app-installers/**`（26 个文件） | 安装计划已归 `internal/runtime/toolkit/apps` + `webuitoolkitcoreapi`；整目录无任何 require |
| `44008326`（并行会话） | `lib/server/codex-app-server-stdio-proxy*.js`（14 个文件） | wrapper 已只执行 Go CLI，Codex app-server 走 `__codex-app-server-stdio` |
| `b652355c` | `lib/sessions/**`（20 个，保留 `cline-session-store`/`session-db-pool`）、`lib/account` 账号同步簇（8 个） | 唯一消费者是上一条被删的 Node proxy；Go 侧会话扫描/账号同步已独立实现 |
| `64e182d4` | `lib/cli/services/{pty,ai-cli}/codex-*.js`、`lib/runtime` 旧 launcher/PTY/权限旗标等 10 个、`lib/server` 旧 codex 辅助 22 个 | 入边同样只来自被删的 Node proxy；`provider-resume` / storage-policy 这两条仍被开发脚本使用的链已实测可加载 |
| `3707acbc` | `scripts/codex-app-server-stdio-proxy-split.cjs` | 一次性拆分脚本，输入文件已删除 |

`lib/sessions` 曾在 `02185bd4` 被恢复，因为当时 Node proxy 仍是活代码；proxy 删除
后这批文件再次成为死代码，本轮按同一判据（真实可达性，而不是"曾经用过"）再次删除。

## 保留清单与调用点

### 1. node 插件宿主

- Go 启动点：`internal/runtime/pluginhost/supervisor.go`（`exec.Command(node, host-entry.mjs …)`，
  入口发现见 `resolveHostScripts`）。
- 活文件：`lib/plugins/host/{host-entry.mjs,host-runtime.mjs,dependency-graph.js,register-hooks.mjs,resolve-hooks.mjs}`、
  `lib/plugins/transport/{rpc-server,frame}.js`、`lib/plugins/sdk/*`。
- 为什么不能删：node 插件本身就是 Cordis 模块，必须在 Node 里 `require`/`import` 后运行；
  Go 侧 `ProcessHost` 只覆盖 `runtime: process`（语言无关行协议），见 `docs/plugins/process-runtime.md`。
- 它是懒启动：没有 node 插件时 `HybridHost.Start` 只启动 process 后端，不会拉起 Node。

### 2. 外部/第三方程序

| 位置 | 调用点 | 说明 |
|---|---|---|
| DSH harness | `internal/runtime/harnessrun/run.go`（`resolveNodeExecutable`） | 只有 DSH 家族需要 Node；`pi` 由 PATH 直接解析 |
| Provider CLI 版本探测 | `internal/runtime/providercliupgrade/probe.go` | 官方 CLI 的 JS 入口/shim 用 node 执行 |
| npm 安装/升级 | `internal/runtime/providercliupgrade/npm_command.go` | npm 本身是 Node 程序 |
| WorkBuddy 凭据解码 | `internal/adapters/hostdetect/native_detector_codebuddy.go` | 用厂商 Electron（`ELECTRON_RUN_AS_NODE=1`）执行 `scripts/aih-workbuddy-credential-codec.cjs`，因为解密依赖 Electron safeStorage |
| 桌面端拉起 Provider CLI | `internal/transport/http/webuiopenappapi/desktop_providers.go` | 目标 CLI（claude/codex/opencode）自身的 Node 入口 |

### 3. 注入到第三方进程的 JS 资产

Go 只负责写文件/拼命令，JS 在第三方进程里运行，因此必须是 JS：

- `lib/runtime/zcode-electron-captcha-hook.js`（`desktop_zcode.go`）
- `lib/runtime/zcode-session-attribution-runner.js` 及其 hook/context/bridge 依赖
  （`desktop_zcode.go:ensureZcodeAgentLauncher`，生成 `zcode-agent-launcher.cjs`）
- `lib/runtime/codebuddy-ide-bridge-extension.cjs`、`codebuddy-ide-bridge-files.js`、
  `native-session-bridge-files.js`（`desktop_providers.go:prepareCodebuddyIdeBridge`）
- `lib/server/{account-credential-store,business-database,app-state-store,zcode-harness-store,zcode-region}.js`
  等经上面这些入口间接需要的模块

### 4. 开发脚本

`scripts/**` 与 `lib/**` 中被脚本 require 的模块（打包、发布、对比、迁移工具）。
这些不进入产品运行路径，Node 是它们的执行环境。

## 复核方法

1. 静态可达性：以 Go 源码中的实际资产路径、`lib/plugins/host/host-entry.mjs`、`scripts/**`
   入口为根，按 `require`/`import`/字符串路径解析 `lib/**` 与 `scripts/**` 的模块图，
   不可达者即候选死文件。
2. 每个候选再按文件名全仓 grep（含 `path.join(__dirname, ...)` 形式的动态引用），
   开发脚本与 Go 注释都可能引用；只删除确认无入边的文件。
3. 删除后跑 `go build ./...`、`go test ./internal/runtime/pluginhost/... ./internal/runtime/codexhooks/...`，
   并对仍被开发脚本使用的链做一次 `node -e "require(...)"` 实测。

本轮复核结果：`lib/**` + `scripts/**` 里 269 个 `.js/.mjs/.cjs` 全部可从上面四类根到达
（唯一被静态图漏判的是 `scripts/fixtures/web-terminal-resize-tui.js`，由
`scripts/web-terminal-resize-benchmark.js` 以 `path.join(__dirname,'fixtures',...)`
引用，属活文件）。`go build ./...` 在 TEMP worktree 的 HEAD 上通过；
`pluginhost`、`codexhooks` 测试通过。