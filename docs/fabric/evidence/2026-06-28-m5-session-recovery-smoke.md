# 2026-06-28 M5 Session Recovery Smoke

## Scope

验证 M5 Recovery 的当前默认路线：

- 只使用 AWS current 默认 `9527` 作为公网 broker endpoint。
- 本机 AIH server/runtime 不需要公网入口，通过 outbound broker link 暴露给 client。
- 同一个远程开发 session 在 broker link 中断后可用 cursor 恢复。
- 同一个远程开发 session 在 relay client 中断后可用 cursor 恢复。
- 失败窗口有可诊断响应和 JSON diagnostics export。

## Environment

| item | value |
|---|---|
| Date | 2026-06-28 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS broker endpoint | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` |
| AWS host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| Local server endpoint | `http://127.0.0.1:9527` |
| Native runtime | `codex account 1`, `model=gpt-5.5` |
| Session project | `/Users/model/projects/feature/ai_home` |

## AWS Current Correction

Before the recovery smoke, broker connect returned HTTP 401 because the running AWS server process had:

- `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current`
- no `AIH_FABRIC_BROKER_TOKEN`
- no server config in the active host home

The server was restarted on the same default `9527` listener with:

- `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`
- `AIH_FABRIC_BROKER_TOKEN="$(cat /home/ubuntu/aih-fabric-current/.broker-token)"`

No new port was opened. After restart, AWS `/readyz` remained HTTP 200 with `ready=false` and provider account counts all `0`, which is expected because AWS is the broker/control/relay-capable node, not the provider runtime host.

## Commands

Focused local regression:

```bash
node --check scripts/fabric-real-session-recovery-smoke.js
node --test \
  test/fabric-real-session-recovery-smoke.test.js \
  test/fabric-real-broker-diagnostics-smoke.test.js \
  test/fabric-real-broker-relay-smoke.test.js \
  test/fabric-real-outbound-relay-smoke.test.js \
  test/node-rpc-router.test.js \
  test/fabric-broker-routing.test.js
```

Broker interruption smoke:

```bash
AIH_FABRIC_BROKER_TOKEN="$(ssh -i "$HOME/.ssh/aws.pem" \
  ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  "cat /home/ubuntu/aih-fabric-current/.broker-token")" \
node scripts/fabric-real-session-recovery-smoke.js \
  --broker-endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --local-url http://127.0.0.1:9527 \
  --server-id m5-recovery-broker \
  --node-id m5-recovery-broker-node \
  --host-home "$HOME" \
  --interrupt broker \
  --diagnostics-file /tmp/aih-m5-recovery-broker-rerun.json \
  --session-provider codex \
  --session-account 1 \
  --session-model gpt-5.5 \
  --session-project /Users/model/projects/feature/ai_home \
  --timeout-ms 30000 \
  --session-timeout-ms 120000
```

Relay interruption smoke:

```bash
AIH_FABRIC_BROKER_TOKEN="$(ssh -i "$HOME/.ssh/aws.pem" \
  ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  "cat /home/ubuntu/aih-fabric-current/.broker-token")" \
node scripts/fabric-real-session-recovery-smoke.js \
  --broker-endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --local-url http://127.0.0.1:9527 \
  --server-id m5-recovery-relay \
  --node-id m5-recovery-relay-node \
  --host-home "$HOME" \
  --interrupt relay \
  --diagnostics-file /tmp/aih-m5-recovery-relay-rerun.json \
  --session-provider codex \
  --session-account 1 \
  --session-model gpt-5.5 \
  --session-project /Users/model/projects/feature/ai_home \
  --timeout-ms 30000 \
  --session-timeout-ms 120000
```

Residual checks:

```bash
ps -axo pid,command | rg "[m]5-recovery|[n]ode relay connect|[f]abric-real-session-recovery|[f]abric broker connect"

ssh -i "$HOME/.ssh/aws.pem" ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  "ps -eo pid,args | grep -E 'm5-recovery|fabric-real-session-recovery|fabric broker connect|node relay connect' | grep -v grep || true"
```

## Results

| check | result |
|---|---|
| Script syntax | pass |
| Focused regression | 82/82 pass |
| Broker interruption smoke | `ok=true` |
| Broker offline diagnostic | HTTP 503, `fabric_broker_server_offline` |
| Broker recovery | reconnect with same `serverId`, proxy `readyz` HTTP 200 |
| Broker session resume | attach HTTP 200, message HTTP 200, ack before/after HTTP 200 |
| Broker cursor recovery | `235 -> 516`, duplicate events `0` |
| Relay interruption smoke | `ok=true` |
| Relay offline diagnostic | node status `offline`, offline attach HTTP 503 `remote_transport_unavailable` |
| Relay recovery | relay online again with `transportKind=relay` |
| Relay session resume | attach HTTP 200, message HTTP 200, ack before/after HTTP 200 |
| Relay cursor recovery | `209 -> 398`, duplicate events `0` |
| Cleanup | no M5 smoke/broker/temp relay residual process locally or on AWS; only existing long-running `local-mac-remote-node` and `aws-current-node` relay services remained |

Broker diagnostics summary:

```json
{
  "ok": true,
  "interrupt": "broker",
  "serverId": "m5-recovery-broker",
  "nodeId": "m5-recovery-broker-node",
  "before": 235,
  "final": 516,
  "duplicate": 0,
  "attach": 200,
  "message": 200,
  "ackBefore": 200,
  "ackAfter": 200,
  "stop": 200,
  "offline": {
    "status": 503,
    "error": "fabric_broker_server_offline"
  },
  "recovered": {
    "status": 200,
    "ready": true
  }
}
```

Relay diagnostics summary:

```json
{
  "ok": true,
  "interrupt": "relay",
  "serverId": "m5-recovery-relay",
  "nodeId": "m5-recovery-relay-node",
  "before": 209,
  "final": 398,
  "duplicate": 0,
  "attach": 200,
  "message": 200,
  "ackBefore": 200,
  "ackAfter": 200,
  "stop": 200,
  "offline": {
    "status": 200,
    "nodeStatus": "offline"
  },
  "offlineAttach": {
    "status": 503,
    "error": "remote_transport_unavailable"
  },
  "recovered": {
    "online": true,
    "transportKind": "relay"
  }
}
```

Post-cleanup broker proxy status for both M5 `serverId`s returned `fabric_broker_server_offline` with `lastDisconnected`, which is expected after the smoke closes its outbound broker handles.

## Interpretation

- M5 recovery does not require opening another product port.
- The same event cursor model covers both client-to-server broker interruption and server-to-node relay interruption.
- `device-node-session-ack` is the resume checkpoint before and after the interruption.
- Diagnostics export is now a repeatable runtime gate via `--diagnostics-file`.
- AWS still lacks provider runtime/account by design in this topology; the actual Codex runtime was local.

## Verdict

pass

M5 single-broker recovery and relay reconnect recovery are verified against AWS current default `9527` with a real Codex session and no mock data.
