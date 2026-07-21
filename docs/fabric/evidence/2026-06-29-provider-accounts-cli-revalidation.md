# 2026-06-29 Provider accounts CLI revalidation

## Scope

- Target: AWS current only.
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Product port: `9527`
- Node id: `aws-current-node`
- Deployed code commit: `0974c85f16cb8d4899813e1c270888c7ea3c4c86`
- Clean archive sha256: `d26a7dca107975fca3421806d46e9877eb7d86f0d66640cfb8840e394d133441`

No mock data was used. The provider accounts commands did not create a local
account archive and did not upload local provider credentials.

## Product change

Added the official CLI:

```sh
aih fabric provider accounts audit --providers codex,claude,agy,opencode --json
aih fabric provider accounts revalidate --yes --providers codex,claude,agy,opencode --json
```

The `closurePlan` provider blockers now point to these commands before asking
operators to rerun closure audit. `revalidate` clears AWS runtime blockers,
reloads server accounts, republishes registry, and runs real session guards.

Two regressions were closed:

- Provider conclusion now keeps a provider blocked when earlier session attempts
  emitted `runtime-blocked`, even if the final pool attempt ends with no account.
- `registerFabricNode` preserves an existing active WebRTC promotion when a full
  registry publish omits `promotion`, while still allowing explicit
  `promotion: null` to clear it.

## Local verification

```sh
node --check scripts/fabric-runtime-account-activation.js
node --check lib/server/fabric-role-registry.js
node --test test/fabric-runtime-account-activation.test.js test/fabric-role-registry.test.js
node --test test/fabric-provider-accounts.test.js test/fabric-closure-audit.test.js
npm test
```

Result:

- Focused runtime/registry tests: `25/25 pass`
- Provider accounts + closure audit tests: `11/11 pass`
- Full suite: `2836/2836 pass`

## AWS deployment verification

Deployment used a clean `git archive HEAD`, not the dirty local worktree:

```text
local archive: /tmp/aih-fabric-source-0974c85.tar.gz
remote archive: /home/ubuntu/aih-fabric-current/source-0974c85.tar.gz
sha256: d26a7dca107975fca3421806d46e9877eb7d86f0d66640cfb8840e394d133441
DEPLOYED_GIT_HEAD: 0974c85f16cb8d4899813e1c270888c7ea3c4c86
server pid after restart: 414365
```

Remote focused checks on AWS:

```sh
node --check lib/cli/services/fabric/provider-accounts.js
node --check scripts/fabric-runtime-account-activation.js
node --check lib/server/fabric-role-registry.js
node --test test/fabric-provider-accounts.test.js test/fabric-closure-audit.test.js test/fabric-runtime-account-activation.test.js test/fabric-role-registry.test.js
```

Result:

- AWS syntax checks: pass
- AWS focused tests: `36/36 pass`
- AWS `/readyz`: `ok=true`, `ready=true`, accounts `codex=1`, `claude=4`,
  `agy=7`, `opencode=1`

## Real provider audit

Command:

```sh
node bin/ai-home.js fabric provider accounts audit --providers codex,claude,agy,opencode --json
```

Result:

- `mode=remote-audit`
- `localArchive=null`
- `remote=null`
- `remoteAudit.readOnly=true`
- `deployedGitHead=0974c85f16cb8d4899813e1c270888c7ea3c4c86`
- `profileCount=13`
- `stateRows=13`
- `runtimeBlocked=12`

Provider state:

| Provider | Profiles | Runtime blocked | Reason |
|---|---:|---:|---|
| codex | 1 | 1 | `auth_invalid:upstream_401` |
| claude | 4 | 4 | `auth_invalid:claude_not_logged_in` |
| agy | 7 | 7 | `auth_invalid:agy_not_signed_in` |
| opencode | 1 | 0 | healthy |

## Real provider revalidation

Command:

```sh
node bin/ai-home.js fabric provider accounts revalidate --yes --providers codex,claude,agy,opencode --json
```

Result:

- `mode=remote-revalidate`
- `localArchive=null`
- `remote=null`
- `runtimeBlockClear.cleared=12`
- `managementReload.ok=true`, `reloaded=13`
- `registryPublish.ok=true`, `runtimes=4`, `providers=agy,claude,codex,opencode`
- `postClearAudit.runtimeBlocked=0`
- `postSessionAudit.runtimeBlocked=12`
- `conclusion.status=provider_session_validated`
- `providersValidated=opencode`
- `providersBlocked=codex,claude,agy`
- `providersTransportUnavailable=[]`

Session guard evidence:

| Provider | Accounts attempted | Final run | Transport | Result |
|---|---:|---|---|---|
| codex | 1 | `8f1d5a8a-ac22-46ad-b65f-6ab6bd03517b` | relay fallback | runtime-blocked `upstream_401` |
| claude | 4 | `122728a5-51f4-4e49-847c-7dc0ae81b3eb` | WebRTC | all runtime-blocked `claude_not_logged_in` |
| agy | 7 | `d6ab24d6-6976-4301-9ca6-f4d0856331a2` | WebRTC | all runtime-blocked `agy_not_signed_in` |
| opencode | 1 | `42b1d675-ebf5-4099-b768-641bde6ee94f` | WebRTC | marker found |

## Promotion preservation proof

After the earlier pre-fix registry state had already lost WebRTC promotion, the
promotion gate was rerun and published:

```sh
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --allow-direct-webrtc-promotion \
  --skip-webtransport \
  --skip-multipath \
  --publish-promotion \
  --json
```

Result:

- `summary.promotionReady=true`
- `summary.defaultTransport=webrtc`
- `summary.promotedTransports=["webrtc"]`
- `publishPromotion.ok=true`
- WebRTC DataChannel p95: `533.3ms`
- WebRTC RPC p95: `336.1ms`

Then `provider accounts revalidate --yes --providers opencode --json` was run
again. It republished the registry and validated a real OpenCode marker:

- run: `3bb69745-8c44-464c-a5bb-06653b4d9930`
- transport: `webrtc`
- `fallbackUsed=false`
- `markerFound=true`
- `registryPublish.ok=true`

Post-revalidate closure audit still reported:

- `defaultTransport=webrtc`
- `advancedPromotionReady=true`
- `promotedTransports=["webrtc"]`

## Final closure audit

Command:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_PROVIDER_ACCOUNTS_CLOSURE_OK_20260629 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- `summary.status=usable_with_blockers`
- `coreReady=true`
- `capabilities.defaultTransport=webrtc`
- `advancedPromotionReady=true`
- `promotedTransports=["webrtc"]`
- `closurePlan.state=usable_with_external_blockers`
- `closurePlan.counts.done=4`
- `closurePlan.counts.blockedExternal=7`
- session run: `90b2e555-fb7a-4069-965d-9131c2fcf79c`
- marker: `AIH_PROVIDER_ACCOUNTS_CLOSURE_OK_20260629`
- `markerFound=true`
- `eventCount=4`

The session start path fell back from WebRTC to relay because the WebRTC session
adapter was closed at start time, but event polling used WebRTC successfully.
This does not demote the node: readiness and transport status still report
WebRTC as promoted/default, with relay fallback available.

## Remaining blockers

- Codex account: `auth_invalid:upstream_401`
- Claude accounts: `auth_invalid:claude_not_logged_in`
- AGY accounts: `auth_invalid:agy_not_signed_in`
- TURN/default UDP: packets to AWS UDP `9527` still do not arrive at the instance.
- AWS readback: AWS CLI missing and no read-only IAM role attached.
- WebTransport: no HTTPS/H3 endpoint on default `9527`.
- Multipath: no real OpenMPTCPRouter/MPTCP underlay promoted.
