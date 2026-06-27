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
| AWS current default `9527` sync | pass; updated allowlist file and restarted single default-port server |
| AWS current broker token env | present after restart |
| AWS current broker device routes | pair 200; descriptor/profile/nodes/status/accounts/sessions all 200 |

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

## AWS Current Verification

The same allowlist was synced to AWS current at `/home/ubuntu/aih-fabric-current` and the server was restarted on the default port only:

```text
PID: 110864
Command: node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
AIH_FABRIC_BROKER_TOKEN: present
```

Remote focused test:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:\$PATH \
   node --test test/fabric-broker-routing.test.js"
```

Result: 8/8 pass.

Remote default-port broker proxy device route smoke:

```json
{
  "ok": true,
  "pair": { "status": 200, "ok": true, "hasToken": true },
  "results": [
    { "route": "/v0/fabric/descriptor", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-profile", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-nodes", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-status", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-accounts", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-sessions", "status": 200, "ok": true }
  ]
}
```

Post-smoke process check:

```text
110864 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

No broker connect or smoke process remained. `/readyz` reports `ready=false` and zero accounts because AWS current host data was previously cleared; that does not affect this broker/device-route verification.

## Interpretation

- Browser-level Server Setup now works for Broker Proxy profiles, not just service-level profile serialization.
- The route allowlist remains narrow and follows the actual client startup contract.
- This closes the browser smoke gap for Broker Profile UI entry and confirms the same server-side allowlist on AWS current default `9527`.
- Cross-host outbound-only validation remains open because it requires a broker endpoint that is reachable by the client while the AIH server connects outbound.

## Verdict

pass

## Next Checks

- Add a reachable public broker endpoint smoke where client and server are on different hosts and both use outbound-only connectivity.
- Add multi-broker/failover evidence.
