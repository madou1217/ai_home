# 2026-06-30 Target-Local UDP Diagnostic Context

Goal: make AWS-local transport diagnostics usable without creating false cloud
edge evidence. The previous AWS-local sanity run proved a real issue: running
`fabric transport prerequisites` inside `/home/ubuntu/aih-fabric-current` still
tried to SSH back into the same AWS node using `/home/ubuntu/.ssh/aws.pem`, which
does not exist on the node.

Only AWS current was used:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- ssh: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: `9527`

No retired VPS was touched. No new product port was opened.

## Root Cause

`fabric-default-udp-probe` always executed target-side UDP echo, packet capture,
and edge snapshot commands through SSH. That is correct for local-client
diagnostics, but wrong when the command is already running in the target
deployment directory on AWS.

The visible failure was:

- `turn_default_udp_probe_failed`
- stderr: `Permission denied (publickey)`
- key path: `/home/ubuntu/.ssh/aws.pem`

That failure was caller-context noise, not cloud UDP evidence.

## Product Change

`fabric-default-udp-probe` now detects the target execution context:

- `commandMode=ssh`, `proofScope=client_to_target` when run from the local
  client.
- `commandMode=local`, `proofScope=target_local` when `cwd` is the target
  `remoteDir`.

Target-local UDP success is no longer promoted as cloud edge proof:

- local target command can start UDP echo and receive a local reply;
- report still sets `candidateReady=false`;
- blocker becomes `turn_default_udp_target_local_only`.

The new blocker is classified as:

- `domain=diagnostic_context`
- `owner=aih`
- `external=false`
- `requiresConfirmation=false`

`cloud-edge`, `prerequisites`, `blocker-catalog`, and `closure-plan` all keep
this separate from real `aws_public_udp_path_blocked`.

## Real AWS-Local Recheck

Command:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js fabric transport prerequisites --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --skip-preflight --skip-webtransport --skip-multipath --json"
```

Result:

- `ok=true`
- `summary.baseReady=true`
- `summary.promotionReady=false`
- `gates.turn.defaultPortUdp.targetExecution.commandMode=local`
- `gates.turn.defaultPortUdp.targetExecution.proofScope=target_local`
- `gates.turn.defaultPortUdp.remote.ready=true`
- `gates.turn.defaultPortUdp.local.ok=true`
- `gates.turn.defaultPortUdp.candidateReady=false`
- `gates.turn.defaultPortUdp.blockers=["turn_default_udp_target_local_only"]`
- `summary.diagnosticContext.blocked=true`
- `summary.diagnosticContext.blockers=["turn:turn_default_udp_target_local_only"]`
- no `Permission denied (publickey)`

This proves the command no longer tries to SSH to itself with a missing key.
It also correctly refuses to treat target-local UDP success as client-to-cloud
reachability.

## Real Local-Client Cloud Edge Recheck

Command:

```bash
node "bin/ai-home.js" fabric transport cloud-edge \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `ok=true`
- `udp.targetExecution.commandMode=ssh`
- `udp.targetExecution.proofScope=client_to_target`
- remote UDP echo: `ready=true`
- local UDP probe: `udp_echo_timeout`
- AWS packet capture: `0 packets captured`, `0 packets received by filter`
- host firewall: not blocking
- summary blockers:
  - `turn_default_udp_9527_unreachable`
  - `aws_public_udp_path_blocked`
  - `aws_cli_missing`
  - `aws_iam_role_missing`
  - `aws_local_cli_missing`

This confirms the real cloud edge result did not change: client-to-AWS UDP 9527
is still an external prerequisite.

## Post-Fix Business Closure And Stream Recheck

After the diagnostic-context fix was committed locally and synced to AWS current,
the product workflow was re-run from the local client against AWS default
`9527`.

Command:

```bash
node "bin/ai-home.js" fabric closure verify \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-target-local-closure-verify-20260630.json" \
  --handoff-file "/tmp/aih-fabric-target-local-closure-handoff-20260630.json" \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- `workflow=closure_verify`
- `summary.status=usable_with_blockers`
- `coreReady=true`
- `nodeReady=true`
- `transportReady=true`
- `targetProviderReady=true`
- `sessionReady=true`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- run: `0218fedc-13bd-4c48-9268-9443274975a3`
- session: `ses_0e9a37105ffevRbl1jF0gxZQfI`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260630_022948`
- events: `ready/session-created/delta/result/done`
- `failureLedger.status=usable_with_recorded_failures`
- `failureLedger.summary.total=7`
- `failureLedger.summary.external=7`
- `failureLedger.summary.actionableByAih=0`
- `failureLedger.summary.allExternal=true`
- `failureLedger.automation.canContinueWithoutInput=false`
- `failureLedger.automation.runnableCount=0`
- `handoff.executionDecision.decision=stop_awaiting_external_input`

Handoff files:

- `/tmp/aih-fabric-target-local-closure-verify-20260630.json`
- `/tmp/aih-fabric-target-local-closure-handoff-20260630.json`

This proves the latest code still completes the real AWS business closure and
stream proof. It also proves the next loop must not repeat closure/session
smoke until external evidence changes.

## Verification

Local:

```bash
node --check "scripts/fabric-default-udp-probe.js"
node --check "scripts/fabric-cloud-edge-preflight.js"
node --check "scripts/fabric-m6-prerequisite-audit.js"
node --check "lib/cli/services/fabric/closure-plan.js"
node --check "lib/cli/services/fabric/blocker-catalog.js"
node --test \
  "test/fabric-default-udp-probe.test.js" \
  "test/fabric-cloud-edge-preflight.test.js" \
  "test/fabric-m6-prerequisite-audit.test.js" \
  "test/fabric-blocker-catalog.test.js" \
  "test/fabric-closure-audit.test.js"
```

Result:

- syntax checks: pass
- focused tests: `51/51 pass`

Full suite:

```bash
npm test
```

Result:

- `2896/2896 pass`
- duration: `149008.495083ms`

AWS current:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check scripts/fabric-default-udp-probe.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check scripts/fabric-cloud-edge-preflight.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check scripts/fabric-m6-prerequisite-audit.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/closure-plan.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/blocker-catalog.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-default-udp-probe.test.js test/fabric-cloud-edge-preflight.test.js test/fabric-m6-prerequisite-audit.test.js test/fabric-blocker-catalog.test.js test/fabric-closure-audit.test.js"
```

Result:

- syntax checks: pass
- focused tests: `51/51 pass`

The AWS `setlocale` warning is non-fatal; command exit code was `0`.

## Failure Ledger

| Failure | Cause | Current evidence | Repeat prevention |
|---|---|---|---|
| AWS-local prerequisites used a missing SSH key | The default UDP probe always used SSH, even when already running inside the target `remoteDir`. | AWS-local command now reports `commandMode=local` and no publickey error. | Detect target-local execution and run target-side commands directly. |
| Target-local UDP success could be mistaken for cloud edge proof | A UDP reply from the same AWS node does not prove client-to-cloud UDP reachability. | AWS-local command returns `turn_default_udp_target_local_only` and `candidateReady=false`. | Keep `target_local` proof scope separate from `client_to_target`; never map it to `aws_public_udp_path_blocked` or promotion-ready state. |
| Real client-to-AWS UDP remains blocked | The local client still times out and AWS captures zero packets on `enp39s0`. | Local-client `cloud-edge` returns `turn_default_udp_9527_unreachable` and `aws_public_udp_path_blocked`. | Re-run from the client side only after SG/NACL/TURN/AWS readback evidence changes. |
| Closure/session proof could be repeated even though it already passed | Without reading the handoff, the next operator can mistake external prerequisites for unfinished business closure. | Latest `closure verify` returns real run `0218fedc-13bd-4c48-9268-9443274975a3`, session `ses_0e9a37105ffevRbl1jF0gxZQfI`, `runnableCount=0`, and `canContinueWithoutInput=false`. | Use the handoff execution decision first; do not rerun closure proof until SG/NACL/TURN, HTTPS/H3, MPTCP/OMR, or provider credentials change. |

## Next Action

No new AIH-owned runnable transport work was created by this fix. Remaining
promotion prerequisites are still external:

1. AWS SG/NACL/TURN evidence for client-to-AWS UDP `9527`.
2. HTTPS/H3 WebTransport endpoint.
3. Dual-ended MPTCP/OpenMPTCPRouter underlay.
4. AWS-side Codex/Claude/AGY credential repair.
