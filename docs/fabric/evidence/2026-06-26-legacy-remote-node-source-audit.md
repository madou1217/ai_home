# 2026-06-26 Legacy Remote Node Source Audit

## Scope

只读审计当前 `ai_home` 中 Control Plane、remote node、relay 相关源码，判断哪些能力可复用到 AIH Fabric，哪些边界不应继续扩张。本次未修改运行配置，未启动远端服务。

## Environment

- Local cwd: `/Users/model/projects/feature/ai_home`
- Date: 2026-06-26
- Local shell: zsh

## Commands

```bash
rg -n "Control Plane|remote node|relay|OpenMPTCPRouter|MPTCP|fabric" "lib" "test" "README.md" "AGENTS.md"
sed -n '389,530p' "README.md"
sed -n '1,260p' "lib/cli/commands/node-router.js"
sed -n '1,260p' "lib/server/remote/remote-gateway.js"
sed -n '1,260p' "lib/server/remote/relay-server.js"
sed -n '1,260p' "lib/cli/services/node/relay-client.js"
sed -n '1,260p' "test/web-ui-router.remote-nodes.test.js"
```

## Results

| Area | Evidence | Interpretation |
|---|---|---|
| README remote topology | Documents Control Plane, Node, Device client, hub-and-spoke relay | Current user-facing model is centralized and Control Plane-first |
| `node-router` | Exposes join, doctor, bootstrap, relay connect/service | Useful onboarding and relay operations already exist |
| `relay-client` | Implements outbound WSS relay, heartbeat, route allowlist, stream window | Good WSS baseline for Transport Lab |
| `relay-server` | Authorizes relay node, registers relay session, proxies request/stream | Can be reused as Fabric WSS relay fallback |
| `remote-gateway` | Selects transport, sends management requests, appends audit | Reusable gateway pattern, but must map into Fabric session/protocol |
| remote node tests | Cover relay defaults, OMR/MPTCP as underlay, hidden secrets, route allowlist | Existing safety tests should be preserved during migration |

## Interpretation

- Existing remote node work is not useless, but it is not yet the final product shape requested by the user.
- The current shape is hub-and-spoke Control Plane; Fabric requires explicit server profiles and role-capable AIH instances.
- `/test` and remote management status prove only management reachability; they do not prove native Codex/Claude/AGY/OpenCode session usability.
- OMR/MPTCP is already treated as underlay in current tests and docs; Fabric should keep that boundary.

## Verdict

partial

## Next Checks

- Run WSS echo/relay baseline on `39.104.59.31`.
- Add Fabric metrics around existing relay connect before changing routing behavior.
- Start M2 server profile first only after M1 baseline evidence is recorded.
