# 2026-06-29 Provider auth job RPC closure

## Scope

This closes the product gap left after remote provider reauth could start an
AWS-side OAuth job: local clients still had no protected Fabric CLI/RPC path to
query, cancel, or complete that job. The previous cleanup used a WebUI local job
route, which was useful operationally but was not the final Fabric product loop.

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

## Product change

Added protected paired-device RPC and CLI support for remote provider auth job
lifecycle:

```text
GET  /v0/node-rpc/device-provider-account-auth-job?jobId=...
POST /v0/node-rpc/device-provider-account-auth-job-cancel
POST /v0/node-rpc/device-provider-account-auth-job-callback

aih fabric provider accounts auth-job get|cancel|callback --job-id ID
```

The route uses the existing paired device bearer token and reuses the server's
`AuthJobManager`. It does not copy local credentials and does not print the raw
device token.

## Local verification

```text
node --test test/fabric-provider-accounts.test.js test/node-rpc-router.test.js
npm test
```

Results:

```text
focused: 68/68 pass
full npm test: 2865/2865 pass, duration_ms=169183.279
```

Scoped commit:

```text
e94c9b6b9b1dfca24811698ca3a76a20df10ea09
feat(fabric): manage remote provider auth jobs
```

Staged set before commit:

```text
M lib/cli/commands/fabric-router.js
M lib/cli/services/fabric/provider-accounts.js
M lib/server/node-rpc-router.js
M test/fabric-provider-accounts.test.js
M test/node-rpc-router.test.js
```

`git diff --cached --check` passed.

## AWS deployment

Artifact:

```text
local=/tmp/aih-fabric-head-e94c9b6.tar.gz
remote=/home/ubuntu/aih-fabric-current/source-e94c9b6.tar.gz
sha256=30ea40d01740c7b7a9ace31b0d4c77b7f285f937fc71924ea6525b6e539f78a2
remote sha256 readback=30ea40d01740c7b7a9ace31b0d4c77b7f285f937fc71924ea6525b6e539f78a2
DEPLOYED_GIT_HEAD=e94c9b6b9b1dfca24811698ca3a76a20df10ea09
```

Remote focused verification:

```text
node --test test/fabric-provider-accounts.test.js test/node-rpc-router.test.js
remote focused tests: 68/68 pass
```

AWS default `9527` restart:

```text
old node pid=475571
wrapper pid=478727
new node pid=478728
readyz.ok=true
readyz.ready=true
accounts=codex:1,gemini:0,claude:4,agy:7,opencode:1
```

Only the real node child remains:

```text
478728 /home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

## Real AGY auth-job lifecycle proof

Start remote reauth:

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
jobId=eca176e5-ee47-4cf6-99b7-fef5145f0969
status=running
authProgressState=awaiting_code
authorizationUrlPresent=true
verificationUri=https://accounts.google.com/o/oauth2/auth
redirectUri=https://antigravity.google/oauth-callback
blockers=[]
```

Query through the new Fabric auth-job RPC:

```text
node bin/ai-home.js fabric provider accounts auth-job get \
  --job-id eca176e5-ee47-4cf6-99b7-fef5145f0969 \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --json
```

Result summary:

```text
ok=true
mode=remote-auth-job
action=get
http.status=200
rpc=control_plane.device.provider_account_auth_job
job.id=eca176e5-ee47-4cf6-99b7-fef5145f0969
job.provider=agy
job.accountId=8
job.status=running
job.authProgressState=awaiting_code
job.pid=479114
authorizationUrlPresent=true
```

Cancel through the new Fabric auth-job RPC:

```text
node bin/ai-home.js fabric provider accounts auth-job cancel \
  --job-id eca176e5-ee47-4cf6-99b7-fef5145f0969 \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --json
```

Result summary:

```text
ok=true
mode=remote-auth-job
action=cancel
http.status=200
job.status=cancelled
job.authProgressState=cancelled
job.error=user cancelled oauth flow
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

The remaining AGY blocker is the real external login state: no operator OAuth
code was submitted. The Fabric job lifecycle itself now starts, reads, and
cancels through the same paired server profile.

## Real business stream proof

Command:

```text
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --diagnostics-file /tmp/aih-fabric-auth-job-e94c9b6-20260629.json \
  --json
```

Result summary:

```text
ok=true
status=usable_with_blockers
selectedTransportKind=webrtc
fallbackUsed=false
runId=9286dc96-84c0-4393-b6f1-1c62b0b2031f
sessionId=ses_0ec03fbbeffeiSwyN6jeQcab1U
completed=true
events=ready,session-created,delta,result,done
marker=AIH_FABRIC_CLOSURE_AUDIT_20260629_152507
```

This proves the currently usable path:

```text
local client -> paired AWS server profile -> aws-current-node -> opencode runtime -> WebRTC stream -> canonical done event
```

## Failure ledger

| Failure class | Current cause | Fix or next rule |
|---|---|---|
| Product loop gap | Remote `reauth` could start an OAuth job, but clients could not manage the job through Fabric RPC. | Fixed in `e94c9b6`; use `provider accounts auth-job get/cancel/callback`. |
| Slow local verification | Full `npm test` is real but slow; this run took about 169s and includes long WebUI model/project tests. | Run focused tests first; run full once per software commit, not repeatedly during AWS smoke. |
| Startup SSH hang | `nohup ... &` printed pid but SSH stayed open because the remote wrapper shell remained attached. | Confirm node child and `/readyz`, then kill only the wrapper pid. |
| Startup wrapper residue | Wrapper bash `478727` stayed after AWS restart. | Cleaned wrapper only; kept node pid `478728`. |
| Locale warning | Noninteractive AWS shell prints `setlocale: LC_ALL: cannot change locale (zh_CN.UTF-8)`. | Benign; do not treat as deploy failure. |
| Staging race in operator workflow | A status check was run in parallel with `git add`, making the first status output ambiguous. | Do dependent git staging/status steps serially. |
| JSON extraction path | First summary read `sessionStart/sessionEvents` at top level, but diagnostics store them under `reports.*`. | Use `reports.sessionStart` and `reports.sessionEvents` for closure diagnostics. |
| AGY provider availability | Reauth job reaches real Google OAuth but no authorization code was submitted. | Requires real AWS-side AGY login by an operator; do not retry AGY sessions until reauth completes. |
| Codex provider availability | AWS Codex account remains `auth_invalid:upstream_401`. | Requires real AWS-side account/key repair. |
| Claude provider availability | AWS Claude accounts remain `auth_invalid:claude_not_logged_in`. | Requires real AWS-side Claude login. |
| UDP/TURN | AWS host firewall is not blocking, but tcpdump still captures no UDP packets on `enp39s0`. | Verify SG/NACL or provide a controlled TURN/UDP path before rerunning promotion. |
| AWS API readback | AWS CLI/IAM readback is unavailable on node and local machine. | Attach read-only EC2 permissions or configure local AWS CLI read-only credentials. |
| WebTransport | Default `9527` is plain HTTP, not HTTPS/H3 WebTransport. | Provide a real HTTPS/H3 endpoint before WebTransport promotion. |
| Multipath | No real OpenMPTCPRouter/MPTCP underlay is detected. | Validate both ends of the multipath underlay before promotion. |
