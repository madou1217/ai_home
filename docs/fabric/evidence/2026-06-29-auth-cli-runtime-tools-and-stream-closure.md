# 2026-06-29 Auth CLI runtime-tools and stream closure

## Scope

This closes the AWS reauth failure where `fabric provider accounts reauth`
could see AGY in runtime diagnostics but the remote Web auth job still failed
with `cli_not_found`.

Target:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remoteDir=/home/ubuntu/aih-fabric-current
nodeId=aws-current-node
port=9527
```

Only AWS current was used. The old `152.*`, `155.*`, and `39.104.*` servers
were not touched.

## Root cause

The provider runtime diagnostics used the app-local native CLI resolver, so it
could find:

```text
/home/ubuntu/aih-fabric-current/.runtime-tools/bin/agy
```

The Web auth job manager used the generic platform resolver. The server process
PATH did not include `.runtime-tools/bin`, so AGY reauth failed before it could
start the real OAuth flow:

```text
HTTP 500
code=cli_not_found
message=未找到 agy CLI，请先安装原生 CLI
```

The fix made Web auth jobs use the same native CLI resolver as runtime
diagnostics and passed the job process env/platform/cwd into the resolver. A
secondary resolver bug was also fixed: shell probes now receive the caller env,
so `command -v` no longer falls back to the host PATH after the caller supplied
a constrained env.

## Local verification

```text
node --check lib/server/web-account-auth.js
node --check lib/runtime/command-path.js
node --test test/command-path.test.js test/web-account-auth.test.js
node --test test/runtime.platform-runtime.test.js test/fabric-registry-agent.test.js test/fabric-provider-accounts.test.js test/repository-policy.test.js
npm test
```

Results:

```text
command-path + web-account-auth focused: 52/52 pass
runtime/fabric/repository focused: 34/34 pass
full npm test: 2861/2861 pass
```

Scoped commit:

```text
11f09c177636611aa32b75fb7f89c861a636e19b
fix(fabric): resolve auth cli from runtime tools
```

Staged set before commit:

```text
M lib/runtime/command-path.js
M lib/server/web-account-auth.js
M test/command-path.test.js
M test/web-account-auth.test.js
```

`git diff --cached --check` passed.

## AWS deployment

Artifact:

```text
local=/tmp/aih-fabric-head-11f09c1.tar.gz
remote=/home/ubuntu/aih-fabric-current/source-11f09c1.tar.gz
size=3353710
sha256=04ae1cb11636134f05a186f3485cff27ca0fa4746cb46dd6677a8dc1c78463e1
remote sha256 readback=04ae1cb11636134f05a186f3485cff27ca0fa4746cb46dd6677a8dc1c78463e1
DEPLOYED_GIT_HEAD=11f09c177636611aa32b75fb7f89c861a636e19b
```

Remote focused verification:

```text
node --test test/command-path.test.js test/web-account-auth.test.js test/fabric-registry-agent.test.js test/fabric-provider-accounts.test.js
remote focused tests: 75/75 pass
```

AWS default `9527` restart:

```text
old node pid=470602
new node pid=475571
readyz.ok=true
readyz.ready=true
accounts=codex:1,gemini:0,claude:4,agy:7,opencode:1
```

Only the real node child remains:

```text
475571 ./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

## Real AGY reauth proof

Command:

```text
node bin/ai-home.js fabric provider accounts reauth \
  --provider agy \
  --account-id 1 \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --wait-auth-url-ms 8000 \
  --json
```

Result summary:

```text
ok=true
mode=remote-reauth
http.reauthStatus=200
provider=agy
targetAccountId=1
transientAccountId=8
jobId=89c9f309-8156-4aa1-acfb-c281525caaa1
status=running
authProgressState=awaiting_code
authorizationUrlPresent=true
verificationUri=https://accounts.google.com/o/oauth2/auth
redirectUri=https://antigravity.google/oauth-callback
blockers=[]
```

This proves the old `cli_not_found` failure is closed. The job reached the real
Google OAuth flow and waited for an operator-provided authorization code.

Cleanup:

```text
POST /v0/webui/accounts/add/jobs/89c9f309-8156-4aa1-acfb-c281525caaa1/cancel
ok=true
job.status=cancelled
job.authProgressState=cancelled
```

Post-cleanup checks:

```text
agy/antigravity process leftovers=none
AGY audit profileCount=7
AGY audit stateRows=7
AGY audit configured=7
AGY audit runtimeBlocked=7
AGY audit reason=auth_invalid:agy_not_signed_in
```

The remaining AGY blocker is now the real external login state, not a missing
CLI path.

## Real business stream proof

Command:

```text
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --diagnostics-file /tmp/aih-fabric-closure-11f09c1-20260629.json \
  --json
```

Result summary:

```text
ok=true
exitOk=true
status=usable_with_blockers
coreReady=true
sessionReady=true
selectedTransportKind=webrtc
fallbackUsed=false
runId=53e27797-89b6-43da-a87d-0b07334cf71a
sessionId=ses_0ec19876dffexm1lGesO7sLJA6
events=ready,session-created,delta,result,done
marker=AIH_FABRIC_CLOSURE_AUDIT_20260629_150135
```

This proves the current usable path:

```text
local client -> paired AWS server profile -> aws-current-node -> opencode runtime -> WebRTC stream -> canonical done event
```

## Failure ledger

| Failure class | Current cause | Fix or next rule |
|---|---|---|
| AGY reauth `cli_not_found` | Web auth jobs used generic PATH-only CLI resolution while runtime diagnostics used app-local resolution. | Fixed in `11f09c1`; Web auth jobs now use `resolveNativeCliPath`. |
| Resolver env leak | `command-path` passed caller env to PATH scan but not to `where`/`command -v` probes. | Fixed in `11f09c1`; shell probes receive the same env. |
| Artifact hash race | A local one-off `git archive` and `shasum` were run in parallel; shasum first saw an empty file hash. | Do not parallelize archive creation and checksum; verified final sha256 separately before upload. |
| AWS startup wrapper | `nohup ... &` left a remote wrapper bash before cleanup. | Kill only the wrapper pid after confirming the node child and `/readyz`; kept node pid `475571`. |
| JSON extraction path | First local summary command read `sessionEvents` at the wrong top-level path. | Use `reports.sessionEvents.result.events` or `sessionProof` in future extraction. |
| AGY account availability | Reauth now starts correctly, but no operator OAuth code was submitted. | Requires real AWS-side AGY login; do not rerun sessions for AGY until reauth completes. |
| Codex account availability | AWS Codex account `2` remains `auth_invalid:upstream_401`. | Requires real AWS-side key/account update. |
| Claude account availability | AWS Claude accounts remain `auth_invalid:claude_not_logged_in`. | Requires real AWS-side login/update. |
| UDP/TURN | UDP packets still do not arrive at AWS `enp39s0`; host firewall is not blocking. | Verify SG/NACL or provide controlled TURN; do not solve with app retries. |
| Cloud API readback | AWS CLI/IAM read-only access is missing on the node/local machine. | Provide read-only AWS API access before claiming SG/NACL inspection. |
| WebTransport | Default `9527` is plain HTTP, not HTTPS/H3. | Provide a real HTTPS/H3 WebTransport endpoint. |
| Multipath | No real OpenMPTCPRouter/MPTCP underlay is present. | Provide and validate the underlay before promotion. |

## Current blockers

The latest closure audit still reports software-side usable status with real
external blockers:

```text
status=usable_with_blockers
externalBlockers=webtransport:webtransport_endpoint_not_configured,
  webtransport:webtransport_not_promoted,
  omr:openmptcprouter_not_detected,
  mptcp:mptcp_data_plane_not_promoted,
  turn_default_udp_9527_unreachable,
  aws_public_udp_path_blocked,
  aws_cli_missing,
  aws_iam_role_missing,
  aws_local_cli_missing,
  agy:provider_account_unavailable:agy,
  claude:provider_account_unavailable:claude,
  codex:provider_account_unavailable:codex
```

Conclusion: the product path is usable today through `opencode` on AWS current
with WebRTC streaming. The remaining work needs real external provider login,
AWS network/IAM inputs, HTTPS/H3 WebTransport, or a real multipath underlay.
