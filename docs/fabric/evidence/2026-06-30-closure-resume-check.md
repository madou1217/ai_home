# 2026-06-30 Closure Resume Check

Goal: add a lightweight product gate that decides whether it is worth
re-running closure proof after `executionDecision=stop_awaiting_external_input`.
This prevents repeated business/session proofs when none of the external
prerequisites changed.

Target:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- node: `aws-current-node`
- provider: `opencode`
- handoff: `/tmp/aih-fabric-closure-handoff-decision-20260630.json`

## Product Change

New command:

```bash
aih fabric closure resume-check --handoff-file FILE [--json]
```

The command:

- reads the existing closure handoff;
- reads current `fabric transport config` state and relevant environment flags;
- performs a read-only provider credential audit unless `--skip-provider-audit`
  is set;
- does not start a session;
- does not run cloud-edge, WebTransport, multipath, or promotion diagnostics;
- outputs whether any prerequisite changed enough to justify the next real
  recheck command.

## Real AWS Resume Check

Command:

```bash
node "bin/ai-home.js" fabric closure resume-check \
  --handoff-file "/tmp/aih-fabric-closure-handoff-decision-20260630.json" \
  --json
```

Result:

- `ok=true`
- `schema=aih.fabric.closure-resume-check.v1`
- `previousDecision.decision=stop_awaiting_external_input`
- `transportInputs.turnConfigured=false`
- `transportInputs.webtransportConfigured=false`
- provider audit was read from AWS current default `9527`
- `provider-credentials.audit.readyCount=0`
- `provider-credentials.audit.blockedCount=3`
- `provider-credentials.audit.allReady=false`
- `resume.canContinueWithoutInput=false`
- `resume.changedEvidenceCount=0`
- `resume.state=awaiting_external_input`

Provider audit details from this resume check:

| Provider | Status | Action | Runtime blocked |
|---|---|---|---:|
| `agy` | `awaiting_external_input` | `complete_oauth_reauth` | 7 |
| `claude` | `awaiting_operator_input` | `update_api_key` | 4 |
| `codex` | `awaiting_operator_input` | `update_api_key` | 1 |

Transport input checks:

| Prerequisite | Status | Reason |
|---|---|---|
| `cloud-udp-policy` | `unchanged` | No stored TURN/UDP candidate or TURN environment input is present. |
| `webtransport-h3-endpoint` | `unchanged` | No stored or environment WebTransport URL is present. |
| `multipath-underlay` | `unchanged` | No OpenMPTCPRouter/MPTCP underlay evidence source is configured in AIH. |

Conclusion:

```text
No external prerequisite input has changed since the handoff; do not repeat closure proof yet.
```

Business and stream proof source from the handoff:

- `conclusion.businessClosureProven=true`
- `conclusion.streamProofProven=true`
- `proof.businessClosure.status=usable_with_blockers`
- `proof.businessClosure.selectedTransportKind=webrtc`
- `proof.businessClosure.fallbackUsed=false`
- `proof.session.ok=true`
- `proof.session.runId=469f4f08-36f5-4a00-893a-cf529a81c64d`
- `proof.session.marker=AIH_FABRIC_CLOSURE_AUDIT_20260629_195415`
- `proof.session.eventTypes=ready/session-created/delta/result/done`

## Real AWS Remote CLI Check

The AWS deployment directory initially failed when running the same command from
the node itself:

```text
[aih] fabric command failed: no paired server profile is ready. Complete Server Setup pairing first.
```

Cause:

- `closure resume-check` is primarily a client-side gate.
- The provider credential audit reads the authorized local server profile before
  querying the target node.
- The AWS deployment directory intentionally does not reuse the Mac client's
  paired server profile, so the provider audit could not start there.

Fix:

- Provider audit errors are now returned as a `provider-credentials` check with
  `status=audit_unavailable`, `changed=false`, and the original error code/message.
- The command remains usable for failure diagnosis and does not invite another
  blind full closure proof run.

## Verification

- `node --check "lib/cli/services/fabric/closure-resume-check.js"` -> pass
- `node --check "lib/cli/commands/fabric-router.js"` -> pass
- `node --test "test/fabric-closure-resume-check.test.js" "test/fabric-closure-audit.test.js" "test/repository-policy.test.js"` -> `22/22 pass`
- `node --test --test-reporter=tap --test-reporter-destination="/tmp/aih-npm-test-closure-resume-check-20260630-r2.tap" "test/*.test.js"` -> `2887/2887 pass`
- Real AWS local-client `closure resume-check --handoff-file ... --json` -> pass with `provider-credentials.status=unchanged`
- Real AWS remote focused `node --test /home/ubuntu/aih-fabric-current/test/fabric-closure-resume-check.test.js` -> `5/5 pass`
- Real AWS remote deployment command -> pass with `provider-credentials.status=audit_unavailable`

AWS hash parity:

| File | sha256 |
|---|---|
| `lib/cli/services/fabric/closure-resume-check.js` | `7a863799a3855b53a6bc5a431493058e376b88d88c1607af269539002ad6a31c` |
| `lib/cli/commands/fabric-router.js` | `65f2ee521e02f57ea54c450d25673984120dd066ff30d83b42485db4da517b1f` |
| `test/fabric-closure-resume-check.test.js` | `50a7b1c364d77b20ba96d9dc6fd0ddb61e2f3a8d39cc0164653ea425a2b1e2fe` |
| `docs/fabric/08-current-status.md` | `9fb51a60cf283f5a6c744fd615f4a3cb655d7ca07ed4a7a48c219728fa17c81a` |

The evidence document itself is checked by the same local/AWS hash command but
is not embedded here to avoid a self-referential hash.

## Failure Ledger

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| Closure handoff could say "stop", but the next operator still had to manually infer whether anything changed. | There was no narrow resume gate between a handoff and a full closure/session proof. | Add `closure resume-check` to inspect current transport/provider inputs before any expensive proof rerun. | Run `closure resume-check` first. Only run the returned commands when `resume.canContinueWithoutInput=true`. |
| AWS remote CLI failed with `no paired server profile is ready`. | The remote deployment directory is not supposed to contain the Mac client's paired server profile; provider audit requires an authorized local server profile. | Treat provider audit failure as `audit_unavailable` inside the resume report instead of crashing. | Remote/self-node checks stay diagnostic; client-side checks with a real paired profile remain the authority for provider credential state. |

## Next Action

Still blocked by the same external prerequisites:

1. Configure a controlled TURN/UDP path or prove AWS SG/NACL allows UDP `9527`.
2. Configure a real HTTPS/H3 WebTransport endpoint.
3. Provide dual-ended OpenMPTCPRouter/MPTCP evidence.
4. Update/replace Codex and Claude API keys on AWS, and complete AGY OAuth.
