# 2026-06-29 Fabric cloud API local readback

This evidence records the next closure step after blocker catalog / next queue:

- `aih fabric transport cloud-edge` now checks AWS cloud policy readback from two paths:
  - remote node path: AWS CLI + IAM role on the AWS node
  - local operator path: local AWS CLI read-only API calls from this Mac
- The two paths are combined as one cloud API readiness signal. Either path is enough for read-only SG/NACL readback; both missing keeps the cloud API blocker visible.
- No cloud policy was mutated. The local readback only uses `sts get-caller-identity`, `ec2 describe-instances`, `ec2 describe-security-groups`, and `ec2 describe-network-acls`.
- Local AWS identity output is summarized and redacted; raw access key / secret / session token patterns are not emitted.

Targets stayed scoped to AWS current:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- node id: `aws-current-node`
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- remote dir: `/home/ubuntu/aih-fabric-current`
- port: `9527`

## Code changes

- `scripts/fabric-cloud-edge-preflight.js`
  - added local AWS CLI read-only readback
  - added remote/local cloud API readiness merge
  - added redaction for AWS access key / secret / session token patterns
  - added output fields:
    - `remoteAwsApiCredentialsReady`
    - `localAwsApiReadbackReady`
    - `localAwsApiCredentialsReady`
    - `localAwsApiInstanceId`
    - `localAwsApiSubnetId`
- `lib/cli/services/fabric/transport-status.js`
  - forwards the new cloud API readiness fields into transport status summary and human output
- `lib/cli/services/fabric/blocker-catalog.js`
  - maps `aws_local_cli_missing`, `aws_local_credentials_missing`, and `aws_local_api_readback_failed` into the existing `cloud_api` remediation domain

## Local focused tests

Command:

```sh
node --test test/fabric-cloud-edge-preflight.test.js test/fabric-transport-cloud-edge.test.js test/fabric-blocker-catalog.test.js test/fabric-transport-status.test.js test/fabric-closure-audit.test.js
```

Result:

- `29/29 pass`

## Full test suite

Command:

```sh
npm test
```

Result:

- `2850/2850 pass`
- `fail=0`
- duration: `147483.12ms`

## Real AWS cloud-edge readback

Command:

```sh
node bin/ai-home.js fabric transport cloud-edge --json
```

Live result summary:

- `cloudEdgeReady=false`
- `udpReachable=false`
- `packetArrivalCaptured=false`
- `hostFirewallBlocksUdp=false`
- `cloudApiCredentialsReady=false`
- `remoteAwsApiCredentialsReady=false`
- `localAwsApiReadbackReady=false`
- `localAwsApiCredentialsReady=false`
- `publicIpv4=43.207.102.163`
- `privateAddress=172.31.47.163`
- `interface=enp39s0`
- `securityGroupIds=["sg-01e33f3412fabfded","sg-01e7f50a205d7b308"]`

UDP evidence:

- remote UDP echo started on `9527`
- local UDP echo timed out: `udp_echo_timeout`
- packet capture was available on AWS `enp39s0`
- packet capture result: `captured=false`, `0 packets captured`, `0 packets received by filter`
- AWS host firewall evidence:
  - `ufw=inactive`
  - `iptables INPUT ACCEPT`
  - `hostFirewallBlocksUdp=false`

Cloud API evidence:

- remote node:
  - `awsCli.available=false`
  - IMDS token available
  - IAM role probe HTTP status `404`
  - blocker: `aws_cli_missing`
  - blocker: `aws_iam_role_missing`
- local Mac:
  - `aws` CLI not found by `command -v aws`
  - blocker: `aws_local_cli_missing`

Final cloud-edge blockers:

- `turn_default_udp_9527_unreachable`
- `aws_public_udp_path_blocked`
- `aws_cli_missing`
- `aws_iam_role_missing`
- `aws_local_cli_missing`

## Real AWS transport status

Command:

```sh
node bin/ai-home.js fabric transport status --node-id aws-current-node --json
```

Live result summary:

- `status=complete`
- `remoteDevelopmentReady=true`
- `defaultTransport=webrtc`
- `fallbackReady=true`
- `advancedPromotionReady=true`
- `promotedTransports=["webrtc"]`
- `cloudEdgeReady=false`
- `cloudApiCredentialsReady=false`
- `remoteAwsApiCredentialsReady=false`
- `localAwsApiReadbackReady=false`

The current usable path remains live: paired client -> AWS node -> WebRTC -> `opencode` sessions. The cloud API blocker is now more precise: AWS SG/NACL readback cannot run because neither remote IAM/CLI nor local AWS CLI credentials are available.

## Remaining next step

`closurePlan.nextQueue` should still start with `transport-cloud-edge-udp`, then `transport-cloud-api-readback`.

The next non-mock action requires one of these operator/cloud changes:

- configure local AWS CLI with read-only EC2 credentials on this Mac, then re-run `aih fabric transport cloud-edge --json`; or
- attach a read-only IAM role and AWS CLI to the AWS node, then re-run the same command; or
- manually verify SG/NACL UDP `9527` policy outside AIH and record the result.

Until one of those happens, AIH must keep `aws_local_cli_missing` / `aws_iam_role_missing` visible instead of pretending SG/NACL was inspected.

## AWS deployment

Implementation commit:

- `9b6e54016bc56b0cf9de41a685f6d0570ddd355e`
- message: `feat(fabric): add local aws cloud api readback`

Clean artifact:

- local archive: `/tmp/aih-fabric-head-9b6e540.tar.gz`
- remote archive: `/home/ubuntu/aih-fabric-current/source-9b6e540.tar.gz`
- sha256: `25c8ce2486d5bd81a6ccf97d3cf9c809403ab27c536483b80305ce02354bce82`

Remote deploy verification:

```sh
cd /home/ubuntu/aih-fabric-current
printf "%s  %s\n" "25c8ce2486d5bd81a6ccf97d3cf9c809403ab27c536483b80305ce02354bce82" "source-9b6e540.tar.gz" | sha256sum -c -
tar -xzf source-9b6e540.tar.gz
printf "%s\n" "9b6e54016bc56b0cf9de41a685f6d0570ddd355e" > DEPLOYED_GIT_HEAD
node --check scripts/fabric-cloud-edge-preflight.js
node --check lib/cli/services/fabric/blocker-catalog.js
node --check lib/cli/services/fabric/transport-status.js
node --test test/fabric-cloud-edge-preflight.test.js test/fabric-transport-cloud-edge.test.js test/fabric-blocker-catalog.test.js test/fabric-transport-status.test.js test/fabric-closure-audit.test.js
```

Result:

- `source-9b6e540.tar.gz: OK`
- remote syntax checks: pass
- remote focused tests: `29/29 pass`

Server restart:

- old pid: `431635`
- new pid: `435978`
- parent after cleanup: `1`
- port: `9527`
- `/readyz ok=true ready=true`
- account counts: `codex=1`, `claude=4`, `agy=7`, `opencode=1`
- `DEPLOYED_GIT_HEAD=9b6e54016bc56b0cf9de41a685f6d0570ddd355e`

## Post-deploy real proof

Post-deploy cloud-edge command:

```sh
node bin/ai-home.js fabric transport cloud-edge --json
```

Result:

- `cloudEdgeReady=false`
- `udpReachable=false`
- `packetArrivalCaptured=false`
- `hostFirewallBlocksUdp=false`
- `cloudApiCredentialsReady=false`
- `remoteAwsApiCredentialsReady=false`
- `localAwsApiReadbackReady=false`
- blockers:
  - `turn_default_udp_9527_unreachable`
  - `aws_public_udp_path_blocked`
  - `aws_cli_missing`
  - `aws_iam_role_missing`
  - `aws_local_cli_missing`

Post-deploy transport status:

```sh
node bin/ai-home.js fabric transport status --node-id aws-current-node --json
```

Result:

- `status=complete`
- `remoteDevelopmentReady=true`
- `defaultTransport=webrtc`
- `fallbackReady=true`
- `advancedPromotionReady=true`
- `promotedTransports=["webrtc"]`
- `cloudApiCredentialsReady=false`
- `localAwsApiReadbackReady=false`
- `aws_local_cli_missing` appears in `summary.blockerDetails[]` as `domain=cloud_api`

Post-deploy closure audit:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_LOCAL_AWS_READBACK_DEPLOY_OK_20260629 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --json
```

Result:

- `ok=true`
- `summary.status=usable_with_blockers`
- `summary.coreReady=true`
- `summary.nodeReady=true`
- `summary.transportReady=true`
- `summary.targetProviderReady=true`
- `summary.sessionReady=true`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- `closurePlan.state=usable_with_external_blockers`
- `closurePlan.immediateNext.id=transport-cloud-edge-udp`

Real session proof:

- run id: `6fa2c3b3-7503-4e3c-8eb1-c9ec3ccc8b26`
- provider: `opencode`
- account id: `1`
- session id: `ses_0ecb415f7ffeYDSBow2bUWnlQy`
- event count: `5`
- event types: `ready`, `session-created`, `delta`, `result`, `done`
- marker found: `AIH_LOCAL_AWS_READBACK_DEPLOY_OK_20260629`
- done observed: yes

## Live recheck after closure-plan fix

This recheck follows the corrected order requested for Fabric closure work:

1. business closure invariant
2. real stream proof
3. failure cause record
4. remaining next step selection

AWS node state:

- server pid: `435978`
- parent pid: `1`
- `/readyz`: `ok=true`, `ready=true`
- account counts: `codex=1`, `claude=4`, `agy=7`, `opencode=1`
- deployed git head: `4b8b6ef5d287ce40d3b15b12bce7b2fd74ad780d`

Command:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_REAL_CLOSURE_20260629_1782735984182 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --json
```

Result:

- `ok=true`
- `summary.status=usable_with_blockers`
- `summary.coreReady=true`
- `summary.nodeReady=true`
- `summary.transportReady=true`
- `summary.targetProviderReady=true`
- `summary.sessionReady=true`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- run id: `e34233a2-8c6e-4704-be1d-12cb55b4cefa`
- event count: `5`
- marker found: `true`
- done observed: `true`
- `closurePlan.immediateNext.id=transport-cloud-edge-udp`

Current `closurePlan.nextQueue`:

| Order | Item | Status | Blockers | Cause |
|---:|---|---|---|---|
| 1 | `transport-cloud-edge-udp` | `blocked_external` | `turn_default_udp_9527_unreachable`, `aws_public_udp_path_blocked` | Local UDP `9527` probe times out and AWS `enp39s0` capture sees `0 packets`; host firewall is not blocking, so this requires AWS SG/NACL/cloud-edge verification. |
| 2 | `transport-cloud-api-readback` | `blocked_external` | `aws_cli_missing`, `aws_iam_role_missing`, `aws_local_cli_missing` | AIH cannot inspect SG/NACL rules because neither the AWS node nor this Mac currently has a usable AWS CLI read-only path. |
| 3 | `transport-webtransport-h3` | `blocked_external` | `webtransport:webtransport_endpoint_not_configured`, `webtransport:webtransport_not_promoted` | Default `9527` is the AIH HTTP listener, not a real HTTPS/H3 WebTransport endpoint. |
| 4 | `transport-multipath-underlay` | `blocked_external` | `omr:openmptcprouter_not_detected`, `mptcp:mptcp_data_plane_not_promoted` | No real OpenMPTCPRouter/MPTCP underlay is configured for both ends. |
| 5 | `provider-agy-blocked` | `blocked_external` | `provider_account_unavailable:agy` | AWS has AGY profiles, but they are not currently schedulable for real sessions. |
| 6 | `provider-claude-blocked` | `blocked_external` | `provider_account_unavailable:claude` | AWS Claude profiles are present but not logged in for real sessions. |
| 7 | `provider-codex-blocked` | `blocked_external` | `provider_account_unavailable:codex` | AWS Codex profile is present but still auth-invalid for real sessions. |

Conclusion:

- The business path is closed for the currently usable provider: local paired client -> AWS registry -> `aws-current-node` -> WebRTC -> real `opencode` stream.
- The remaining items are not code-loop failures. They require explicit cloud/network/provider-account changes before AIH can truthfully mark them done.
- Do not spend time rerunning full suites or redeploy loops before one of those external conditions changes; the next repeatable gate is the same `closure audit` command above.

## Failure log and prevention

This section records the failures from the implementation/deploy loop so the same mistakes are not repeated.

### 1. Remote SHA check used unsafe local shell expansion

Failure:

- The first remote deploy verification failed with `sha256sum: source-9b6e540.tar.gz: No such file or directory`.

Cause:

- The SSH command was wrapped in local double quotes and contained `$(sha256sum ...)`.
- The local shell expanded the command substitution before SSH executed it, so the check ran against the local filesystem instead of the AWS remote directory.

Fix:

- Replaced command substitution with remote-side `sha256sum -c -` inside a single-quoted SSH command.

Prevention:

- Do not put `$()`, backticks, or unescaped `$var` inside double-quoted SSH remote commands.
- Prefer this pattern for artifact verification:

```sh
printf "%s  %s\n" "<sha256>" "<archive>" | sha256sum -c -
```

### 2. Server restart matched/stopped processes with fragile quoting

Failure:

- The first restart attempt did not stop old pid `431635`.
- The command also printed `kill: (435852) - No such process`.

Cause:

- The remote `ps | awk` matcher was embedded in a heavily quoted one-liner. Shell quoting made the pid extraction unreliable.

Fix:

- Replaced the fragile `awk` expression with a simpler remote command:
  - `ps -axo pid=,command=`
  - `grep "node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"`
  - `sed` to extract the pid

Prevention:

- For deploy scripts, avoid nested `awk` with remote shell quoting when a simple `grep | sed` is enough.
- Always verify the old pid is gone and port `9527` is free before starting the new process.

### 3. Server start left a parent shell attached

Failure:

- The AWS node server started as pid `435978`, but its parent was a leftover deploy shell `435966`.
- The SSH command stayed open until the wrapper shell was manually killed.

Cause:

- The remote one-liner combined `nohup ... &` with later `&&` checks. The backgrounded node survived, but the shell wrapper remained attached as parent.

Fix:

- Verified `readyz`, killed only the wrapper shell pid `435966`, and confirmed node `435978` was reparented to `1`.

Prevention:

- Use a dedicated restart helper or a short remote script for server restarts instead of long inline one-liners.
- After restart, always verify:
  - `ps -p <node_pid> -o pid,ppid,stat,command`
  - `PPID=1`
  - `/readyz ok=true ready=true`

### 4. Business closure missed `aws_local_*` in closure plan grouping

Failure:

- `transport status` correctly reported `aws_local_cli_missing`, but `closurePlan.nextQueue.transport-cloud-api-readback` only listed `aws_cli_missing` and `aws_iam_role_missing`.

Cause:

- `blocker-catalog` recognized `aws_local_*`, but `closure-plan` had a separate `classifyTransportBlocker()` rule and only matched `aws_cli`, `aws_iam`, and `iam_role`.

Fix:

- Added `aws_local` to the closure-plan `cloud_api` classifier.
- Added a focused regression assertion that `transport-cloud-api-readback.blockers` includes `aws_local_cli_missing`.

Prevention:

- When adding a new blocker family, update and test every classifier:
  - blocker catalog
  - transport status summary
  - closure plan grouping
  - human-readable next queue

### 5. Stream proof summary script read the wrong JSON path

Failure:

- The first summarized stream proof omitted `runId` and `eventCount`, even though the proof itself passed.

Cause:

- The ad hoc summary script read from `sessionStart.result.runId`; the stable closure-audit summary exposes this as `sessionProof.runId` and `sessionProof.eventCount`.

Fix:

- Re-ran the stream proof with the correct summary path.

Result:

- run id: `8719ab12-3c1c-48da-8180-3a79dbf86aad`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- `eventCount=5`
- `markerFound=true`
- `doneObserved=true`
- `cloudApiBlockers=["aws_cli_missing","aws_iam_role_missing","aws_local_cli_missing"]`

Prevention:

- For closure-audit summaries, read proof fields from `sessionProof.*`, not nested raw session reports.

### 6. Verification order was inefficient

Failure:

- Full `npm test` was run before the closure-plan nextQueue invariant was checked against a live audit.

Cause:

- The flow focused on broad validation too early instead of proving the business invariant first.

Correct order going forward:

1. Implement the narrow business invariant.
2. Add/adjust focused regression tests for that invariant.
3. Run focused tests.
4. Run one real stream proof and inspect the exact product fields.
5. Record failures and remaining blockers.
6. Run full tests only when the code blast radius justifies it or before final release/large commit.
