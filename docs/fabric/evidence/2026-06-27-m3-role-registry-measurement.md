# 2026-06-27 M3 Role Registry Measurement Smoke

## Scope

验证 M3 Role Registry 的一个产品闭环切片：

```text
local registry agent -> AWS current default 9527 -> fabric registry persistence -> Fabric Nodes UI
```

本轮只验证 heartbeat 写入 relay measurement、server 持久化 measurement、Web UI 读取并展示 measurement。M3 的 home/company 双节点、长期 daemon 和多 relay health 仍未完成。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS endpoint | `http://43.207.102.163:9527` |
| AWS host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |
| AWS server pid | `113275` |
| Node id | `local-mac-remote-node` |
| Token source | `/Users/model/.ai_home/fabric/local-mac-remote-node.token` |

## Commands

Focused code checks:

```bash
node --test "test/fabric-registry-agent.test.js" \
  "test/fabric-registry-heartbeat.test.js" \
  "test/fabric-role-registry.test.js" \
  "test/fabric-registry-client.test.js"

node --check "lib/server/fabric-role-registry.js" \
  "lib/cli/services/fabric/registry-agent.js" \
  "lib/cli/services/fabric/registry-heartbeat.js"

npm --prefix "web" run build
```

AWS current focused tests after sync:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   .node-runtime/node-v22.16.0-linux-x64/bin/node --test \
   test/fabric-registry-agent.test.js \
   test/fabric-registry-heartbeat.test.js \
   test/fabric-role-registry.test.js \
   test/fabric-registry-client.test.js"
```

Deploy the current Fabric registry server slice and Web build to AWS current default `9527`:

```bash
scp -i "/Users/model/.ssh/aws.pem" \
  "lib/server/fabric-role-registry.js" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current/lib/server/fabric-role-registry.js"

scp -i "/Users/model/.ssh/aws.pem" -r "web/dist/"* \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current/web/dist/"
```

Restart AWS current using the bundled Node runtime, still on default `9527`:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
   AIH_FABRIC_BROKER_TOKEN=\$(cat .broker-token) \
   nohup .node-runtime/node-v22.16.0-linux-x64/bin/node \
   bin/ai-home.js server serve --host 0.0.0.0 --port 9527 \
   > fabric-server.log 2>&1 &"
```

Run a real local registry agent heartbeat to AWS current:

```bash
node "bin/ai-home.js" fabric registry agent \
  "http://43.207.102.163:9527" \
  --node-id "local-mac-remote-node" \
  --token-file "/Users/model/.ai_home/fabric/local-mac-remote-node.token" \
  --status online \
  --relay-status online \
  --transport relay=online \
  --probe-transport "relay=http://43.207.102.163:9527/readyz" \
  --probe-method GET \
  --probe-timeout-ms 10000 \
  --count 1 \
  --json
```

Read registry back through the real AWS API:

```bash
TOKEN="$(tr -d '\n' < "/Users/model/.ai_home/fabric/local-mac-remote-node.token")"
curl --noproxy "*" --max-time 10 -s -S \
  -H "Authorization: Bearer ${TOKEN}" \
  "http://43.207.102.163:9527/v0/fabric/registry"
```

Browser smoke:

```text
Playwright Chromium opened http://43.207.102.163:9527/ui/fabric/nodes
Injected a paired server profile into localStorage for the real AWS endpoint.
Waited for local-mac-remote-node and reachable text.
Screenshot: /tmp/aih-m3-fabric-nodes.png
```

## Results

| check | result |
|---|---|
| Focused registry tests | 21/21 pass |
| AWS current focused registry tests | 21/21 pass |
| Syntax check | pass |
| Web build | pass; only existing Vite chunk-size warning |
| AWS default `readyz` after restart | HTTP 200 |
| AWS server pid | `113275 ... server serve --host 0.0.0.0 --port 9527` |
| Dist hash check | local/remote `index.html`, `FabricNodes-BsiSfZ7S.js`, `FabricNodes-iwU9Fh1j.css` match |
| Real registry agent | `ok=true`, `attempts=1`, `failures=0` |
| Registry readback | `counts={nodes:1, relayNodes:1, transports:1, projects:1, runtimes:4}` |
| Measurement persistence | relay transport has `measurement.status=reachable`, `durationMs=238` |
| Browser UI smoke | HTTP 200, node visible, Relay Health visible, measurement visible, online visible |
| Browser console | 0 errors, 0 warnings |

Sanitized registry readback:

```json
{
  "ok": true,
  "counts": {
    "nodes": 1,
    "relayNodes": 1,
    "transports": 1,
    "projects": 1,
    "runtimes": 4
  },
  "relayHealth": "online",
  "measurement": {
    "status": "reachable",
    "durationMs": 238,
    "successes": 0,
    "failures": 0,
    "measuredAt": 1782568804909
  }
}
```

Browser smoke result:

```json
{
  "ok": true,
  "status": 200,
  "url": "http://43.207.102.163:9527/ui/fabric/nodes",
  "hasNode": true,
  "hasRelayHealth": true,
  "hasMeasurement": true,
  "hasOnline": true,
  "consoleErrors": 0,
  "consoleWarnings": 0
}
```

## Interpretation

- Role Registry now persists relay measurement summaries from real heartbeat probes.
- Fabric Nodes UI reads the same registry and displays measured relay health instead of treating `online` as pending.
- AWS current remains on default `9527`; no old VPS targets were touched.
- This is not the full M3 completion because it still covers one real node and one real relay path, not separate home/company nodes with long-running daemon evidence.

## Verdict

partial

M3 Role Registry now has a verified measurement and UI slice. The remaining M3 gates are multi-node role evidence, supervised daemon heartbeat, and stronger relay health measurements.

## Next Checks

- Verify supervised `node service install --yes` or a safe service-mode equivalent for registry agent + relay on AWS/current node without leaking token in argv.
- Add a second real node role, then show both home/company style nodes in Fabric Nodes.
- Write p95 RTT or echo-derived measurement into registry or `network_measurements` instead of only HTTP reachability duration.
