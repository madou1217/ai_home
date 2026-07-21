# 2026-06-30 Closure Execution Decision

Goal: make the closure output explicitly decide whether AIH should continue
automation or stop waiting for external input. This prevents the current AWS
target from looping on the same cloud-edge/provider diagnostics after business
closure and stream proof have already passed.

Target:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- node: `aws-current-node`
- provider: `opencode`
- remote dir: `/home/ubuntu/aih-fabric-current`

## Product Change

`failureLedger` now includes an `executionDecision` object derived from the
same failure list, automation summary, external prerequisite groups, and stream
proof that already drive the closure report.

The handoff file exports the same decision at:

- `conclusion.executionDecision`
- `executionDecision`
- `failureLedger.executionDecision`

No second decision tree was added to the handoff layer; it remains a projection
from `failureLedger`.

## Real AWS Closure Verify

Command:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-decision-20260630.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-decision-20260630.json" \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- `workflow=closure_verify`
- `summary.status=usable_with_blockers`
- `coreReady=true`
- `businessClosureProven=true`
- `streamProofProven=true`
- run: `469f4f08-36f5-4a00-893a-cf529a81c64d`
- session: `ses_0eb0d924cffePzf0Osz5qa0ReX`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_195415`
- events: `ready`, `session-created`, `delta`, `result`, `done`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- `automation.state=awaiting_external_input`
- `automation.runnableCount=0`
- `automation.operatorInputCount=7`
- `executionDecision.decision=stop_awaiting_external_input`

The handoff summary:

```json
{
  "executionDecision": {
    "decision": "stop_awaiting_external_input",
    "state": "awaiting_external_input",
    "canContinueWithoutInput": false,
    "reason": "Business closure and stream proof already passed; every remaining failure is external or requires confirmation.",
    "resumeWhen": [
      "SG/NACL readback or a controlled TURN/UDP path that proves packets can reach the target node.",
      "Browser WebTransport handshake and stream/RPC smoke against an HTTPS/H3 endpoint.",
      "Dual-ended MPTCP/OpenMPTCPRouter evidence plus transport smoke over the promoted underlay.",
      "Reauthenticated or replaced provider accounts on the target node, followed by a provider account audit that clears the auth blockers."
    ]
  }
}
```

## Human CLI Output

The non-JSON `closure verify` output now includes the execution decision inside
`failure_ledger`:

```text
decision: stop_awaiting_external_input can_continue=no
  reason: Business closure and stream proof already passed; every remaining failure is external or requires confirmation.
  resume_when:
    - SG/NACL readback or a controlled TURN/UDP path that proves packets can reach the target node.
    - Browser WebTransport handshake and stream/RPC smoke against an HTTPS/H3 endpoint.
    - Dual-ended MPTCP/OpenMPTCPRouter evidence plus transport smoke over the promoted underlay.
    - Reauthenticated or replaced provider accounts on the target node, followed by a provider account audit that clears the auth blockers.
```

## Remaining Failures

The failure list did not change. The product now states that none of these are
safe to re-run automatically without new external evidence:

| Failure | Cause | Resume condition |
|---|---|---|
| `transport-cloud-edge-udp` | AWS host firewall is open, but UDP `9527` packets do not arrive at the instance. | SG/NACL readback or controlled TURN/UDP proof. |
| `transport-cloud-api-readback` | Node and local machine lack AWS CLI/read-only AWS credentials/IAM role for SG/NACL readback. | Read-only AWS API access is available. |
| `transport-webtransport-h3` | Default `9527` is plain HTTP, not a secure HTTP/3 WebTransport endpoint. | Browser WebTransport handshake and stream/RPC smoke pass against HTTPS/H3. |
| `transport-multipath-underlay` | Multipath cannot be promoted from one-sided Linux capability or plain HTTP listener. | Dual-ended MPTCP/OpenMPTCPRouter underlay plus transport smoke. |
| `provider-agy-blocked` | AWS AGY accounts are OAuth-blocked and need operator authorization. | OAuth reauth is completed and provider audit clears blockers. |
| `provider-claude-blocked` | AWS Claude API-key accounts are not schedulable. | API key is updated/replaced and provider audit clears blockers. |
| `provider-codex-blocked` | AWS Codex API-key account `2` returns `auth_invalid:upstream_401`. | API key is updated/replaced and provider audit clears blockers. |

## Verification

- `node --check "lib/cli/services/fabric/failure-ledger.js"` -> pass
- `node --check "lib/cli/services/fabric/closure-audit.js"` -> pass
- `node --test "test/fabric-closure-audit.test.js"` -> `15/15 pass`
- `node --test "test/fabric-closure-audit.test.js" "test/repository-policy.test.js"` -> `17/17 pass`
- `node --test --test-reporter=tap --test-reporter-destination="/tmp/aih-npm-test-closure-execution-decision-20260630.tap" "test/*.test.js"` -> `2882/2882 pass`
- Real AWS `closure verify --handoff-file` -> pass, run `469f4f08-36f5-4a00-893a-cf529a81c64d`
- AWS focused: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js` -> `15/15 pass`
- Hash parity verified between local and `/home/ubuntu/aih-fabric-current`:
  - `lib/cli/services/fabric/failure-ledger.js` -> `37600643ba749cc7796604e57e40c940fc703351315d0661a1fa3a18a2533c1e`
  - `lib/cli/services/fabric/closure-audit.js` -> `ff4ca0505b449e1487a75d4670b78f7ed84315dd7e96d120dc4575fb5a4abed2`
  - `test/fabric-closure-audit.test.js` -> `de01a32178bbf9580b55b22b2b4f117f5adf7ce19c196803a8319054bd65d03a`
  - `docs/fabric/08-current-status.md` -> `469a9d7d809aff4c324ee4f202be3a0a51545ad48fea64f7d7f495653130100f`
- This evidence file was synced after final verification; it is not listed with
  a self-hash because embedding its own sha256 would change that sha256.

AWS live-directory verification note:

- `test/repository-policy.test.js` was intentionally not counted as an AWS
  focused pass because the live deployment directory contains runtime data under
  `.aih-host-home` and historical `.cleanup-snapshots`, including generated
  Markdown from provider/plugin caches. That failure is an environment hygiene
  issue in the live deploy directory, not a closure execution decision
  regression. Local repository policy passed.

## Anti-Loop Rule

If `executionDecision.decision=stop_awaiting_external_input` and
`automation.runnableCount=0`, do not repeat closure verify, cloud-edge,
WebTransport, multipath, or provider session attempts until at least one
`resumeWhen` evidence item has changed.
