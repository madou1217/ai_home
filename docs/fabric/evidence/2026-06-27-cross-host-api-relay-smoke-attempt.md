# 2026-06-27 Cross-host API Relay Smoke Attempt

## Scope

Validate the next step after the AWS single-host relay proof: a node process on the local Mac should be able to register to the AWS Control Plane through real node join / device pair APIs, then connect back over the relay path.

This pass does not use mock data. It does not create a new AIH server port. It uses the existing AWS default `9527` server.

## Environment

| item | value |
|---|---|
| local cwd | `/Users/model/projects/feature/ai_home` |
| local node host-home for relay child | `/tmp/aih-cross-api-host-home` |
| AWS host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS server dir | `/home/ubuntu/aih-fabric-current` |
| AWS server endpoint | `http://43.207.102.163:9527` |
| AWS internal endpoint | `http://127.0.0.1:9527` |

No systemd unit was installed. No firewall, security group, package manager, or production API configuration was changed.

## Implementation Change

`scripts/fabric-real-outbound-relay-smoke.js` now supports cross-host endpoint preparation:

```text
--node-join-url <url>
--device-pair-url <url>
```

When both are provided with `--endpoint`, the smoke tool prepares the node/device through real HTTP APIs:

1. `POST /v0/node-rpc/join?code=...`
2. `POST /v0/fabric/device-pair?code=...`

The old endpoint mode is preserved. If the new URLs are omitted, the script still uses the filesystem setup path for same-host default-port verification.

## Commands

Generate real node and device invites on the AWS host:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  -o IdentityAgent=none \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=accept-new \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:\$PATH && \
   export AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home && \
   node --input-type=commonjs <invite-generator>"
```

Run local-to-AWS API endpoint smoke with redacted invite URLs:

```bash
node "scripts/fabric-real-outbound-relay-smoke.js" \
  --endpoint "http://43.207.102.163:9527" \
  --host-home "/tmp/aih-cross-api-host-home" \
  --node-id "local-api-cross-<redacted>" \
  --node-join-url "http://43.207.102.163:9527/v0/node-rpc/join?code=<redacted>" \
  --device-pair-url "http://43.207.102.163:9527/v0/fabric/device-pair?code=<redacted>" \
  --timeout-ms 15000
```

AWS post-check:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  -o IdentityAgent=none \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=accept-new \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "curl -sS --max-time 5 http://127.0.0.1:9527/readyz && \
   ps -eo pid,cmd | grep -E 'ai-home.js server serve|ai-home.js node relay|codex.aih-original|x86_64-unknown-linux-musl/bin/codex|--port 9528|--port 9527' | grep -v grep || true"
```

## Results

Local-to-AWS API endpoint smoke result:

```json
{
  "ok": false,
  "mode": "existing-endpoint-relay",
  "error": "node_join_request_failed",
  "message": "node_join_request_failed:The operation was aborted due to timeout",
  "phase": "node_join",
  "preparation": {
    "mode": "api"
  },
  "control": {
    "endpoint": "http://43.207.102.163:9527"
  },
  "sessions": null,
  "children": []
}
```

AWS internal health after the failed public attempt:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": true,
  "accounts": {
    "codex": 3,
    "gemini": 1,
    "claude": 4,
    "agy": 7,
    "opencode": 0
  }
}
```

AWS process check:

```text
77912 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

No local relay child stayed running because the smoke failed before relay startup. No AWS Codex/relay residual process was found.

## Metrics

| metric | value | note |
|---|---:|---|
| AWS internal `/readyz` | pass | `127.0.0.1:9527` |
| local -> AWS public node join API | fail | timeout before HTTP response |
| failure phase | `node_join` | before device pair and relay startup |
| new AIH server ports | 0 | only existing AWS `9527` used |
| AWS residual relay/Codex processes | 0 | only server process remained |

## Interpretation

- The smoke tool now has the correct cross-host preparation path: it can use real node join and device pair APIs instead of direct host-home writes.
- The actual local Mac -> AWS public `9527` control URL still fails before node join completes.
- This confirms the current blocker for true cross-host node attachment is the public HTTP ingress path to AWS, not the native session cleanup logic proven in the previous AWS same-host relay smoke.
- A local SSH tunnel would likely bypass the ingress issue, but that would be SSH-assisted evidence, not the desired default product path. This pass intentionally did not create a tunnel or use another port.

## Verdict

Partial.

The implementation now supports API-based cross-host smoke preparation and is covered by tests. The real cross-host attempt did not pass because the public AWS Control Plane URL timed out at `node_join`.

## Next Checks

1. Decide whether the next product default remains outbound relay with a reachable server endpoint, or whether the server itself also needs an outbound registration path to a separate public broker.
2. If using AWS as the public broker, fix or explicitly configure HTTP ingress for `9527`/TLS reverse proxy, then repeat this same API-mode smoke.
3. If raw ingress remains disallowed, add a broker/relay endpoint on an actually reachable URL and keep AIH node traffic outbound-only.
