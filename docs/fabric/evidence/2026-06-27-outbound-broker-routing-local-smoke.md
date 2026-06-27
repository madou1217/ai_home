# 2026-06-27 Outbound Broker Routing Local Smoke

## Scope

验证 AIH Fabric 在 direct public ingress 不可靠时的下一条默认路线：AIH Server 主动 outbound 连接 broker，client 通过 broker proxy base 访问 server API。

本证据不证明跨主机公网 broker 已可用；它证明本轮实现的 broker protocol、allowlist、proxy、CLI router 在真实本机 HTTP/WebSocket socket 上可闭环。

## Environment

- Repo: `/Users/model/projects/feature/ai_home`
- Date: 2026-06-27
- Runtime: local Node.js test runner
- Product default port policy: broker 功能复用 `aih server` 的现有 HTTP/WSS listener，不引入新的产品端口。
- Local default server `127.0.0.1:9527` 状态：已有真实 AIH server 运行，`/readyz` 返回 `ready=true`，账号池为 `codex=2, gemini=1, claude=2, agy=7, opencode=1`。

## Commands

```bash
node --check lib/server/fabric-broker-session-registry.js
node --check lib/server/fabric-broker-router.js
node --check lib/cli/services/fabric/broker-connect.js
node --check lib/cli/commands/fabric-router.js
node --check scripts/fabric-real-broker-smoke.js
node --test test/fabric-broker-routing.test.js
node --test test/fabric-broker-routing.test.js test/fabric-transport-echo.test.js test/fabric-registry-publish.test.js test/server-node-rpc-wiring.test.js test/root.router.test.js test/help.messages.test.js
curl -s --noproxy '*' --max-time 5 http://127.0.0.1:9527/readyz
AIH_FABRIC_BROKER_TOKEN='<redacted-management-key>' node scripts/fabric-real-broker-smoke.js --endpoint http://127.0.0.1:9527 --server-id local-default --skip-pair
```

## Metrics

| metric | value | note |
|---|---:|---|
| broker unit/e2e tests | 6/6 pass | Includes real local HTTP server + real WebSocket broker control link |
| related regression tests | 53/53 pass | Fabric broker, registry, transport echo, node-rpc wiring, root/help |
| broker e2e duration | 55.013ms | `broker connect proxies real HTTP requests over real WebSocket sockets` |
| static checks | 5/5 pass | New broker modules, CLI router, real broker smoke script |
| default 9527 local readyz | pass | Existing installed server is healthy |
| default 9527 broker self-loop | fail: 404 at broker_connect | Existing installed server process does not yet include this broker upgrade path |

## Results

- `test/fabric-broker-routing.test.js` starts a real local server endpoint and a real broker HTTP server.
- `connectFabricBroker()` opens a real WebSocket outbound link to `/v0/fabric/broker/control?serverId=home-server`.
- Client-side HTTP requests to `/v0/fabric/broker/servers/home-server/proxy/readyz`, `/v0/fabric/descriptor`, `/v0/fabric/device-pair`, and `/v0/node-rpc/device-node-session-start` are forwarded over the WebSocket frame path and executed against the local server.
- Authorization and JSON body forwarding are verified:
  - descriptor request preserves `Authorization: Bearer device-token`;
  - device pair POST body is forwarded as `{"code":"pair-code"}`.
  - session-start POST preserves `Authorization: Bearer session-device-token` and forwards the requested `nodeId/provider/accountId/projectPath`.
- Route allowlist rejects non-MVP routes such as `/v0/management/accounts`, `/v1/responses`, and unsupported methods.
- Added `scripts/fabric-real-broker-smoke.js` as the repeatable runtime gate. It does not start a server or allocate a port; it connects to an already-running endpoint and verifies that endpoint through broker proxy.
- Current local default server self-loop returned structured failure:
  ```json
  {
    "ok": false,
    "error": "Unexpected server response: 404",
    "phase": "broker_connect"
  }
  ```
  The already-running `/opt/homebrew/bin/aih server serve` process predates this broker implementation. This is not a broker protocol failure in the current worktree.

## Interpretation

本轮已经把 direct public ingress 失败后的产品路线从文档推进到可运行切片：

- Broker 是薄路由，只维护 online server link 和转发 allowlist route。
- Server 通过 outbound WebSocket 注册，不要求自身公网可达。
- Client 可以把 broker proxy base 当作 server profile endpoint。
- 默认产品端口不增加；broker endpoint 复用 `aih server` listener。

后续 AWS current 默认端口已完成 broker proxy -> outbound relay -> real Codex remote session smoke，见 `2026-06-27-outbound-broker-relay-aws-smoke.md`。AWS `43.207.102.163:9527` 公网 HTTP 仍不可作为 client public ingress 依赖；本轮不继续卡在这个已确认限制上。

## Verdict

partial

协议和本机真实 socket 实现通过；跨主机 broker endpoint 与 remote session over broker 仍待可达 broker 环境验证。

## Next Checks

- Broker proxy 后接现有 node relay、执行 `device-node-session-start` native Codex smoke 已在 AWS current 通过；详见 `2026-06-27-outbound-broker-relay-aws-smoke.md`。
- 下一步将 broker proxy endpoint 接入 Server Profile/WebUI 配置流程。
- 增加 broker link reconnect、ack/resume、multi-broker failover。
