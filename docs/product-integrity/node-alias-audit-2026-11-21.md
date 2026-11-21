# Node 兼容别名与遗留网关审计（2026-11-21）

## 结论

当前不存在第二套 Node HTTP 网关。旧 Node 网关代码仍留在源码树里，但没有任何产品入口能启动它：
`bin/aih` 直接 exec Go CLI，launchd 运行 Go `aih-server`，`package.json` 的 `main: index.js` 指向不存在的文件，也没有启动 Node server 的 npm script。

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

## 遗留 Node 网关文件

以下文件只被旧 Node CLI/server 入口互相引用，产品入口不可达：

- `lib/server/server.js`（2,127 行）
- `lib/server/entry.js`（105 行）
- `lib/server/v1-router.js`（2,489 行）
- `lib/server/web-ui-router.js`（1,559 行）
- `lib/server/management-router.js`（289 行）
- `lib/cli/app.js`（766 行，无入口 require）
- `lib/server/webui-*-routes.js`（54 个文件，10,690 行）

合计约 **18,000 行** 不可达网关代码。保留它们不会产生双 owner，但会让路由扫描和迁移审计持续把它们当成有效路由面。

## 仍存活的 Node 宿主能力

这些不是 HTTP 网关，属于合同允许的宿主/插件能力：

- `lib/server/codex-app-server-stdio-proxy.js`（当前有真实进程，stdio 代理）
- `lib/plugins/transport/rpc-server.js`（插件 Unix socket RPC）
- `lib/server/codex-remote-control-proxy.js` / `oauth-loopback-callback.js`（按宿主调用启动）
- `lib/server/*` 中被 Go 宿主或脚本直接 require 的纯 helper

## 已执行删除（2026-11-21）

- 删除 62 个文件：5 个网关入口/router、54 个 `webui-*-routes.js`、`lib/cli/app.js`，以及依赖网关启动的 `scripts/e2e-account-runtime-smoke.js`、`scripts/go-core-benchmark.js`；
- `package.json` 移除不存在的 `main: index.js` 与 `accounts:e2e`；
- `source-fingerprint.js` 移除已删文件；
- `collect-gateway-routes` 在网关缺失时显式返回 Node 0 路由，不再靠硬编码列表制造幽灵路由；
- `contracts/routeownership` 清空 `NodeRoutes` 并重新生成投影，`node_routes=0`。

验证：

```
gateway routes: node 0, go 71, missing 0
route-ownership --check: pass
product-inventory: exit 0
package.json: no main / no accounts:e2e
```

## 后续

1. `lib/cli` 仍有大量已无入口的 Node 命令/服务模块；它们不拥有 HTTP 路由，可另做一次死代码切片。
2. 路由扫描器目前只比较 `/v1` 数据面；若需要继续审计 `/v0/webui` 别名，应补显式别名清单，而不是恢复 Node 路由扫描。
