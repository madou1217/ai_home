# 2026-06-29 Fabric closure plan structured gate

This evidence closes the gap where `aih fabric closure audit` exposed free-form
`nextActions` but did not provide a structured, traceable plan for the remaining
blockers.

The change does not alter credentials, remote node configuration, ports, or
transport promotion state. It only turns the real audit result into a structured
`closurePlan` that clients can render and operators can follow.

## Changed files

- `lib/cli/services/fabric/closure-plan.js`
- `lib/cli/services/fabric/closure-audit.js`
- `test/fabric-closure-audit.test.js`
- `docs/fabric/evidence/2026-06-29-closure-plan-structured-gate.md`
- `docs/fabric/08-current-status.md`

## Local verification

```sh
node --check lib/cli/services/fabric/closure-plan.js
node --check lib/cli/services/fabric/closure-audit.js
node --test test/fabric-closure-audit.test.js test/fabric-transport-status.test.js
npm test
```

Result:

- syntax checks: pass
- focused/adjacent tests: 15/15 pass
- full suite: 2831/2831 pass

## Real AWS closure plan readback

Command:

```sh
node -e "const { runFabricClosureAudit } = require('./lib/cli/services/fabric/closure-audit'); (async () => { const r = await runFabricClosureAudit({ nodeId: 'aws-current-node', provider: 'opencode', skipSession: true }); console.log(JSON.stringify({ ok: r.ok, exitOk: r.exitOk, summary: r.summary, closurePlan: r.closurePlan }, null, 2)); })().catch((error) => { console.error(error && error.stack || error); process.exit(1); });"
```

Result summary:

- `ok=true`
- `exitOk=true`
- `summary.status=usable_with_blockers`
- `summary.coreReady=true`
- `summary.selectedTransportKind=webrtc`
- `closurePlan.state=needs_real_session_proof`
- `closurePlan.immediateNext.id=session-marker-proof-unchecked`
- `closurePlan.counts.done=3`
- `closurePlan.counts.blockedExternal=7`
- `closurePlan.counts.unchecked=1`

The plan correctly reports:

- `node-registry-ready`: `done`
- `provider-opencode-ready`: `done`
- `transport-default-ready`: `done`
- `provider-codex-blocked`: `blocked_external`, reason `runtime:auth_invalid:upstream_401=1`
- `provider-claude-blocked`: `blocked_external`, reason `runtime:auth_invalid:claude_not_logged_in=4`
- `provider-agy-blocked`: `blocked_external`, reason `runtime:auth_invalid:agy_not_signed_in=7`
- `transport-cloud-edge-udp`: `blocked_external`, blockers `turn_default_udp_9527_unreachable`, `aws_public_udp_path_blocked`
- `transport-cloud-api-readback`: `blocked_external`, blockers `aws_cli_missing`, `aws_iam_role_missing`
- `transport-webtransport-h3`: `blocked_external`, blockers `webtransport:webtransport_endpoint_not_configured`, `webtransport:webtransport_not_promoted`
- `transport-multipath-underlay`: `blocked_external`, blockers `omr:openmptcprouter_not_detected`, `mptcp:mptcp_data_plane_not_promoted`

The generated commands were checked for subcommand compatibility. For example,
`turn-relay` and `webtransport` commands do not include unsupported `--node-id`.

## Real AWS session proof

Command:

```sh
node -e "const { runFabricClosureAudit } = require('./lib/cli/services/fabric/closure-audit'); (async () => { const marker = 'AIH_CLOSURE_PLAN_REAL_OK_20260629_1721'; const r = await runFabricClosureAudit({ nodeId: 'aws-current-node', provider: 'opencode', sessionMarker: marker, eventTimeoutMs: 60000, sessionTimeoutMs: 120000 }); console.log(JSON.stringify({ ok: r.ok, exitOk: r.exitOk, status: r.summary.status, coreReady: r.summary.coreReady, selectedTransportKind: r.summary.selectedTransportKind, fallbackUsed: r.summary.fallbackUsed, runId: r.sessionProof.runId, markerFound: r.sessionProof.markerFound, doneObserved: r.sessionProof.doneObserved, eventCount: r.sessionProof.eventCount, closureState: r.closurePlan.state, immediateNext: r.closurePlan.immediateNext, blockedExternal: r.closurePlan.counts.blockedExternal }, null, 2)); })().catch((error) => { console.error(error && error.stack || error); process.exit(1); });"
```

Result:

- `ok=true`
- `exitOk=true`
- `summary.status=usable_with_blockers`
- `summary.coreReady=true`
- `runId=6918e0ef-fa3e-4fb1-92fc-53c9207873df`
- `markerFound=true`
- `doneObserved=true`
- `eventCount=5`
- `closurePlan.state=usable_with_external_blockers`
- `closurePlan.counts.blockedExternal=7`
- `summary.selectedTransportKind=relay`
- `summary.fallbackUsed=true`

The session proof is still a pass because the marker and terminal events were
observed. The transport selector used relay fallback for this run; that is
recorded as evidence and does not promote or demote any transport by itself.

## AWS remote archive deploy verification

Final deployed artifact:

```text
source: clean git archive of the final closure-plan commit
remote: ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current/source-closure-plan.tar.gz
remote DEPLOYED_GIT_HEAD: final closure-plan commit hash
```

Remote checks:

```sh
NODE=.node-runtime/node-v22.16.0-linux-x64/bin/node
$NODE --check lib/cli/services/fabric/closure-plan.js
$NODE --check lib/cli/services/fabric/closure-audit.js
$NODE --test test/fabric-closure-audit.test.js test/fabric-transport-status.test.js
```

Result:

- syntax checks: pass
- remote focused/adjacent tests: 15/15 pass

AWS loopback closure plan readback:

```sh
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
$NODE -e "const { runFabricClosureAudit } = require('./lib/cli/services/fabric/closure-audit'); (async () => { const r = await runFabricClosureAudit({ endpoint: 'http://127.0.0.1:9527', nodeId: 'aws-current-node', provider: 'opencode', skipSession: true, skipCloudEdge: true }); console.log(JSON.stringify({ ok: r.ok, exitOk: r.exitOk, status: r.summary.status, coreReady: r.summary.coreReady, closureState: r.closurePlan.state, immediateNext: r.closurePlan.immediateNext, counts: r.closurePlan.counts }, null, 2)); })().catch((error) => { console.error(error && error.stack || error); process.exit(1); });"
```

Result summary:

- `ok=true`
- `exitOk=true`
- `status=usable_with_blockers`
- `coreReady=true`
- `closureState=needs_real_session_proof`
- `immediateNext.id=session-marker-proof-unchecked`
- `counts.done=3`
- `counts.blockedExternal=5`
- `counts.unchecked=1`

AWS loopback real session proof after clean archive extraction:

```sh
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
$NODE -e "const { runFabricClosureAudit } = require('./lib/cli/services/fabric/closure-audit'); (async () => { const r = await runFabricClosureAudit({ endpoint: 'http://127.0.0.1:9527', nodeId: 'aws-current-node', provider: 'opencode', sessionMarker: 'AIH_AWS_CLOSURE_PLAN_ARCHIVE_OK_20260629_1740', eventTimeoutMs: 60000, sessionTimeoutMs: 120000, skipCloudEdge: true }); console.log(JSON.stringify({ ok: r.ok, exitOk: r.exitOk, status: r.summary.status, coreReady: r.summary.coreReady, selectedTransportKind: r.summary.selectedTransportKind, fallbackUsed: r.summary.fallbackUsed, runId: r.sessionProof.runId, markerFound: r.sessionProof.markerFound, doneObserved: r.sessionProof.doneObserved, eventCount: r.sessionProof.eventCount, closureState: r.closurePlan.state, blockedExternal: r.closurePlan.counts.blockedExternal }, null, 2)); })().catch((error) => { console.error(error && error.stack || error); process.exit(1); });"
```

Result:

- `ok=true`
- `exitOk=true`
- `summary.status=usable_with_blockers`
- `summary.coreReady=true`
- `summary.selectedTransportKind=webrtc`
- `summary.fallbackUsed=false`
- `runId=2e5d538e-1abb-473f-a356-7b2e76aa2a39`
- `markerFound=true`
- `doneObserved=true`
- `eventCount=5`
- `closurePlan.state=usable_with_external_blockers`
- `closurePlan.counts.blockedExternal=5`

## Remaining blockers

These are still real external blockers and were not marked complete:

- Provider accounts: Codex upstream 401, Claude not logged in, AGY not signed in.
- TURN/UDP cloud edge: UDP 9527 packets do not arrive at the AWS instance, and AWS CLI/IAM readback is not available on the node.
- WebTransport: no real HTTPS/H3 WebTransport endpoint is configured on the default listener.
- Multipath: no real OpenMPTCPRouter/MPTCP underlay has been detected and promoted.
