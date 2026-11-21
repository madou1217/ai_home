# Node 兼容别名与遗留网关审计（2026-11-21）

## 结论

当前不存在第二套 Node HTTP 网关。审计时旧 Node 网关代码仍留在源码树里，但没有任何产品入口能启动它：
`bin/aih` 直接 exec Go CLI，launchd 运行 Go `aih-server`，`package.json` 的 `main: index.js` 指向不存在的文件，也没有启动 Node server 的 npm script。这些不可达代码已于 2026-11-21 删除（见文末）。

因此：

- `/v0/management/*`、`/v0/webui/*` 等旧路径由 Go 的兼容别名承接，不是 Node 反代；
- 数据面可比路由（`/v1/*`、`/healthz`、`/readyz`）Node 端 14 条，Go 缺失 **0** 条；
- Node 仅保留宿主/插件运行时能力和脚本，不再拥有 HTTP 路由。

## 运行态证据

| 检查 | 结果 |
| --- | --- |
| 9527 监听进程 | `aih-server`（Go） |
| launchd ProgramArguments | `bin/native/darwin-arm64/aih-server` |
| `bin/aih` | 直接 exec 原生 Go CLI，无 Node 回落 |
| 旧 Node 网关进程 | 无 |
| 旧路径实测 | `/v0/management/{status,accounts,usage}`、`/v0/webui/{accounts,terminal/sessions}` 均 200（Go） |

## 路由扫描

`node scripts/collect-gateway-routes.js --json`：

```
node total 258 / endpoints 253
go   total  71 / endpoints  70
data-plane comparable node 14, missing in Go 0
```

扫描器只对 `/v1/*` 与 `/healthz`、`/readyz` 做跨端对拍；`/v0/webui` 由 Go 公共别名承接，已用上面的真实请求单独验证。

## 已删除的 Node 网关文件

以下文件在审计时只被旧 Node CLI/server 入口互相引用，产品入口不可达，现已全部删除：

- `lib/server/server.js`（2,127 行）
- `lib/server/entry.js`（105 行）
- `lib/server/v1-router.js`（2,489 行）
- `lib/server/web-ui-router.js`（1,559 行）
- `lib/server/management-router.js`（289 行）
- `lib/cli/app.js`（766 行，无入口 require）
- `lib/server/webui-*-routes.js`（54 个文件，10,690 行）

合计约 **18,000 行** 不可达网关代码。保留它们不会产生双 owner，但会让路由扫描和迁移审计持续把它们当成有效路由面，因此已删除。

## 仍存活的 Node 宿主能力

这些不是 HTTP 网关，属于合同允许的宿主/插件/工具运行时，均由 Go 侧显式调用：

| 能力 | 入口 | 合同/证据 |
| --- | --- | --- |
| Codex app-server stdio 代理 | `lib/server/codex-app-server-stdio-proxy.js` | `internal/host/aihserver/codex_hooks_runtime.go` 启动；运行态有真实进程 |
| 插件 JS 运行时 | 插件清单 `entry` + `runtime` | `internal/runtime/pluginhost/spec.go` 默认 `node`，`hybrid_host.go` 明确 node/process 双 runtime |
| Provider 桌面运行时 | Provider 合同声明的 `desktop-node` handler | `internal/runtime/nativeresources/runtime.go`，按 Provider 合同解析 |
| WorkBuddy 内置 CLI | App 包内 `cli/bin/codebuddy` JS | `internal/runtime/providercli/workbuddy_runtime.go`，用宿主 node 执行 |
| DSH harness 入口 | DSH JS entry | `internal/runtime/harnessrun/dsh_entry.go`，`AIH_SERVER_NODE_EXEC` 或 PATH node |
| 桌面 App 打开 | 解析 node 可执行文件 | `internal/transport/http/webuiopenappapi/desktop_providers.go` |
| Codex `routeOwner` 兼容值 | 旧值 `node` | `internal/runtime/codexclistartup/startup.go` 统一改写为 `go`；Go 是唯一推理承接方 |

运行态复核（2026-11-21）：

- 9527 只有 Go `aih-server` 监听；
- 项目内唯一 Node 进程是 codex app-server stdio 代理；
- 没有 Node 进程监听 HTTP 端口或承接 `/v0`、`/v1` 路由。

## 已执行删除（2026-11-21）

分两批完成，合计 **115 个文件、28,744 行**：

- 网关切片（62 个）：5 个网关入口/router、54 个 `webui-*-routes.js`、`lib/cli/app.js`，以及依赖网关启动的 `scripts/e2e-account-runtime-smoke.js`、`scripts/go-core-benchmark.js`；
- CLI 死代码切片（53 个）：`lib/cli` 中全仓库零文本引用、且不被保留参考模块依赖的命令/服务模块；
- `package.json` 移除不存在的 `main: index.js` 与 `accounts:e2e`；
- `source-fingerprint.js` 移除已删文件；
- `collect-gateway-routes` 在网关缺失时显式返回 Node 0 路由，不再靠硬编码列表制造幽灵路由；
- `contracts/routeownership` 清空 `NodeRoutes` 并重新生成投影，`node_routes=0`。

验证（最终提交 `edbc4405` 后在 `main` 复跑）：

```
gateway routes: node 0, go 71, missing 0
dangling requires: 0
product-inventory: exit 0
CLI completion audit: exit 0
node --check (lib/scripts/bin): exit 0
package.json: no main / no accounts:e2e
```

## 后续

1. 路由扫描器目前只比较 `/v1` 数据面；若需要继续审计 `/v0/webui` 别名，应补显式别名清单，而不是恢复 Node 路由扫描。
