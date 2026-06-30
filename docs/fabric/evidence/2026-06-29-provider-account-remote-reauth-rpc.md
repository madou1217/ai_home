# 2026-06-29 Provider account remote reauth RPC

## Scope

- Target: AWS current only.
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Product port: `9527`
- Node id: `aws-current-node`
- Deployed source marker: `662de21378bd2a7b033baacfd1f000a140cbe05b+fabric-provider-reauth5`

No mock data was used. No local provider credentials were copied to AWS.
The test used the paired local server profile `cp-51hq70` and the real AWS
server node.

## Product change

Added a remote provider reauth path:

```sh
aih fabric provider accounts reauth --provider agy --account-id 1 --json
```

The CLI calls the paired server profile and the server exposes:

```text
POST /v0/node-rpc/device-provider-account-reauth
```

The node RPC handler reuses the WebUI reauth job manager. It does not duplicate
OAuth logic and does not expose raw device tokens in the CLI output.

Expected response fields:

- `targetAccountId`: original account being reauthorized.
- `transientAccountId`: temporary job account used for provider OAuth.
- `authorizationUrl` / `verificationUriComplete`: provider OAuth URL.
- `authProgressState`: current OAuth job state.

API-key accounts are intentionally rejected with `reauth_unsupported` and
`api_key_reauth_unsupported`; operators must update those keys directly.

## Cleanup fixes

Two real AWS failures were fixed before accepting the feature:

- SQLite `account_state.configured=1` is now read as true when building the
  pre-reauth state snapshot. Previously AGY account `1` could be restored as
  pending after cancel because numeric booleans fell through to `checkStatus`.
- PTY OAuth jobs now persist `_reauthTargetId`. AGY uses the PTY OAuth path, so
  cleanup previously knew the job was a reauth but did not know which target
  account to restore.
- Cleanup deletes the temporary profile by `provider + transient account id`
  instead of depending only on the job's `profileDir` field.

## Local verification

```sh
node --check lib/server/web-account-auth.js
node --check lib/server/web-ui-router.js
node --check lib/server/webui-account-routes.js
node --test test/web-account-auth.test.js test/web-ui-router.accounts.test.js test/node-rpc-router.test.js test/fabric-provider-accounts.test.js
```

Result:

- Syntax checks: pass.
- Focused tests: `154/154 pass`.

Earlier focused verification for the same feature also passed:

- `test/web-ui-router.accounts.test.js test/fabric-provider-accounts.test.js test/node-rpc-router.test.js`: `112/112 pass`.
- `test/fabric-provider-accounts.test.js test/node-rpc-router.test.js`: `61/61 pass`.

## AWS deployment verification

AWS server after deployment:

```text
DEPLOYED_GIT_HEAD=662de21378bd2a7b033baacfd1f000a140cbe05b+fabric-provider-reauth5
server pid=427144
readyz ok=true ready=true
accounts codex=1 claude=4 agy=7 opencode=1
```

Before the final reauth run, the AWS AGY baseline was restored with official
CLI and management API:

```text
deleted 1 agy account(s): 8
state-index upsert agy/1 -> configured=true apiKeyMode=false authMode=oauth status=up
```

Baseline proof:

```text
AGY profile dirs: 1 2 3 4 5 6 7
AGY state rows: 1..7 all configured=1 api_key_mode=0 auth_mode=oauth
fabric provider accounts audit --providers agy --json: profileCount=7 stateRows=7 configured=7
```

## Real remote reauth proof

Command:

```sh
node bin/ai-home.js fabric provider accounts reauth --provider agy --account-id 1 --json
```

Result:

```text
ok=true
mode=remote-reauth
profile.id=cp-51hq70
target.provider=agy
target.accountId=1
http.reauthStatus=200
rpc=control_plane.device.provider_account_reauth
result.jobId=276272cf-0bc9-48e2-be0b-9104a36ed7ca
result.targetAccountId=1
result.transientAccountId=8
result.authProgressState=awaiting_code
authorizationUrl present=true
verificationUriComplete present=true
```

The full OAuth URL is intentionally not copied into this evidence file.

Cancel command:

```sh
curl --noproxy '*' -fsS -X POST \
  http://127.0.0.1:9527/v0/webui/accounts/add/jobs/276272cf-0bc9-48e2-be0b-9104a36ed7ca/cancel
```

Cancel result:

```text
ok=true
job.status=cancelled
job.authProgressState=cancelled
job.accountId=8
job.reauth=true
```

Post-cancel cleanup proof:

```text
AGY profile dirs: 1 2 3 4 5 6 7
AGY state rows: 1..7 all configured=1 api_key_mode=0 auth_mode=oauth
readyz ok=true ready=true accounts agy=7
```

Remote audit after cleanup:

```text
profileCount=13
stateRows=13
configured=13
agy profileCount=7
agy stateRows=7
agy configured=7
agy authModeCounts oauth=7
opencode healthy=1
```

## Real session closure proof

Command:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_REAUTH_RPC_OK_20260629_R3 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --json
```

Result:

```text
ok=true
summary.status=usable_with_blockers
selectedTransportKind=webrtc
fallbackUsed=false
sessionProof.ok=true
sessionProof.runId=7afd0183-0ab5-48e3-8481-b0951e229985
sessionProof.markerFound=true
sessionProof.doneObserved=true
sessionProof.eventCount=5
closurePlan.state=usable_with_external_blockers
```

Remaining blockers are external or credential blockers:

- Codex: `auth_invalid:upstream_401`
- Claude: `claude_not_logged_in`
- AGY: `agy_not_signed_in`
- TURN/UDP: AWS public UDP path blocked on default `9527`
- WebTransport: no HTTPS/H3 endpoint configured
- Multipath: no real OpenMPTCPRouter/MPTCP underlay promoted
