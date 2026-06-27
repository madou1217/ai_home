# 2026-06-26 Fabric Server Endpoint Smoke

## Scope

验证 M2 Server Setup 从旧 Control Plane 命名迁移到 Fabric 配置入口的第一刀：

- Server 暴露 `/v0/fabric/descriptor`。
- Server 暴露 `/v0/fabric/device-pair`。
- 新生成的 invite URL 指向 Fabric pair endpoint 和 `/ui/server-setup`。
- 前端 profile 服务优先调用 Fabric descriptor / pairing endpoint，并复用现有 profile store。

本轮不验证跨设备真实浏览器配对，不验证 node/relay/native session。

## Changed Files

- `lib/server/fabric-descriptor.js`
- `lib/server/fabric-router.js`
- `lib/server/server.js`
- `lib/server/control-plane-device-pairing.js`
- `web/src/services/control-plane-profiles.ts`
- `test/server-node-rpc-wiring.test.js`
- `test/control-plane-device-pairing.test.js`
- `test/control-plane-profiles.test.js`

## Commands

Focused endpoint/profile tests:

```bash
node --test test/control-plane-device-pairing.test.js test/control-plane-profiles.test.js test/server-node-rpc-wiring.test.js
```

Web build:

```bash
npm run web:build
```

## Metrics

| metric | value | note |
|---|---:|---|
| Focused endpoint/profile tests | pass | 31/31 pass |
| Web build | pass | `tsc && vite build` completed |
| Fabric descriptor route | pass | live `startLocalServer` test returned `service=aih-fabric` |
| Fabric device pair route | pass | live `startLocalServer` test consumed invite and returned token |
| Invite URL shape | pass | `pairUrl=/v0/fabric/device-pair`, `webPairUrl=/ui/server-setup` |
| Legacy pair compatibility | pass | old `/v0/node-rpc/device-pair` test still consumes invite |

## Result Shape

Descriptor:

```text
GET /v0/fabric/descriptor
rpc=fabric.descriptor.read
result.service=aih-fabric
result.server.endpoint=http://127.0.0.1:<port>
result.auth.methods=["device-pair"]
```

Pairing:

```text
POST /v0/fabric/device-pair?code=<invite-code>
rpc=fabric.device.pair
result.device.id=device-ios-fabric
result.token=<device-token>
result.fabric.service=aih-fabric
```

## Interpretation

- Server Setup no longer needs to start discovery from `/v0/node-rpc/descriptor`.
- The new Fabric route is a thin adapter over the existing device pairing store, so credentials and token hashes stay in the established secure files.
- The front-end still stores profiles in the existing Control Plane profile store to avoid creating a second truth source during migration.
- Legacy `/v0/node-rpc/device-pair` remains available only for older pair links and existing mobile/control-plane flows.

## Known Gaps

- Need a real browser pairing smoke: create invite, open `webPairUrl`, auto-pair, verify ready profile, then enter workspace.
- Need a persisted Fabric registry for server/node/relay identities; current descriptor maps legacy control-plane capability summaries.
- Need WebRTC/WebTransport lab before promoting transport selection beyond WSS fallback.

## Verdict

pass
