# 2026-06-30 Transport Readiness Blocker Canonicalization

Goal: remove a remaining product ambiguity where transport readiness/status
still exposed the same WebTransport prerequisite as
`webtransport_endpoint_not_configured` and `webtransport_not_promoted`, while
closure handoff already used `webtransport_h3_endpoint_missing`.

Only AWS current was used:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- ssh: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: `9527`

## Product Change

`lib/server/fabric-transport-readiness.js` now canonicalizes WebTransport
readiness blockers:

- `webtransport_endpoint_not_configured`
- `webtransport_not_promoted`
- `missing_endpoint`

into:

```text
webtransport_h3_endpoint_missing
```

If a WebTransport candidate also carries a low-level error such as
`webtransport_connect_failed`, that evidence is preserved alongside the
canonical product blocker.

This keeps the selector's internal rejection reason unchanged and only
normalizes the product-facing readiness surface.

## AWS Deployment

Scoped files synced to AWS current:

- `lib/server/fabric-transport-readiness.js`
- `test/fabric-transport-readiness.test.js`
- `test/fabric-real-transport-readiness-client-smoke.test.js`

The AWS server process was restarted on the same default port:

- old server PID: `487271`
- new server PID: `536155`
- command: `bin/ai-home.js server serve --host 0.0.0.0 --port 9527`
- `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`
- `/readyz`: `ok=true`, `ready=true`

No new product port was opened.

## Real AWS Readiness

Command:

```bash
node "bin/ai-home.js" fabric transport readiness \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --json
```

Result:

- `ok=true`
- `summary.defaultTransport=webrtc`
- `summary.fallbackReady=true`
- `summary.promotionReady=true`
- `summary.promotedTransports=["webrtc"]`
- `summary.blockers` contains:
  - `webtransport:webtransport_h3_endpoint_missing`
  - `omr:openmptcprouter_not_detected`
  - `mptcp:mptcp_data_plane_not_promoted`
- `summary.blockers` no longer contains:
  - `webtransport:webtransport_endpoint_not_configured`
  - `webtransport:webtransport_not_promoted`

## Real AWS Status

Command:

```bash
node "bin/ai-home.js" fabric transport status \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --json
```

Result:

- `ok=true`
- `summary.status=complete`
- `summary.remoteDevelopmentReady=true`
- `summary.defaultTransport=webrtc`
- `summary.advancedPromotionReady=true`
- `summary.cloudEdgeReady=false`
- `summary.udpReachable=false`
- `summary.packetArrivalCaptured=false`
- `summary.hostFirewallBlocksUdp=false`
- `summary.blockers` contains:
  - `webtransport:webtransport_h3_endpoint_missing`
  - `turn_default_udp_9527_unreachable`
  - `aws_public_udp_path_blocked`
  - `aws_cli_missing`
  - `aws_iam_role_missing`
  - `aws_local_cli_missing`
  - `omr:openmptcprouter_not_detected`
  - `mptcp:mptcp_data_plane_not_promoted`

## Business Closure and Stream Proof

Command:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-readiness-canonical-20260630.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-readiness-canonical-20260630.json" \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- `workflow=closure_verify`
- `summary.status=usable_with_blockers`
- `summary.selectedTransportKind=webrtc`
- `summary.fallbackUsed=false`
- `conclusion.businessClosureProven=true`
- `conclusion.streamProofProven=true`
- run: `63a9a745-86ea-45e3-80d9-e38c2ffb0e17`
- session: `ses_0eae9e0b6ffe7rzwpZDMncUBxy`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_203315`
- events: `ready`, `session-created`, `delta`, `result`, `done`
- `failureLedger.executionDecision.decision=stop_awaiting_external_input`
- `failureLedger.summary.total=7`
- `failureLedger.summary.external=7`
- `failureLedger.summary.actionableByAih=0`

The handoff now has one WebTransport blocker name:

```text
webtransport:webtransport_h3_endpoint_missing
```

## Verification

Local:

```bash
node --check "lib/server/fabric-transport-readiness.js"
node --test \
  "test/fabric-transport-readiness.test.js" \
  "test/fabric-real-transport-readiness-client-smoke.test.js" \
  "test/fabric-transport-status.test.js" \
  "test/fabric-closure-audit.test.js"
```

Result:

- syntax check: pass
- focused tests: `31/31 pass`

AWS current:

```bash
ssh -i "${HOME}/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --test /home/ubuntu/aih-fabric-current/test/fabric-transport-readiness.test.js /home/ubuntu/aih-fabric-current/test/fabric-real-transport-readiness-client-smoke.test.js"
```

Result:

- focused tests: `9/9 pass`

## Failure Ledger

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| Transport readiness/status still displayed old WebTransport blocker names. | The canonicalization existed in closure planning, but not in the readiness truth source. | Normalize WebTransport readiness blockers at the server readiness output layer. | Product-facing transport surfaces now use `webtransport_h3_endpoint_missing` as the single actionable prerequisite. |
| AWS PID files did not identify the live server process. | `RUNNING_SERVER_PID` and `server.pid` were stale while PID `487271` was serving `9527`. | Restarted the actual live server process and rewrote both PID files to `536155`. | Verify the live process with `ps` before future restarts; do not trust stale PID files alone. |

## Next Action

No internal AIH runnable work was created by this change. The current remaining
work is still external:

1. Prove AWS UDP `9527` through SG/NACL or provide a controlled TURN/UDP path.
2. Configure a real HTTPS/H3 WebTransport endpoint.
3. Provide real dual-ended OpenMPTCPRouter/MPTCP underlay evidence.
4. Repair AWS Codex/Claude/AGY provider credentials.
