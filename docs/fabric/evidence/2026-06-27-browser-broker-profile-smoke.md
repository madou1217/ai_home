# 2026-06-27 Browser Broker Profile Smoke

## Scope

验证 Broker Proxy 已能在真实 Server Setup 浏览器页面完成配对和进入工作台：

- 启动隔离 AIH server，开启真实 HTTP/WebSocket broker endpoint。
- 建立真实 outbound broker control link。
- 真实浏览器打开 `/ui/server-setup`。
- 页面选择 `Broker Proxy`，填写 `Broker Endpoint + Server ID`。
- 页面通过 broker proxy 消费真实 pair URL。
- 配对后 profile 持久化为 `connectionMode=broker-proxy`，并可进入 `/ui` 工作台。

本轮不验证 AWS public ingress，不验证跨主机公网 broker endpoint，不启动 native runtime session。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| Browser driver | Playwright CLI real Chromium session |
| Smoke server | `scripts/fabric-browser-broker-profile-smoke-server.js` |
| Smoke endpoint | `http://127.0.0.1:50560` |
| Broker server id | `browser-broker-mqwdmpmn` |
| Proxy base | `http://127.0.0.1:50560/v0/fabric/broker/servers/browser-broker-mqwdmpmn/proxy` |

## Commands

Syntax and focused regression:

```bash
node --check "scripts/fabric-browser-broker-profile-smoke-server.js"
node --test "test/fabric-broker-routing.test.js" "test/control-plane-profiles.test.js" "test/fabric-profile-gate.test.js"
npm --prefix web run build
```

Smoke server:

```bash
node "scripts/fabric-browser-broker-profile-smoke-server.js"
```

Observed server output:

```text
SMOKE_ENDPOINT=http://127.0.0.1:50560
SMOKE_SERVER_SETUP_URL=http://127.0.0.1:50560/ui/server-setup
SMOKE_PAIR_URL=http://127.0.0.1:50560/v0/fabric/device-pair?code=<redacted>
SMOKE_BROKER_ENDPOINT=http://127.0.0.1:50560
SMOKE_BROKER_SERVER_ID=browser-broker-mqwdmpmn
SMOKE_BROKER_PROXY_BASE=http://127.0.0.1:50560/v0/fabric/broker/servers/browser-broker-mqwdmpmn/proxy
```

Browser actions:

```bash
"/Users/model/.codex/skills/playwright/scripts/playwright_cli.sh" --session fabric-broker-smoke open "http://127.0.0.1:50560/ui/server-setup"
"/Users/model/.codex/skills/playwright/scripts/playwright_cli.sh" --session fabric-broker-smoke snapshot
# Fill Pair URL, choose Broker Proxy, fill Broker Endpoint and Server ID, then click "配对并进入".
"/Users/model/.codex/skills/playwright/scripts/playwright_cli.sh" --session fabric-broker-smoke requests
"/Users/model/.codex/skills/playwright/scripts/playwright_cli.sh" --session fabric-broker-smoke console
"/Users/model/.codex/skills/playwright/scripts/playwright_cli.sh" --session fabric-broker-smoke click <进入工作台-button-ref>
```

Direct broker descriptor check:

```bash
curl -s "http://127.0.0.1:50560/v0/fabric/broker/servers/browser-broker-mqwdmpmn/proxy/v0/fabric/descriptor"
```

## Results

| check | result |
|---|---|
| Script syntax | pass |
| Focused tests | 41/41 pass |
| Web build | pass, existing chunk warning only |
| Browser pair request | `POST /proxy/v0/fabric/device-pair` -> 200 |
| Broker descriptor refresh | `GET /proxy/v0/fabric/descriptor` -> 200 |
| Device profile refresh | `GET /proxy/v0/node-rpc/device-profile` -> 200 |
| Device nodes refresh | `GET /proxy/v0/node-rpc/device-nodes` -> 200 |
| Device status refresh | `GET /proxy/v0/node-rpc/device-status` -> 200 |
| Device accounts refresh | `GET /proxy/v0/node-rpc/device-accounts` -> 200 |
| Device sessions refresh | `GET /proxy/v0/node-rpc/device-sessions` -> 200 |
| Browser console | 0 errors, 0 warnings |
| Stored profile | `connectionMode=broker-proxy`, `state=paired`, `authState=paired`, device token present |
| Enter workspace | final URL `http://127.0.0.1:50560/ui`, not setup |

Stored profile summary:

```json
{
  "endpoint": "http://127.0.0.1:50560/v0/fabric/broker/servers/browser-broker-mqwdmpmn/proxy",
  "connectionMode": "broker-proxy",
  "serverId": "browser-broker-mqwdmpmn",
  "state": "paired",
  "authState": "paired",
  "hasDeviceToken": true,
  "nodeCount": 0,
  "accountCount": 0,
  "sessionCount": 0
}
```

Final page state:

```json
{
  "href": "http://127.0.0.1:50560/ui",
  "title": "AI Home Console",
  "setup": false,
  "hasDashboard": true,
  "profileCount": 2
}
```

## Fix Applied

The first browser run found a real product gap: pairing succeeded, but Server Setup refresh called these broker-proxied device APIs and received 403:

- `GET /v0/node-rpc/device-profile`
- `GET /v0/node-rpc/device-status`
- `GET /v0/node-rpc/device-accounts`
- `GET /v0/node-rpc/device-sessions`

The broker allowlist now includes those four device-scoped read routes. It still does not allow management APIs or `/v1/responses`.

## Interpretation

- Browser-level Server Setup now works for Broker Proxy profiles, not just service-level profile serialization.
- The route allowlist remains narrow and follows the actual client startup contract.
- This closes the local browser smoke gap for Broker Profile UI entry.
- Cross-host outbound-only validation remains open because it requires a broker endpoint that is reachable by the client while the AIH server connects outbound.

## Verdict

pass

## Next Checks

- Deploy or otherwise run this allowlist on AWS current before using AWS current as the browser-visible broker endpoint.
- Add a reachable public broker endpoint smoke where client and server are on different hosts and both use outbound-only connectivity.
- Add multi-broker/failover evidence.
