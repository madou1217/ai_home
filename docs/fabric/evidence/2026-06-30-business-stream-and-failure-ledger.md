# 2026-06-30 Business Stream and Failure Ledger

## Scope

- Target server: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- Node: `aws-current-node`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Deployed git head: `71fc5c4cc3f386972b390fd90cbe51775ee2876d`
- Server process: `487271 ./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`
- Diagnostics file: `/tmp/aih-fabric-business-stream-closure-20260630.json`

Only AWS current was touched. The old `152.*`, `155.*`, and `39.104.*` servers were not used.

## Business Closure

Command:

```bash
node "bin/ai-home.js" fabric closure audit \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --diagnostics-file "/tmp/aih-fabric-business-stream-closure-20260630.json" \
  --json
```

Result:

- `ok=true`, `exitOk=true`
- `summary.status=usable_with_blockers`
- `coreReady=true`, `nodeReady=true`, `transportReady=true`, `targetProviderReady=true`, `sessionReady=true`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- `closurePlan.state=usable_with_external_blockers`
- `closurePlan.immediateNext=transport-cloud-edge-udp`
- `nextQueue=transport-cloud-edge-udp,transport-cloud-api-readback,transport-webtransport-h3,transport-multipath-underlay,provider-agy-blocked,provider-claude-blocked,provider-codex-blocked`

Session stream proof:

- run: `287d0f1f-ef0a-4046-8689-1939a28fd6d0`
- session: `ses_0ebd95b6affekUNiKHjR4YjfXJ`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_161140`
- events: `ready -> session-created -> delta -> result -> done`
- event count: `5`
- completed: `true`

Conclusion: the current business path is closed for the available AWS provider path. Local client can use the AWS node with `opencode` over WebRTC without relay fallback.

## Node Readback

Command:

```bash
node "bin/ai-home.js" fabric nodes "aws-current-node" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- paired profile: `cp-51hq70`
- unauthenticated registry read: `401`
- authorized registry read: `200`
- target roles: `node`, `relay-node`
- capabilities:
  - `projectHost=true`
  - `runtimeHost=true`
  - `sshBootstrap=true`
  - `transportKinds=relay,webrtc`
  - `runtimeProviders=agy,claude,codex,opencode`
- enabled actions:
  - `open-project`
  - `start-session:opencode`
  - `configure-ssh`
  - `run-measurement`
- blocked provider actions:
  - `start-session:codex` blocked by `provider_account_unavailable:codex`
  - `start-session:claude` blocked by `provider_account_unavailable:claude`
  - `start-session:agy` blocked by `provider_account_unavailable:agy`

## Provider Runtime Ledger

Command:

```bash
node "bin/ai-home.js" fabric provider accounts audit \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --providers codex,claude,agy,opencode \
  --json
```

Result:

| Provider | Profiles | Runtime blocked | Current reason | Product status |
|---|---:|---:|---|---|
| `opencode` | 1 | 0 | healthy | usable |
| `codex` | 1 | 1 | `auth_invalid:upstream_401` | external account fix required |
| `claude` | 4 | 4 | `auth_invalid:claude_not_logged_in` | external account login required |
| `agy` | 7 | 7 | `auth_invalid:agy_not_signed_in` | external account login required |

Conclusion: Codex/Claude/AGY failures are provider credential state on AWS. They are not Fabric network failures and should not trigger repeated transport debugging.

## Transport Failure Ledger

### Cloud Edge UDP

Command:

```bash
node "bin/ai-home.js" fabric transport cloud-edge \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- remote UDP echo: `ready=true`, port `9527`
- local UDP probe: `ok=false`, `error=udp_echo_timeout`, `sent=13`
- AWS packet capture:
  - interface: `enp39s0`
  - `0 packets captured`
  - `0 packets received by filter`
  - `0 packets dropped by kernel`
- host firewall:
  - `ufw=inactive`
  - `iptables INPUT ACCEPT`
  - `hostFirewallBlocksUdp=false`
- AWS identity:
  - public IPv4: `43.207.102.163`
  - private address: `172.31.47.163`
  - security groups: `sg-01e33f3412fabfded`, `sg-01e7f50a205d7b308`
- AWS API readback:
  - remote `aws` CLI missing
  - remote IAM role missing, IMDS role probe HTTP `404`
  - local `aws` CLI missing

Root cause classification:

- `turn_default_udp_9527_unreachable`
- `aws_public_udp_path_blocked`
- `aws_cli_missing`
- `aws_iam_role_missing`
- `aws_local_cli_missing`

Do not keep re-running this as an application timeout. The AWS instance did not receive UDP packets on the public path. The next real action is SG/NACL/read-only AWS API verification or a controlled TURN endpoint.

### WebTransport

Command:

```bash
node "bin/ai-home.js" fabric transport webtransport \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- browser channel: `chrome`
- `isSecureContext=true`
- `webTransportType=function`
- WebTransport URL: `https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo`
- failure: `WebTransportError: Opening handshake failed.`
- blocker: `webtransport_connect_failed`
- transport config: `present=false`

Root cause classification:

- default `9527` is the plain AIH HTTP listener.
- No real HTTPS/H3 WebTransport endpoint is configured.

Do not classify this as a generic browser failure. The browser supports WebTransport; the server endpoint is not an H3 WebTransport endpoint.

### Multipath / OpenMPTCPRouter

Command:

```bash
node "bin/ai-home.js" fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --json
```

Result:

- AWS base gate: `candidateReady=true`, `promotionReady=true`
- server process count: `1`
- host home: `/home/ubuntu/aih-fabric-current/.aih-host-home`, `ok=true`
- service status:
  - relay running
  - registry agent running
  - WebRTC running
- summary:
  - `baseReady=true`
  - `promotionReady=false`
  - `readyTransports=[]`
- blockers:
  - `turn:turn_ice_server_not_configured`
  - `turn:turn_default_udp_9527_unreachable`
  - `webtransport:webtransport_connect_failed`
  - `multipath:local_mptcp_unavailable`
  - `multipath:openmptcprouter_not_detected`
  - `multipath:default_listener_is_plain_http_not_multipath_transport`
- multipath details:
  - local platform: `Darwin arm64`
  - local kernel MPTCP: `false`
  - local Python MPTCP socket: `false`
  - remote platform: `Linux x86_64`
  - remote kernel MPTCP: `true`
  - remote Python MPTCP socket: `true`
  - `openMptcpRouterDetected=false`
  - listener `9527` is plain Node TCP/HTTP

Root cause classification:

- Multipath has some remote capability, but the end-to-end underlay is not real yet.
- Local macOS cannot provide the required Linux MPTCP data-plane evidence.
- No OpenMPTCPRouter path was detected.
- Default `9527` remains a plain AIH listener, not a multipath transport listener.

Do not promote multipath until a real dual-ended underlay exists and this gate changes.

## Current Transport Readiness

Command:

```bash
node "bin/ai-home.js" fabric transport readiness \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --json
```

Result:

- `defaultTransport=webrtc`
- `promotedTransports=webrtc`
- `promotionReady=true`
- `fallbackReady=true`
- relay measurement pass: `true`
- relay p95: `1ms`
- remaining blockers:
  - `webtransport:webtransport_endpoint_not_configured`
  - `webtransport:webtransport_not_promoted`
  - `omr:openmptcprouter_not_detected`
  - `mptcp:mptcp_data_plane_not_promoted`

Interpretation:

- Direct WebRTC is not just a lab artifact in the current AWS path. It is the selected and used stream transport for the successful `opencode` business session.
- TURN relay, WebTransport/H3, and multipath remain separate advanced transport prerequisites.

## 2026-06-30 Re-run Evidence

This re-run was triggered after repeated timeout loops. It keeps the same AWS-only scope and default `9527` port, then separates business closure from transport failure classification.

Business and stream proof:

- diagnostics file: `/tmp/aih-fabric-business-stream-current-20260630.json`
- `fabric closure audit` returned `ok=true`, `exitOk=true`, `summary.status=usable_with_blockers`
- `sessionReady=true`, `selectedTransportKind=webrtc`, `fallbackUsed=false`
- run: `d9c3c1d7-f447-4ea0-9784-474a97de0bc2`
- session: `ses_0eba80ebfffeTJ3p7r78FdGA6i`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_170529`
- stream status: `completed`
- events: `ready -> session-created -> delta -> result -> done`
- `closurePlan.state=usable_with_external_blockers`
- `closurePlan.immediateNext=transport-cloud-edge-udp`
- `closurePlan.nextQueue=transport-cloud-edge-udp,transport-cloud-api-readback,transport-webtransport-h3,transport-multipath-underlay,provider-agy-blocked,provider-claude-blocked,provider-codex-blocked`

WebRTC stream transport smoke:

```bash
npx --yes --package playwright node "scripts/fabric-real-webrtc-datachannel-smoke.js" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --sample-count 1 \
  --rpc-sample-count 1 \
  --timeout-ms 30000 \
  --diagnostics-file "/tmp/aih-fabric-webrtc-smoke-current-20260630.json"
```

Result:

- `ok=true`
- room: `rtc_pfi4nP1RsqppJp0F`
- RPC: `ok=true`, `responses=1`, `requestsHandled=1`
- DataChannel p95: `415.2ms`
- RPC p95: `414.9ms`
- both peers reached `iceConnectionState=connected`
- candidate kinds included `host` and `srflx`

Server profile browser closure:

```bash
npx --yes --package playwright node "scripts/fabric-real-server-profile-switch-smoke.js" \
  --timeout-ms 60000 \
  --diagnostics-file "/tmp/aih-fabric-server-profile-switch-20260630-r2.json"
```

Result:

- `ok=true`
- endpoints:
  - `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
  - `http://43.207.102.163:9527`
- real AWS invites created:
  - `device-invite-gr6yx0tueoc`
  - `device-invite-_zxboo8yucq`
- paired profiles:
  - `cp-51hq70`, `state=paired`, `authState=paired`, `deviceTokenPresent=true`
  - `cp-1pp83dd`, `state=paired`, `authState=paired`, `deviceTokenPresent=true`
- product selector switch proof:
  - switched to `cp-51hq70`, reload persisted `true`
  - switched to `cp-1pp83dd`, reload persisted `true`
- active node inventory read through the selected profile:
  - HTTP `200`
  - `nodeCount=4`
  - includes `aws-current-node`

The first run of this new smoke failed before the diagnostic hardening:

- diagnostics file: `/tmp/aih-fabric-server-profile-switch-20260630.json`
- duration: `96192ms`
- both AWS invites were created and had pair URLs.
- no paired profile appeared in the browser profile store before timeout.
- original failure surfaced as `page.waitForFunction: Timeout 90000ms exceeded`.

Root cause classification:

- AWS server health, descriptor, and invite APIs were not the cause; `/readyz`, `/v0/fabric/descriptor`, and invite creation were all verified immediately after the failure.
- The failure was a browser/WebUI profile-store observation timeout during auto-pair, not a Fabric node, provider, or transport failure.
- The smoke now records `webui_pair_profile_store_timeout` with current URL, body text, profile-store count, active profile id, stored profile endpoints, and console samples.
- The immediate hardened re-run passed in `7616ms`, so the failure is recorded as a diagnosed transient WebUI/browser smoke failure, not a remaining product blocker.

Local and AWS verification for the new smoke:

- local focused: `node --test "test/fabric-real-server-profile-switch-smoke.test.js" "test/control-plane-profiles.test.js" "test/fabric-profile-pairing.test.js" "test/repository-policy.test.js"` -> `45/45 pass`
- `git diff --check` -> clean
- scoped files copied to `/home/ubuntu/aih-fabric-current`:
  - `scripts/fabric-real-server-profile-switch-smoke.js`
  - `test/fabric-real-server-profile-switch-smoke.test.js`
  - `docs/fabric/08-current-status.md`
  - `docs/fabric/evidence/2026-06-30-business-stream-and-failure-ledger.md`
  - dependency parity fix: `scripts/playwright-require.js`
- first AWS focused run failed with `Cannot find module './playwright-require'`.
- cause: the AWS working directory did not have the existing Playwright loader script that the new smoke imports.
- fix: copy `scripts/playwright-require.js` to AWS and rerun the same focused test.
- AWS focused after fix: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-real-server-profile-switch-smoke.test.js` -> `6/6 pass`
- hash parity after copy:
  - `scripts/playwright-require.js`: `4072f68974357d9d7d813aa0906b28751eafb9321f37301d1e99506f94c1fe8c`
  - `scripts/fabric-real-server-profile-switch-smoke.js`: `3dc4c5ed6ee43a4f6dd5c3c5c77d2baa7fbd09806b1366a7f8c29dc528a3083d`
  - `test/fabric-real-server-profile-switch-smoke.test.js`: `383526a96773a8508c7a1b03703f2a17e0d40b22c224dc6fb183a6568c07a55f`
  - `docs/fabric/08-current-status.md`: `db6e0d57452369b29d3115806cc895e9e91e75eb13a372c868ec793d3fc1e814`
  - `docs/fabric/evidence/2026-06-30-business-stream-and-failure-ledger.md`: `b11d18e1eb4999f6836081fd2a33ce347b82d3db66526b270f2207c19ff168a6`

Current business stream recheck after the profile smoke:

```bash
node "bin/ai-home.js" fabric closure audit \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --diagnostics-file "/tmp/aih-fabric-business-stream-closure-20260630-r2.json" \
  --json
```

Result:

- `ok=true`, `exitOk=true`
- `summary.status=usable_with_blockers`
- run: `40de8d5a-50e7-4d2b-b292-465d8a5d3685`
- session: `ses_0eb7b544dffe510apkKGkV4HDG`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_175422`
- events: `ready -> session-created -> delta -> result -> done`
- `eventCount=5`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- `failureLedger.externalPrerequisites=cloud-udp-policy,webtransport-h3-endpoint,multipath-underlay,provider-credentials`
- `failureLedger.summary.allExternal=true`

Current failure causes:

| Area | Current evidence | Root cause | Next action |
|---|---|---|---|
| Provider accounts | `codex=auth_invalid:upstream_401`, `claude=auth_invalid:claude_not_logged_in`, `agy=auth_invalid:agy_not_signed_in` | AWS-side credentials are present but not schedulable | Reauth/import on AWS only after explicit operator approval |
| Cloud edge UDP | remote UDP echo ready, local probe `udp_echo_timeout`, AWS `enp39s0` captured `0 packets`, host firewall does not block UDP | packets do not reach the instance public path | verify SG/NACL or provide a controlled TURN endpoint |
| AWS cloud API readback | remote `aws` CLI missing, remote IAM role missing, local `aws` CLI missing | AIH cannot inspect SG/NACL state read-only yet | attach read-only EC2 role or configure local read-only AWS CLI |
| WebTransport | browser has `WebTransport`, but handshake failed against `https://...:9527/v0/fabric/webtransport/echo`; transport config absent | default `9527` is a plain AIH HTTP listener, not HTTPS/H3 | configure a real HTTPS/H3 endpoint before promotion |
| Multipath/OMR | remote Linux MPTCP true, local macOS MPTCP false, `openMptcpRouterDetected=false`, listener `9527` is plain Node TCP/HTTP | no end-to-end MPTCP/OpenMPTCPRouter underlay | build a real dual-ended underlay before promotion |

Repeat prevention:

- Business closure must be checked first with the selected startable provider. Today that provider is `opencode`.
- A successful stream proof requires canonical events with marker and `done`; terminal echo is not proof.
- If `closurePlan.state=usable_with_external_blockers`, do not keep re-running the same session proof unless the selected provider or node status changed.
- Cloud-edge, WebTransport, and multipath failures above are stable external prerequisites, not unknown application timeouts.
- Do not run default UDP probes in parallel; they bind the same remote default port and can create artificial `probe_busy` failures.

## Productized Failure Ledger

The anti-loop evidence is now part of the machine-readable `closure audit` report, not only this Markdown file. `closure audit --diagnostics-file` writes:

- `failureLedger.businessClosure`: whether the selected provider path is usable.
- `failureLedger.streamProof`: canonical marker/done evidence.
- `failureLedger.failures[]`: each remaining blocker with `id`, `domain`, `owner`, `external`, `rootCause`, `nextAction`, `command`, and `repeatPrevention`.
- `failureLedger.repeatPrevention[]`: rules that prevent repeating known external failures as generic timeouts.

Real AWS verification:

```bash
node "bin/ai-home.js" fabric closure audit \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --diagnostics-file "/tmp/aih-fabric-failure-ledger-current-20260630.json" \
  --json
```

Result:

- `ok=true`, `exitOk=true`
- run: `cbae4349-eb00-4d10-98e4-2df9c2762c21`
- session: `ses_0eba12e3dffefLoagroBdJYWO9`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_171302`
- events: `ready -> session-created -> delta -> result -> done`
- `failureLedger.status=usable_with_recorded_failures`
- `failureLedger.businessClosure.usable=true`
- `failureLedger.streamProof.ok=true`
- `failureLedger.summary.total=7`
- `failureLedger.summary.external=7`
- `failureLedger.summary.allExternal=true`
- `failureLedger.immediateNextId=transport-cloud-edge-udp`

Recorded failure entries:

| Failure id | Domain | Owner | Root cause |
|---|---|---|---|
| `transport-cloud-edge-udp` | `transport_cloud_edge` | `cloud_operator` | AWS host firewall is not blocking UDP, but packets do not arrive at the instance. |
| `transport-cloud-api-readback` | `transport_cloud_edge` | `cloud_operator` | AWS CLI or read-only IAM role is required before AIH can inspect cloud policy. |
| `transport-webtransport-h3` | `transport_webtransport` | `network_operator` | Default `9527` is plain HTTP; WebTransport needs real HTTPS/H3. |
| `transport-multipath-underlay` | `transport_multipath` | `network_operator` | Multipath needs real dual-ended MPTCP/OpenMPTCPRouter evidence. |
| `provider-agy-blocked` | `provider_account` | `operator` | AWS-side AGY account is present but not schedulable. |
| `provider-claude-blocked` | `provider_account` | `operator` | AWS-side Claude account is present but not schedulable. |
| `provider-codex-blocked` | `provider_account` | `operator` | AWS-side Codex account is present but not schedulable. |

Final local-client verification after the null-report and misclassification fixes:

- diagnostics file: `/tmp/aih-fabric-failure-ledger-final-local-20260630.json`
- run: `1332fa23-8f24-4de3-bb73-6478ba56054d`
- session: `ses_0eb99e18fffexL5sroAh7pfK3q`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_172100`
- `ok=true`, `exitOk=true`
- `failureLedger.status=usable_with_recorded_failures`
- `failureLedger.summary.total=7`
- `failureLedger.summary.external=7`
- `failureLedger.summary.allExternal=true`
- `failureLedger.immediateNextId=transport-cloud-edge-udp`

Automation gate recheck:

- diagnostics file: `/tmp/aih-fabric-automation-gate-local-20260630.json`
- run: `75de523b-0b90-4023-9fc2-2196a249b54a`
- session: `ses_0eb9547f7ffe75gqe57GdZtdPH`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_172602`
- `selectedTransportKind=webrtc`, `fallbackUsed=false`
- `failureLedger.automation.state=awaiting_external_input`
- `failureLedger.automation.canContinueWithoutInput=false`
- `failureLedger.automation.nextAutomatable=null`
- `failureLedger.automation.runnableCount=0`
- `failureLedger.automation.operatorInputCount=7`
- `failureLedger.automation.externalOrConfirmationCount=7`
- `failureLedger.automation.placeholderCommandCount=0`
- `failureLedger.automation.blockedByProfileMissing=false`
- `failureLedger.summary.total=7`, `external=7`, `actionableByAih=0`, `allExternal=true`

AWS working-directory verification:

- Scoped files copied to `/home/ubuntu/aih-fabric-current`: `closure-audit.js`, `closure-plan.js`, `failure-ledger.js`, `test/fabric-closure-audit.test.js`, and this evidence/current-status documentation.
- Remote hash parity was verified for the three runtime/test files after copy.
- Remote focused test used the bundled runtime after the latest scoped sync: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js`.
- Remote focused result: `11/11 pass`.
- Running remote CLI from AWS without a local paired server profile now produces structured failureLedger output instead of crashing:
  - `failureLedger.status=blocked_with_recorded_failures`
  - `closurePlan.immediateNext.id=node-registry-pairing`
  - `closurePlan.nextQueue=node-registry-pairing,provider-opencode-unchecked,transport-default-blocked,session-marker-proof-blocked`
  - `provider-opencode-blocked=false`
  - root cause: the remote shell's client profile is not paired; this is a Server Setup/profile issue, not an `opencode` credential failure.

Real failures fixed during this pass:

| Failure | Cause | Fix | Regression |
|---|---|---|---|
| Remote CLI crashed with `Cannot read properties of null (reading 'result')` | `sessionStart` step failure returns `report=null`, but `extractRunId()` assumed an object. | Normalize nullable reports before reading `result`, events, or summary. | `fabric closure audit reports session start errors instead of crashing on null step reports` |
| Node registry missing was misreported as provider credential failure | Provider plan ran before node inventory was readable and synthesized `provider-opencode-blocked`. | When `summary.nodeReady=false`, selected provider becomes `provider-<name>-unchecked` with `ready_server_profile_missing`. | `fabric closure audit reports blocked instead of crashing when node inventory is unavailable` |

Latest stream smoke after the automation gate:

- diagnostics file: `/tmp/aih-fabric-webrtc-smoke-now-20260630.json`
- room: `rtc_pmC98aFKWK8zy6aU`
- `ok=true`
- DataChannel: `count=1`, `p95=323ms`
- RPC: `ok=true`, `responses=1`, `requestsHandled=1`, `p95=322.9ms`
- selected candidate pair: `srflx -> srflx`, `state=succeeded`, `nominated=true`

Operator failure observed during this pass:

- A local summary extraction command failed because a JavaScript template literal `${...}` was embedded in a double-quoted `node -e` command and zsh expanded it first.
- Repeat prevention: use single-quoted `node -e` scripts or plain string concatenation when extracting JSON summaries from diagnostics files.

## External Prerequisites Machine Grouping

`failureLedger` now includes `externalPrerequisites[]`, derived from the recorded `failures[]`. This keeps the remaining M6/provider prerequisites machine-readable for clients and CI without changing the closure result or pretending the blockers are automatable.

Real AWS verification:

```bash
node "bin/ai-home.js" fabric closure audit \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --diagnostics-file "/tmp/aih-fabric-external-prereq-local-20260630.json" \
  --json
```

Result:

- `ok=true`, `exitOk=true`
- run: `a0022037-95a9-4d8d-8351-e2b3b46d94a3`
- session: `ses_0eb8b2dd9ffeAYyWA7Sm6aD6pv`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_173704`
- `selectedTransportKind=webrtc`, `fallbackUsed=false`
- `failureLedger.automation.state=awaiting_external_input`
- `failureLedger.automation.canContinueWithoutInput=false`
- `failureLedger.automation.runnableCount=0`
- `failureLedger.summary.total=7`, `external=7`, `actionableByAih=0`, `allExternal=true`

External prerequisite groups:

| Prerequisite | Failure ids | Required evidence |
|---|---|---|
| `cloud-udp-policy` | `transport-cloud-edge-udp`, `transport-cloud-api-readback` | SG/NACL readback or controlled TURN/UDP path proving packets reach the node |
| `webtransport-h3-endpoint` | `transport-webtransport-h3` | Browser WebTransport handshake and stream/RPC smoke against HTTPS/H3 |
| `multipath-underlay` | `transport-multipath-underlay` | Dual-ended MPTCP/OpenMPTCPRouter evidence plus transport smoke |
| `provider-credentials` | `provider-agy-blocked`, `provider-claude-blocked`, `provider-codex-blocked` | Reauthenticated or replaced provider accounts on AWS, followed by provider account audit |

Verification after sync:

- Local focused: `node --test "test/fabric-closure-audit.test.js" "test/repository-policy.test.js"` -> `13/13 pass`.
- AWS focused: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js` -> `11/11 pass`.
- Hash parity after copy:
  - `failure-ledger.js`: `380c7cb24694a4b36fe4ef901e7e2fad87d33a2e42604581cdb5491afa958b5f`
  - `fabric-closure-audit.test.js`: `66cef8e31cf588ad4ea72ca8ac105d88f0939e8ec28d6267ec4b2c93af60f40c`

Failure recorded and fixed during this pass:

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| Focused test failed after adding `externalPrerequisites[]` | Test expected provider-first grouping, but implementation intentionally preserved closure `nextQueue` order: cloud edge, WebTransport, multipath, provider. | Updated the test expectation to match queue order; implementation unchanged. | Treat `externalPrerequisites[]` as a grouped view preserving closure queue order, not a provider-priority list. |

## Closure Verify Workflow Entry

`aih fabric closure verify` is now the product workflow entry for the sequence the operator actually needs: business closure first, then stream proof, then failure ledger and repeat-prevention. It reuses the existing `closure audit` implementation instead of duplicating the decision logic.

Command:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-20260630-r2.json" \
  --json
```

Result:

- `workflow=closure_verify`
- `ok=true`, `exitOk=true`
- `summary.status=usable_with_blockers`
- run: `d2a95f7c-a3c1-497d-9459-4d525f125ebd`
- session: `ses_0eb6ecdf7ffeie8cPsUENtd8Kq`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_180803`
- events: `ready -> session-created -> delta -> result -> done`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- `failureLedger.status=usable_with_recorded_failures`
- `failureLedger.summary.allExternal=true`
- `failureLedger.externalPrerequisites=cloud-udp-policy,webtransport-h3-endpoint,multipath-underlay,provider-credentials`
- `failureLedger.automation.state=awaiting_external_input`
- `failureLedger.automation.runnableCount=0`
- `failureLedger.automation.operatorInputCount=7`
- `failureLedger.automation.blockedByProfileMissing=false`

Failure recorded and fixed during this pass:

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| Diagnostics file missed `workflow=closure_verify` on the first verify run | `runFabricClosureVerifyCommand()` added workflow after `runFabricClosureAudit()` had already written the diagnostics file. | `runFabricClosureAudit()` now records `workflow`, and verify passes `workflow=closure_verify` before diagnostics are written. | Treat CLI JSON and diagnostics JSON as the same evidence surface; test the workflow field at command level. |
| Full `npm test` failed in `fabric node inventory blocks registered runtime when all provider accounts are unavailable` | The test still expected a registered runtime with zero schedulable accounts to report `runtimeStatus=available`, while the product behavior correctly degrades it to avoid misleading the node UI. | Updated the node inventory test expectation to `codex:degraded:provider_account_unavailable:codex` and asserted `start-session:codex.runtimeStatus=degraded`. | Provider account blockers must degrade action/runtime status; do not reintroduce `available` when `provider_account_unavailable:*` is present. |

Local verification:

- `node --test "test/fabric-closure-audit.test.js"` -> `13/13 pass`
- `node --test "test/fabric-node-inventory.test.js"` -> `3/3 pass`
- `node --test "test/fabric-closure-audit.test.js" "test/fabric-node-inventory.test.js" "test/repository-policy.test.js"` -> `18/18 pass`
- `node --test --test-reporter=tap --test-reporter-destination="/tmp/aih-npm-test-closure-verify-final-20260630.tap" test/*.test.js` -> `2879/2879 pass`
- AWS focused: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js test/fabric-node-inventory.test.js` -> `16/16 pass`
- Hash parity verified between local and `/home/ubuntu/aih-fabric-current` for the six scoped files.

## Closure Handoff Export

`closure verify` now supports `--handoff-file` so the handoff is a small
machine-readable artifact, not an implicit reading of the full diagnostics JSON
or this Markdown file. The handoff is a narrow projection from the existing
`failureLedger`, `summary`, and `sessionProof`; it does not duplicate closure
decision logic.

Command:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-handoff-20260630.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-20260630.json"
```

Real AWS result:

- diagnostics: `/tmp/aih-fabric-closure-verify-handoff-20260630.json` (`207676` bytes)
- handoff: `/tmp/aih-fabric-closure-handoff-20260630.json` (`14505` bytes)
- schema: `aih.fabric.closure-handoff.v1`
- `workflow=closure_verify`
- `ok=true`, `exitOk=true`
- `summary.status=usable_with_blockers`
- run: `7687011f-6fc3-48c4-ae6e-e010770f64ee`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_183325`
- events: `ready -> session-created -> delta -> result -> done`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- `businessClosureProven=true`
- `streamProofProven=true`
- `streamProofSkipped=false`
- `automationState=awaiting_external_input`
- `runnableCount=0`
- `operatorInputCount=7`
- `externalPrerequisites=cloud-udp-policy,webtransport-h3-endpoint,multipath-underlay,provider-credentials`
- handoff has no top-level `reports` and does not include `deviceToken`

Verification:

- `node --check "lib/cli/services/fabric/closure-audit.js"` -> pass
- `node --test "test/fabric-closure-audit.test.js"` -> `15/15 pass`
- `node --test "test/fabric-closure-audit.test.js" "test/fabric-node-inventory.test.js" "test/repository-policy.test.js"` -> `20/20 pass`
- `node --test --test-reporter=tap --test-reporter-destination="/tmp/aih-npm-test-closure-handoff-20260630.tap" test/*.test.js` -> `2881/2881 pass`
- AWS focused: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js test/fabric-node-inventory.test.js` -> `18/18 pass`
- Hash parity verified between local and `/home/ubuntu/aih-fabric-current`:
  - `lib/cli/services/fabric/closure-audit.js` -> `30aa5e8403a57f0849788670ef45aa846880913ef7a6287e0932559f5e3e2cfe`
  - `lib/cli/commands/fabric-router.js` -> `a012fdf841378a1339fc12fd09cf7f32af510375f300eca700229f6eb081126f`
  - `test/fabric-closure-audit.test.js` -> `2a75409783a0e8dcf6bcaf1fddeaa951a792129aef73b0aeb0a38aa46e635ce6`

Failure recorded and fixed during this pass:

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| Focused test failed after adding `--handoff-file` coverage | The new test passed `--poll-interval-ms 1`, but the real CLI parser enforces `100..60000`. | Updated the test to use the product minimum `100`; parser behavior unchanged. | Tests for CLI commands must honor real parser boundaries instead of loosening product validation for test convenience. |

## Anti-Loop Rules

1. Do not debug Codex/Claude/AGY as transport failures until their AWS-side provider accounts are reauthenticated or replaced.
2. Do not run UDP transport diagnostics in parallel. The default `9527` UDP probe binds the remote port and can produce artificial busy failures.
3. Do not repeat cloud-edge probes expecting a different result until SG/NACL/read-only AWS API credentials or a real TURN endpoint changes.
4. Do not call WebTransport blocked because of browser support unless `webTransportType` is missing. Current failure is server endpoint/handshake.
5. Do not promote multipath from remote Linux capability alone. It needs a real end-to-end MPTCP/OpenMPTCPRouter underlay.
6. Treat `bash: warning: setlocale: LC_ALL...` as benign unless it hides a non-zero command status.
7. Do not put JavaScript template literals inside a double-quoted `node -e` shell command; zsh can expand `${...}` before Node receives it.
8. Preserve closure `nextQueue` order when testing grouped prerequisites; group ids are a machine view over the queue, not a new prioritization model.
9. Browser smoke timeouts must capture page URL, localStorage profile state, body text, and console samples before being classified; do not leave them as opaque Playwright timeouts.
10. A one-time pair URL returning `410 Gone` after successful consumption is not itself a failed pairing if the paired profile and reload persistence proof are present.
11. `closure verify` is the default anti-loop entry before deep transport debugging; if it returns `usable_with_recorded_failures` and `runnableCount=0`, do not rerun session proof without changed external input.
12. `closure verify --handoff-file` is the default handoff artifact for continuing work; do not ask the next agent to infer state from a long diagnostics file unless the handoff itself is insufficient.
13. CLI command tests must use valid public option ranges; do not weaken parser validation to make a test faster.

## Next Action

The product is usable today on AWS current for:

- local client -> AWS server profile
- adding and switching multiple AWS server profiles in the WebUI
- AWS node inventory readback
- AWS project open capability
- AWS `opencode` session start
- WebRTC stream events
- relay fallback readiness
- SSH bootstrap metadata

Remaining real prerequisites:

1. Fix AWS provider credentials if Codex/Claude/AGY must become startable on the AWS node.
2. Verify AWS SG/NACL UDP `9527` or provide a controlled TURN endpoint.
3. Configure a real HTTPS/H3 WebTransport endpoint before promoting WebTransport.
4. Provide a real OpenMPTCPRouter/MPTCP underlay before promoting multipath.
