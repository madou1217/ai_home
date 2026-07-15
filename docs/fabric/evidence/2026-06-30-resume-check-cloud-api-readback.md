# 2026-06-30 Resume Check Cloud API Readback

Goal: make `closure resume-check` detect whether the cloud UDP branch has new
read-only AWS evidence before rerunning closure/session proof. The previous
resume gate only looked for TURN/WebTransport/provider changes, so AWS
CLI/IAM/readback changes could be missed.

Only AWS current was used:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- node: `aws-current-node`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: `9527`

No retired VPS was touched. No new port was opened.

## Product Change

`closure resume-check` now checks `cloud-udp-policy` in two ways:

1. Stored/env TURN input still marks the branch `ready_to_recheck`.
2. A read-only cloud API check runs `cloud-edge` with `skipUdpProbe=true`.

This means the resume gate can detect a future AWS CLI/IAM/local AWS readback
change without sending UDP packets or starting a session.

The check is intentionally narrow:

- no session start;
- no UDP probe;
- no WebTransport probe;
- no multipath probe;
- no provider credential upload;
- no AWS mutation command.

`--skip-cloud-api-check` is available for purely offline handoff parsing.

## Root Cause

There were two loop risks:

| Failure | Cause | Fix |
|---|---|---|
| Cloud UDP branch could stay `unchanged` even after read-only AWS API credentials were added. | `resume-check` only looked for TURN input, not AWS CLI/IAM/readback state. | Add read-only cloud API readback to `cloud-udp-policy`. |
| AWS-local resume-check reported generic `aws_cloud_api_probe_failed`. | `cloud-edge` cloud API snapshot still SSHed to the target even when already running in the target `remoteDir`. | Reuse the target command execution strategy; target-local cloud API snapshot now runs locally. |

## Real Local-Client Resume Check

Command:

```bash
node "bin/ai-home.js" fabric closure resume-check \
  --handoff-file "/tmp/aih-fabric-target-local-closure-handoff-20260630.json" \
  --json
```

Result:

- `ok=true`
- `schema=aih.fabric.closure-resume-check.v1`
- `previousDecision.decision=stop_awaiting_external_input`
- `checks[cloud-udp-policy].status=unchanged`
- `checks[cloud-udp-policy].cloudApi.cloudApiCredentialsReady=false`
- `checks[cloud-udp-policy].cloudApi.remote.blockers=["aws_cli_missing","aws_iam_role_missing"]`
- `checks[cloud-udp-policy].cloudApi.local.blockers=["aws_local_cli_missing"]`
- `checks[provider-credentials].status=unchanged`
- `resume.canContinueWithoutInput=false`
- `resume.changedEvidenceCount=0`

Interpretation: the local client can now prove that cloud API readback still has
no new input, so closure proof should not be repeated.

## Real AWS-Local Resume Check

The same handoff was copied to AWS `/tmp`; it contains closure projection only,
not raw device tokens or raw diagnostics.

Command:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js fabric closure resume-check --handoff-file /tmp/aih-fabric-target-local-closure-handoff-20260630.json --json"
```

Result:

- `ok=true`
- `exitOk=true`
- `checks[cloud-udp-policy].status=unchanged`
- `checks[cloud-udp-policy].cloudApi.blockers=["aws_cli_missing","aws_iam_role_missing","aws_local_cli_missing"]`
- `checks[provider-credentials].status=audit_unavailable`
- `checks[provider-credentials].audit.error.code=ready_server_profile_missing`
- `resume.canContinueWithoutInput=false`

This proves the AWS-local path no longer produces a generic cloud API probe
failure by trying to SSH to itself.

## Verification

Local:

```bash
node --check "scripts/fabric-cloud-edge-preflight.js"
node --check "lib/cli/services/fabric/closure-resume-check.js"
node --check "lib/cli/commands/fabric-router.js"
node --test \
  "test/fabric-closure-resume-check.test.js" \
  "test/fabric-cloud-edge-preflight.test.js" \
  "test/fabric-closure-audit.test.js" \
  "test/fabric-transport-cloud-edge.test.js"
```

Result:

- syntax checks: pass
- focused/adjacent tests: `38/38 pass`

Full suite:

```bash
npm test
```

Result:

- `2900/2900 pass`
- duration: `152580.035375ms`

AWS current:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check scripts/fabric-cloud-edge-preflight.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/closure-resume-check.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-cloud-edge-preflight.test.js test/fabric-closure-resume-check.test.js"
```

Result:

- syntax checks: pass
- focused tests: `18/18 pass`

The AWS `setlocale` warning is non-fatal; command exit code was `0`.

## Next Action

No internal AIH session/transport rerun is justified yet. Resume only when one
of these inputs changes:

1. AWS CLI + read-only EC2 permissions are available locally or on the node.
2. A controlled TURN/UDP path is configured.
3. A real HTTPS/H3 WebTransport endpoint is configured.
4. A dual-ended OpenMPTCPRouter/MPTCP underlay is present.
5. AWS Codex/Claude/AGY credentials are repaired with explicit operator action.
