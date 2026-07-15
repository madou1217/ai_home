# 2026-06-30 Diagnostic Concurrency Closure

Goal: close the loop on the repeated timeout/probe-busy confusion by proving the
business path first, then recording the real transport failures and the code
change that prevents the same mistake from being planned as cloud edge work.

Only AWS current was used:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- ssh: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: `9527`

No retired VPS was touched. No new product port was opened.

## Root Cause

There were two different failures that looked similar in raw output:

1. Real cloud UDP failure: AWS can bind a temporary UDP echo on `9527`, but the
   local UDP probe times out and AWS `tcpdump` captures `0 packets`.
2. Diagnostic contention: two transport diagnostics run at the same time and
   both try to bind the same default UDP `9527` probe, causing
   `EADDRINUSE`. That maps to `turn_default_udp_probe_busy`.

`blocker-catalog` already knew `turn_default_udp_probe_busy` was
`diagnostic_concurrency`, but `closure-plan` classified transport blockers by
generic string matching. Because the blocker contains `turn` and `udp`, it could
be grouped as `transport_cloud_edge` and shown as external AWS work.

## Product Change

- `closure-plan` now classifies `turn_default_udp_probe_busy` before generic
  TURN/UDP matching.
- A new `transport-diagnostic-concurrency` plan item uses:
  - `domain=diagnostic_concurrency`
  - `status=diagnostic_retry`
  - `owner=aih`
  - `external=false`
  - `requiresConfirmation=false`
- `fabric transport prerequisites` now exposes:
  - `summary.diagnosticConcurrency.blocked`
  - `summary.diagnosticConcurrency.blockers`
  - `summary.diagnosticConcurrency.reason`
  - `summary.diagnosticConcurrency.nextAction`

This keeps real UDP path failures separate from artificial concurrent probe
failures.

## Business Closure and Stream Proof

Command:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-diagnostic-concurrency-20260630.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-diagnostic-concurrency-20260630.json" \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- `summary.status=usable_with_blockers`
- `summary.selectedTransportKind=webrtc`
- `summary.fallbackUsed=false`
- `conclusion.businessClosureProven=true`
- `conclusion.streamProofProven=true`
- run: `31d0609c-e302-4754-80d2-bad596e7072e`
- session: `ses_0eade0c44ffecYTrP568sj1tT0`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_204610`
- events: `ready`, `session-created`, `delta`, `result`, `done`

Conclusion: AWS current can run a real `opencode` session and stream the result
through the promoted `webrtc` path. This is not blocked by the remaining
advanced transport prerequisites.

## Serial Transport Recheck

Command:

```bash
node "bin/ai-home.js" fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `ok=true`
- `summary.baseReady=true`
- `summary.promotionReady=false`
- `summary.diagnosticConcurrency.blocked=false`
- default UDP remote echo: `ready=true`
- local UDP probe: `udp_echo_timeout`
- packet capture: `0 packets captured`
- WebTransport: `webtransport_connect_failed`, `webtransport_h3_endpoint_missing`
- Multipath: local macOS MPTCP unavailable, OpenMPTCPRouter not detected,
  default listener is plain HTTP

Command:

```bash
node "bin/ai-home.js" fabric transport cloud-edge \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `summary.cloudEdgeReady=false`
- `summary.udpReachable=false`
- `summary.packetArrivalCaptured=false`
- `summary.hostFirewallBlocksUdp=false`
- `summary.blockers`:
  - `turn_default_udp_9527_unreachable`
  - `aws_public_udp_path_blocked`
  - `aws_cli_missing`
  - `aws_iam_role_missing`
  - `aws_local_cli_missing`

## Provider Account Audit

Command:

```bash
node "bin/ai-home.js" fabric provider accounts audit \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --providers "codex,claude,agy,opencode" \
  --json
```

Result:

- `opencode`: ready
- `codex`: API key account, `auth_invalid:upstream_401`, action `update_api_key`
- `claude`: API key accounts, `auth_invalid:claude_not_logged_in`, action
  `update_api_key`
- `agy`: OAuth accounts, `auth_invalid:agy_not_signed_in`, action
  `complete_oauth_reauth`
- credential handoff summary: `ready=1`, `awaitingInput=3`

## Verification

Local:

```bash
node --check "lib/cli/services/fabric/closure-plan.js"
node --check "scripts/fabric-m6-prerequisite-audit.js"
node --test \
  "test/fabric-m6-prerequisite-audit.test.js" \
  "test/fabric-closure-audit.test.js" \
  "test/fabric-blocker-catalog.test.js"
```

Result:

- syntax checks: pass
- focused tests: `31/31 pass`
- full `npm test`: `2890/2890 pass`

AWS current:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/closure-plan.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check scripts/fabric-m6-prerequisite-audit.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-m6-prerequisite-audit.test.js test/fabric-closure-audit.test.js test/fabric-blocker-catalog.test.js"
```

Result:

- syntax checks: pass
- focused tests: `31/31 pass`

The AWS `setlocale` warning is non-fatal; command exit code was `0`.

## Post-Commit Sanity Note

One remote-only sanity command was intentionally excluded from the closure
evidence:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js fabric transport prerequisites --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --skip-preflight --skip-webtransport --skip-multipath --json"
```

It returned `ok=true` for the audit wrapper, but the default UDP probe reported
`turn_default_udp_probe_failed` because the AWS host tried to SSH to itself with
the local-client default key path `/home/ubuntu/.ssh/aws.pem`, which does not
exist on the node. The stderr was `Permission denied (publickey)`.

This is not evidence that AWS UDP changed. It is a caller-context issue: the
default UDP probe is currently a local-client diagnostic that SSHes into the
target. When running that command on AWS itself, pass an explicit reachable SSH
configuration or skip the default UDP probe. Do not classify this as
`aws_public_udp_path_blocked` or WebRTC/WebTransport failure.

## Failure Ledger

| Failure | Cause | Current evidence | Repeat prevention |
|---|---|---|---|
| AWS-local prerequisites command failed its default UDP probe | The command was run on AWS but still used the local-client default SSH key path `/home/ubuntu/.ssh/aws.pem`, which is absent. | Remote stdout showed `turn_default_udp_probe_failed` and stderr `Permission denied (publickey)`. | Treat AWS-local runs without an explicit SSH key as caller-context failures; use the local client for cloud-edge UDP proof or pass a valid SSH configuration. |
| Repeated timeout/probe-busy confusion | Concurrent default UDP diagnostics can race for UDP `9527` and produce `EADDRINUSE`. | New code maps `turn_default_udp_probe_busy` to `diagnostic_concurrency`, not cloud edge. | Run only one default UDP transport diagnostic at a time. Treat `probe_busy` as a diagnostic retry, not AWS network proof. |
| AWS UDP path blocked | Local datagrams do not reach the AWS interface. | Remote UDP echo ready, local probe timeout, packet capture `0 packets`, host firewall not blocking. | Do not repeat cloud-edge expecting a different result until SG/NACL/TURN/AWS readback evidence changes. |
| AWS SG/NACL readback unavailable | Neither remote IAM role/AWS CLI nor local AWS CLI is available. | `aws_cli_missing`, `aws_iam_role_missing`, `aws_local_cli_missing`. | Attach read-only EC2 permissions or configure local read-only AWS CLI before claiming SG/NACL state. |
| WebTransport not promotable | Default `9527` listener is plain HTTP, not HTTPS/H3 WebTransport. | Browser supports WebTransport but handshake fails with H3 endpoint missing. | Do not classify as browser failure until a real HTTPS/H3 endpoint exists. |
| Multipath not promotable | No real dual-ended MPTCP/OpenMPTCPRouter underlay. | AWS Linux has MPTCP capability, local macOS/OMR/default listener do not satisfy end-to-end underlay. | Do not promote multipath from one-sided capability. |
| Codex/Claude/AGY blocked | Target-node credentials are invalid or OAuth is not signed in. | Provider audit shows `opencode` ready, three providers awaiting operator input. | Do not debug as transport until credentials are updated or OAuth is completed on AWS. |

## Next Action

Software-side closure remains usable with recorded external blockers. The next
AIH-owned action is only to keep the diagnostic classification stable. Product
promotion still needs external input:

1. AWS SG/NACL/TURN evidence for UDP `9527`.
2. HTTPS/H3 WebTransport endpoint.
3. Dual-ended MPTCP/OpenMPTCPRouter underlay.
4. AWS-side Codex/Claude/AGY credential repair.
