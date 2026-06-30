# 2026-06-30 Provider Credential Handoff

Goal: close the provider-credentials branch of the closure handoff as far as AIH
can proceed without operator secrets. This pass uses only AWS current on the
default `9527` endpoint.

Endpoint:

```bash
http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
```

## Real Provider Audit

Command:

```bash
node "bin/ai-home.js" fabric provider accounts audit \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --providers "codex,claude,agy,opencode" \
  --json
```

Result:

- `ok=true`
- `mode=remote-audit`
- `profileCount=13`
- `stateRows=13`
- `runtimeBlocked=12`
- `readyz.ready=true`
- `opencode`: `profileCount=1`, `runtimeBlocked=0`, `authMode=opencode-auth`
- `codex`: `profileCount=1`, `runtimeBlocked=1`, `authMode=api-key`, reason `auth_invalid:upstream_401`
- `claude`: `profileCount=4`, `runtimeBlocked=4`, `authMode=api-key`, reason `auth_invalid:claude_not_logged_in`
- `agy`: `profileCount=7`, `runtimeBlocked=7`, `authMode=oauth`, reason `auth_invalid:agy_not_signed_in`

## Real Reauth Classification

Codex:

```bash
node "bin/ai-home.js" fabric provider accounts reauth \
  --provider "codex" \
  --account-id "2" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --wait-auth-url-ms 8000 \
  --json
```

Result:

- `ok=false`
- HTTP `400`
- `result.code=api_key_reauth_unsupported`
- message: API Key accounts do not support reauth; update the key.

Claude:

```bash
node "bin/ai-home.js" fabric provider accounts reauth \
  --provider "claude" \
  --account-id "1" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --wait-auth-url-ms 8000 \
  --json
```

Result:

- `ok=false`
- HTTP `400`
- `result.code=api_key_reauth_unsupported`
- message: API Key accounts do not support reauth; update the key.

AGY:

```bash
node "bin/ai-home.js" fabric provider accounts reauth \
  --provider "agy" \
  --account-id "1" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --wait-auth-url-ms 8000 \
  --json
```

Result:

- `ok=true`
- `authMode=oauth-browser`
- `jobId=dc479493-48d0-4693-b721-e2bbf2b9665a`
- `authProgressState=awaiting_code`
- `verificationUri=https://accounts.google.com/o/oauth2/auth`
- `targetAccountId=1`
- `transientAccountId=8`

The job was queried through Fabric RPC:

```bash
node "bin/ai-home.js" fabric provider accounts auth-job get \
  --job-id "dc479493-48d0-4693-b721-e2bbf2b9665a" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `ok=true`
- `status=running`
- `authProgressState=awaiting_code`
- terminal log shows the Google OAuth URL and `authorization code...` prompt.

The job was cancelled after proof collection:

```bash
node "bin/ai-home.js" fabric provider accounts auth-job cancel \
  --job-id "dc479493-48d0-4693-b721-e2bbf2b9665a" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `ok=true`
- `status=cancelled`
- `authProgressState=cancelled`
- remote process check returned no `agy`, `antigravity`, or job id process.
- post-cancel audit stayed at `agy.profileCount=7`, `stateRows=7`, so the transient account was not left in the provider pool.

## Credential Handoff Output

`fabric provider accounts audit` now emits `credentialHandoff` from the real
audit data:

- `codex.action=update_api_key`
- `claude.action=update_api_key`
- `agy.action=complete_oauth_reauth`
- `opencode.action=none`
- `summary.ready=1`
- `summary.awaitingInput=3`

Human-readable output now includes:

```text
credential_handoff: awaiting_operator_input ready=1 awaiting_input=3
  - codex: update_api_key status=awaiting_operator_input
  - claude: update_api_key status=awaiting_operator_input
  - agy: complete_oauth_reauth status=awaiting_external_input
  - opencode: none status=ready
```

## Verification

- `node --check "lib/cli/services/fabric/provider-accounts.js"` -> pass
- `node --test "test/fabric-provider-accounts.test.js"` -> `13/13 pass`
- `node --test "test/fabric-provider-accounts.test.js" "test/fabric-closure-audit.test.js" "test/fabric-node-inventory.test.js"` -> `31/31 pass`
- AWS focused: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-provider-accounts.test.js test/fabric-closure-audit.test.js test/fabric-node-inventory.test.js` -> `31/31 pass`
- Hash parity verified between local and `/home/ubuntu/aih-fabric-current`:
  - `lib/cli/services/fabric/provider-accounts.js` -> `77e95295acd87066b5e8d4164e23f80e790bf7f5ab49d94351a82e367201f8c4`
  - `test/fabric-provider-accounts.test.js` -> `a531fef55e49e61e62889b8bfca3c3e6d17a341c6905680d6f4bb23489b7ff35`

## Failure Ledger

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| Codex/Claude provider blocker was previously represented as a generic reauth path | The closure plan saw a sample account id but did not know the account auth mode; real reauth returned `api_key_reauth_unsupported`. | `provider accounts audit` now emits credential handoff from `apiKeyMode/authModeCounts`, so API Key accounts point to key update instead of OAuth reauth. | Do not run `provider accounts reauth` for API Key accounts; update/replace the key, then run `provider accounts revalidate --yes`. |
| AGY could start reauth but still could not become schedulable | The remote auth job reached Google OAuth and waited for an authorization code, which requires operator input. | Verified `auth-job get` and `auth-job cancel` through Fabric RPC and confirmed no process/account residue. | Do not retry AGY sessions until the OAuth code is completed through `auth-job callback` or a fresh reauth flow. |

## Next Required Input

Provider credentials are now split by real auth mode:

1. Codex: update/replace AWS account `2` API key, then run provider revalidate.
2. Claude: update/replace AWS API keys, then run provider revalidate.
3. AGY: complete the Google OAuth authorization flow, then run provider revalidate.
4. OpenCode: no credential action required.

## Follow-up: Closure Plan Uses Audit Before Reauth

The real AWS node inventory exposes sample account ids in runtime diagnostics,
but it does not expose the provider auth mode. Only `fabric provider accounts
audit` has the `credentialHandoff` truth source that can distinguish API Key
accounts from OAuth accounts.

The closure plan previously used the sample account id to make `reauth` the
first provider blocker command. That was wrong for Codex and Claude API Key
accounts because real reauth returned `api_key_reauth_unsupported`.

The provider blocker queue now makes `provider accounts audit` the first
command and removes direct `reauth` from closure plan provider commands. The
audit output then provides the correct credential handoff:

- Codex: `update_api_key`
- Claude: `update_api_key`
- AGY: `complete_oauth_reauth`

Real AWS verification:

```bash
node "bin/ai-home.js" fabric closure audit \
  --node-id "aws-current-node" \
  --provider "codex" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --skip-session \
  --json > "/tmp/aih-fabric-closure-codex-audit-first-20260630.json"
```

Result:

- process status was non-zero because Codex is still blocked; the JSON report
  was valid and parsed.
- `ok=false`
- `exitOk=false`
- `immediateNext.id=provider-codex-blocked`
- `immediateNext.command=aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex --json`
- `providerCodexCommands`:
  - `aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex --json`
  - `aih fabric provider accounts revalidate --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex --yes --json`
  - `aih fabric closure audit --node-id aws-current-node --provider codex --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --skip-session --json`
- `hasReauth=false`

Verification:

- `node --check "lib/cli/services/fabric/closure-plan.js"` -> pass
- `node --test "test/fabric-closure-audit.test.js" "test/fabric-provider-accounts.test.js"` -> `28/28 pass`
- AWS focused: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js test/fabric-provider-accounts.test.js` -> `28/28 pass`
- Hash parity verified:
  - `lib/cli/services/fabric/closure-plan.js` -> `f4394c3b26751ea3f7d39a7df27e182ff9c57ab48d39e7a46e109e88658e0e2b`
  - `test/fabric-closure-audit.test.js` -> `b15013fe84250a66044a1c218790e70e651a82143692773f03d96d10aebe668a`

Final full closure verify after the audit-first queue change:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-final-queue-20260630.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-final-queue-20260630.json" \
  --json
```

Result:

- `businessClosureProven=true`
- `streamProofProven=true`
- `automationState=awaiting_external_input`
- `canContinueWithoutInput=false`
- `runnableCount=0`
- `operatorInputCount=7`
- real session run: `48e993f3-31c9-4afc-9449-8cdb81bca0a0`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_194727`
- events: `ready`, `session-created`, `delta`, `result`, `done`

All remaining failures are external and require confirmation:

| Failure | Command |
|---|---|
| `transport-cloud-edge-udp` | `aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| `transport-cloud-api-readback` | `aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| `transport-webtransport-h3` | `aih fabric transport webtransport --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| `transport-multipath-underlay` | `aih fabric transport prerequisites --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --node-id aws-current-node --json` |
| `provider-agy-blocked` | `aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers agy --json` |
| `provider-claude-blocked` | `aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers claude --json` |
| `provider-codex-blocked` | `aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex --json` |
