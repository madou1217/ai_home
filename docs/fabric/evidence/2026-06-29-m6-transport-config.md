# 2026-06-29 M6 transport config

## Scope

Productize a persistent config source for M6 external transport probe inputs:

- `aih fabric transport config show|set|clear`
- `aih fabric transport prerequisites` reads stored config before running the real audit.
- `aih fabric transport promotion-gate` reads stored config before running the real gate.
- Explicit CLI args and environment variables keep priority over stored config.
- Config can provide TURN/WebTransport inputs only; it cannot mark TURN/WebTransport/MPTCP ready.

No provider credentials were imported to AWS. No old VPS targets were touched. Default port stayed `9527`.

## Local code checks

```bash
node --check lib/cli/services/fabric/transport-config.js
node --check lib/cli/services/fabric/transport-prerequisites.js
node --check lib/cli/services/fabric/transport-promotion-gate.js
node --check scripts/fabric-m6-promotion-gate.js
node --check lib/cli/commands/fabric-router.js
```

Result: pass.

## Focused tests

```bash
node --test \
  test/fabric-transport-config.test.js \
  test/fabric-transport-prerequisites.test.js \
  test/fabric-transport-promotion-gate.test.js
```

Result: 11/11 pass.

Coverage:

- config set/show/clear redacts TURN credential.
- prerequisites receives config values without overriding explicit CLI flags.
- promotion-gate receives configured WebTransport URL/page URL.
- router routes `fabric transport config`.
- env values stay ahead of stored config.

## Full local tests

```bash
npm test
```

Result: 2697/2697 pass.

## Real local config read/write/cleanup

Initial real local state:

```bash
node bin/ai-home.js fabric transport config show --json
```

Result:

```json
{
  "ok": true,
  "config": {
    "turn": { "configured": false, "credentialPresent": false },
    "webtransport": { "configured": false },
    "updatedAt": 0
  }
}
```

Temporary real AWS WebTransport candidate config:

```bash
node bin/ai-home.js fabric transport config set \
  --webtransport-url "https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport" \
  --webtransport-page-url "https://example.com/" \
  --json
```

Result: `webtransport.configured=true`. No TURN credential was written.

Real prerequisite audit with stored config applied:

```bash
node bin/ai-home.js fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --timeout-ms 30000 \
  --browser-channel chrome \
  --json
```

Key result:

```json
{
  "summary": {
    "baseReady": true,
    "promotionReady": false,
    "readyTransports": [],
    "blockers": [
      "turn:turn_ice_server_not_configured",
      "webtransport:webtransport_connect_failed",
      "multipath:local_mptcp_unavailable",
      "multipath:openmptcprouter_not_detected",
      "multipath:default_listener_is_plain_http_not_multipath_transport"
    ]
  },
  "transportConfig": {
    "present": true,
    "applied": ["webtransport.url", "webtransport.pageUrl"]
  }
}
```

Cleanup:

```bash
node bin/ai-home.js fabric transport config clear --all --json
node bin/ai-home.js fabric transport config show --json
```

Final real local state:

```json
{
  "ok": true,
  "config": {
    "turn": { "configured": false, "credentialPresent": false },
    "webtransport": { "configured": false },
    "updatedAt": 0
  }
}
```

## Real AWS current empty-config regression

```bash
node bin/ai-home.js fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --timeout-ms 30000 \
  --browser-channel chrome \
  --json
```

Result:

- `transportConfig.present=false`
- `transportConfig.applied=[]`
- `baseReady=true`
- `promotionReady=false`
- `readyTransports=[]`

```bash
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --sample-count 2 \
  --rpc-sample-count 2 \
  --relay-count 5 \
  --timeout-ms 30000 \
  --browser-channel chrome \
  --json
```

Result:

- relay `5/5`, p95 `109ms`
- WebRTC DataChannel candidate ready, p95 `201.1ms`
- WebRTC RPC ok, p95 `202ms`
- `defaultTransport=relay`
- `promotionReady=false`
- blockers remain real external prerequisites: TURN relay, WebTransport connect, local MPTCP/OMR/default listener.

## AWS current deploy and focused remote tests

Scoped artifact built from clean `HEAD` plus only this transport-config change set:

```bash
/tmp/aih-fabric-transport-config.tar.gz
```

sha256:

```text
7cc94df2a9a9547ade9b23f2ceccd917a42ca45bb94608363bebd775e0ef5d92
```

Uploaded to:

```text
/home/ubuntu/aih-fabric-current/source-transport-config.tar.gz
```

Remote command:

```bash
cd /home/ubuntu/aih-fabric-current
tar -xzf source-transport-config.tar.gz
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/transport-config.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check scripts/fabric-m6-promotion-gate.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --test \
  test/fabric-transport-config.test.js \
  test/fabric-transport-prerequisites.test.js \
  test/fabric-transport-promotion-gate.test.js
```

Result: 11/11 pass.

Notes:

- AWS tar extraction printed macOS xattr warnings only; extraction and tests succeeded.
- AWS default `9527` server was not moved to another port.
- Advanced transport default remains blocked until real TURN, HTTPS/H3 WebTransport, or OMR/MPTCP underlay exists.
