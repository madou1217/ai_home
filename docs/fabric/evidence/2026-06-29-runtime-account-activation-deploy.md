# 2026-06-29 Runtime Account Activation Deploy

## Scope

- Target: AWS current only.
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Product port: `9527`
- Commit deployed: `23b938975ed61c0431cf1f79f1775d36cc7ea8d2`
- Artifact: `/tmp/aih-fabric-source-23b9389.tar.gz`
- Artifact sha256: `e48c083710c07695c387d4938053db58f28ecc1ea041f2bfe4dcdc7387d63752`

This step deployed the account activation fix only. It did not transfer local provider credentials to AWS and did not clear remote runtime blocks because credential transfer still requires explicit human confirmation.

## Code Change

`scripts/fabric-runtime-account-activation.js --apply` now performs this sequence:

1. remote import dry-run
2. remote import apply
3. clear stale provider runtime blocks in AWS `account_state.db`
4. management reload
5. registry publish
6. registry readback wait

The runtime block clear step uses `createAccountStateIndex` and `createAccountStateService.clearRuntimeBlock(..., evidence: 'manual_admin_clear')`. It does not read or print provider credential material.

## Local Verification

```text
node --check scripts/fabric-runtime-account-activation.js
node --test test/fabric-runtime-account-activation.test.js
npm test
```

Results:

- focused activation tests: `8/8 pass`
- full suite: `2807/2807 pass`
- local preflight: generated a temporary export summary with `accounts=14`, `files=14`, `skipped=1`
- local preflight `remote=null`, proving default mode did not transfer credentials

## AWS Deployment Verification

Remote deployment used `git archive HEAD`, not the dirty worktree.

Remote checks:

```text
DEPLOYED_GIT_HEAD=23b938975ed61c0431cf1f79f1775d36cc7ea8d2
fabric-server.pid=388546
registry-agent MainPID=388812
readyz ok=true ready=true accounts codex=1 claude=4 agy=7 opencode=1
```

Remote tests:

```text
node --check scripts/fabric-runtime-account-activation.js
node --test test/fabric-runtime-account-activation.test.js
```

Result:

- AWS focused activation tests: `8/8 pass`
- Deployed source contains `buildRemoteRuntimeBlockClearCommand` and `runtime_block_clear` report output.

## AWS Node Readback

`node bin/ai-home.js fabric nodes aws-current-node`

Current facts:

- profile: `cp-51hq70`
- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- unauth registry read: HTTP `401`
- authorized registry read: HTTP `200`
- registry: `nodes=2 relay_nodes=2 projects=2 runtimes=8 transports=3`
- node: `aws-current-node`
- roles: `node, relay-node`
- capabilities: `project_host=yes runtime_host=yes ssh=yes measured=yes`
- transports: `relay, webrtc (online)`
- actions:
  - `open-project: enabled`
  - `configure-ssh: enabled`
  - `start-session:codex|claude|agy|opencode: blocked`

Runtime blockers remain real and unchanged because credentials were not transferred:

- codex: `runtime:auth_invalid:upstream_401=1`
- claude: `runtime:auth_invalid:claude_not_logged_in=4`
- agy: `runtime:auth_invalid:agy_not_signed_in=7`
- opencode: `runtime:auth_invalid:upstream_401=1`

## Transport Readback

`node bin/ai-home.js fabric transport status --node-id aws-current-node --json`

Summary:

- `status=complete`
- `remoteDevelopmentReady=true`
- `defaultTransport=webrtc`
- `fallbackReady=true`
- `relayMeasurementPass=true`
- `advancedPromotionReady=true`
- `promotedTransports=["webrtc"]`
- `cloudEdgeReady=false`

Remaining external transport blockers:

- `webtransport:webtransport_endpoint_not_configured`
- `webtransport:webtransport_not_promoted`
- `omr:openmptcprouter_not_detected`
- `mptcp:mptcp_data_plane_not_promoted`
- `turn_default_udp_9527_unreachable`
- `aws_public_udp_path_blocked`
- `aws_cli_missing`
- `aws_iam_role_missing`

## Session Guard

Real guard commands were run for all four providers:

```text
node bin/ai-home.js fabric session start aws-current-node --provider codex --prompt AIH_DEPLOY_GUARD_CODEX --json
node bin/ai-home.js fabric session start aws-current-node --provider claude --prompt AIH_DEPLOY_GUARD_CLAUDE --json
node bin/ai-home.js fabric session start aws-current-node --provider agy --prompt AIH_DEPLOY_GUARD_AGY --json
node bin/ai-home.js fabric session start aws-current-node --provider opencode --prompt AIH_DEPLOY_GUARD_OPENCODE --json
```

All four returned:

- `ok=false`
- `blocked=true`
- `registryAuthorizedStatus=200`
- `sessionStartStatus=0`
- no run created

Provider blockers:

- codex: `provider_account_unavailable:codex`
- claude: `provider_account_unavailable:claude`
- agy: `provider_account_unavailable:agy`
- opencode: `provider_account_unavailable:opencode`

## Next Gate

The next real closure step is credential transfer/import to AWS current:

```text
node scripts/fabric-runtime-account-activation.js --remote-dry-run --yes
node scripts/fabric-runtime-account-activation.js --apply --yes
```

This is intentionally not run in this evidence because it transfers provider credentials from this machine to AWS. It requires explicit human confirmation before execution.
