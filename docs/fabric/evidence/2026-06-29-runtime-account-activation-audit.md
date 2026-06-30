# 2026-06-29 Runtime Account Activation Audit

## Scope

- Target: AWS current only.
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Product port: `9527`
- Deployed AWS code after closure deploy: `3c1067aa5d347b7bb220e067e1193c8add1f71ab`
- Deployed source artifact sha256: `3253afab2d703e714f5b59cccf81d10e5051507563c9e8f1a3dfeb3cf012eb3b`
- Server pid after deploy: `390486`

This step added a read-only remote audit mode for runtime account activation. It does not create a local provider account archive, does not upload credentials, does not run import, and does not clear AWS runtime state.

## Command

```text
node scripts/fabric-runtime-account-activation.js --remote-audit --json
```

## Real AWS Result

Top-level result:

- `ok=true`
- `mode=remote-audit`
- `localArchive=null`
- `remote=null`
- `remoteAudit.readOnly=true`
- `readyz.ok=true`
- `readyz.ready=true`
- `readyz.accounts.codex=1`
- `readyz.accounts.claude=4`
- `readyz.accounts.agy=7`
- `readyz.accounts.opencode=1`

Remote audit target:

- `dbFile=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/account_state.db`
- `dbPresent=true`
- `deployedGitHead=3c1067aa5d347b7bb220e067e1193c8add1f71ab`

Summary:

- `providers=4`
- `profileCount=13`
- `stateRows=13`
- `configured=13`
- `runtimeBlocked=13`
- `clearableRuntimeBlocks=13`

Provider runtime blockers:

| Provider | Profiles | State rows | Configured | Auth mode | Runtime blocked | Clearable | Runtime reason |
|---|---:|---:|---:|---|---:|---:|---|
| codex | 1 | 1 | 1 | api-key | 1 | 1 | `auth_invalid:upstream_401` |
| claude | 4 | 4 | 4 | api-key | 4 | 4 | `auth_invalid:claude_not_logged_in` |
| agy | 7 | 7 | 7 | oauth | 7 | 7 | `auth_invalid:agy_not_signed_in` |
| opencode | 1 | 1 | 1 | opencode-auth | 1 | 1 | `auth_invalid:upstream_401` |

## Verification

Local code checks:

```text
node --check scripts/fabric-runtime-account-activation.js
node --test test/fabric-runtime-account-activation.test.js
npm test
```

Results:

- activation tests: `10/10 pass`
- full suite: `2809/2809 pass`
- whitespace check: `git diff --check -- scripts/fabric-runtime-account-activation.js test/fabric-runtime-account-activation.test.js` pass
- AWS focused activation tests after deploy: `10/10 pass`

AWS post-deploy readback:

- `/readyz ok=true ready=true`
- `/readyz accounts codex=1 claude=4 agy=7 opencode=1`
- `fabric nodes aws-current-node` returns `open-project: enabled` and `configure-ssh: enabled`
- `start-session:codex|claude|agy|opencode` remain blocked by provider runtime auth blockers
- `fabric transport status --node-id aws-current-node` returns `status=complete`, `remoteDevelopmentReady=true`, `defaultTransport=webrtc`, `fallbackReady=true`, `advancedPromotionReady=true`

## Product Conclusion

AWS current is connected and visible as a Fabric node, and its server has provider profiles configured. The remaining blocker for AWS-hosted provider sessions is runtime authentication state, not node connectivity or transport selection.

The next gate remains credential transfer/import to AWS current:

```text
node scripts/fabric-runtime-account-activation.js --remote-dry-run --yes
node scripts/fabric-runtime-account-activation.js --apply --yes
```

These commands transfer provider credentials from this machine to AWS and therefore require explicit human confirmation before execution.
