# 2026-06-29 Fabric blocker catalog and next queue

This evidence records a product closure improvement for Fabric diagnostics:

- `transport status` now returns machine-readable `summary.blockerDetails[]`.
- `transport status` now keeps `summary.nextActions[]` populated even when direct WebRTC is already promoted but external advanced-transport blockers remain.
- `closure audit` now returns `closurePlan.nextQueue[]` sorted by closure priority, with blocker details and repeatable commands.

No mock data was used for the final checks. All live checks targeted only AWS current:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- node id: `aws-current-node`
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- remote dir: `/home/ubuntu/aih-fabric-current`
- port: `9527`

## Local focused tests

```sh
node --check lib/cli/services/fabric/blocker-catalog.js
node --check lib/cli/services/fabric/closure-plan.js
node --check lib/cli/services/fabric/transport-status.js
node --test test/fabric-blocker-catalog.test.js test/fabric-transport-status.test.js test/fabric-closure-audit.test.js
```

Result:

- syntax checks: pass
- focused tests: `18/18 pass`

## Full test suite

Command:

```sh
npm test
```

Result:

- `2846/2846 pass`
- `fail=0`
- duration: `150902.12425ms`

## Real AWS transport status

Command:

```sh
node bin/ai-home.js fabric transport status --node-id aws-current-node --json
```

Result summary from the live AWS report:

- `status=complete`
- `remoteDevelopmentReady=true`
- `defaultTransport=webrtc`
- `fallbackReady=true`
- `advancedPromotionReady=true`
- `promotedTransports=["webrtc"]`
- `cloudEdgeReady=false`
- `udpReachable=false`
- `packetArrivalCaptured=false`
- `hostFirewallBlocksUdp=false`
- `cloudApiCredentialsReady=false`
- `securityGroupIds=["sg-01e33f3412fabfded","sg-01e7f50a205d7b308"]`

Real blockers remained:

- `webtransport:webtransport_endpoint_not_configured`
- `webtransport:webtransport_not_promoted`
- `omr:openmptcprouter_not_detected`
- `mptcp:mptcp_data_plane_not_promoted`
- `turn_default_udp_9527_unreachable`
- `aws_public_udp_path_blocked`
- `aws_cli_missing`
- `aws_iam_role_missing`

New structured details were present:

- `aws_public_udp_path_blocked -> domain=cloud_edge owner=cloud_operator command="aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json"`
- `aws_cli_missing -> domain=cloud_api owner=cloud_operator`
- `webtransport:webtransport_endpoint_not_configured -> domain=webtransport owner=network_operator`
- `omr:openmptcprouter_not_detected -> domain=multipath owner=network_operator`

`summary.nextActions[]` was no longer empty. It included:

- verify AWS Security Group and subnet NACL UDP rules
- attach read-only EC2 permissions or provide AWS API credentials outside AIH
- configure a real HTTPS/H3 WebTransport endpoint
- validate real OpenMPTCPRouter/MPTCP underlay

## Real AWS closure audit with session proof

Command:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_BLOCKER_CATALOG_REAL_20260629 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --json
```

Result summary:

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
- `closurePlan.counts.done=4`
- `closurePlan.counts.blockedExternal=7`
- `closurePlan.counts.unchecked=0`

Real session proof:

- run id: `d85f026a-ec23-4e0e-a5f9-8e125ab1d0c3`
- provider: `opencode`
- account id: `1`
- event count: `5`
- event types: `ready`, `session-created`, `delta`, `result`, `done`
- marker found: `AIH_BLOCKER_CATALOG_REAL_20260629`
- done observed: yes

`closurePlan.nextQueue[]` from the real report started with:

1. `transport-cloud-edge-udp` -> `cloud_operator` -> `aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json`
2. `transport-cloud-api-readback` -> `cloud_operator`
3. `transport-webtransport-h3` -> `network_operator`
4. `transport-multipath-underlay` -> `network_operator`
5. `provider-agy-blocked` -> `operator`
6. `provider-claude-blocked` -> `operator`
7. `provider-codex-blocked` -> `operator`

This is the intended priority after the selected `opencode` path is proven usable: fix cloud edge diagnostics and advanced transport prerequisites before treating non-selected provider logins as the next Fabric networking blocker.

## Real AWS skip-session readback

Command:

```sh
node bin/ai-home.js fabric closure audit --node-id aws-current-node --provider opencode --skip-session --json
```

Result:

- `closurePlan.state=needs_real_session_proof`
- `closurePlan.immediateNext.id=session-marker-proof-unchecked`
- `closurePlan.nextQueue[1].id=transport-cloud-edge-udp`
- provider blocker details use stable code `provider_account_unavailable`, not the provider name:
  - `provider_account_unavailable:agy -> code=provider_account_unavailable`
  - `provider_account_unavailable:claude -> code=provider_account_unavailable`
  - `provider_account_unavailable:codex -> code=provider_account_unavailable`

## Remaining blockers

The core selected-provider path is live:

- local client can read AWS registry through paired profile `cp-51hq70`
- AWS node is visible as `aws-current-node`
- `opencode` can start real sessions on AWS
- WebRTC is selected for session start/events, with relay fallback preserved

Remaining blockers are external or operator-owned:

- AWS UDP/public edge path for TURN/default UDP `9527`
- AWS CLI/IAM read-only cloud policy readback
- real HTTPS/H3 WebTransport endpoint
- real OpenMPTCPRouter/MPTCP underlay
- Codex/Claude/AGY AWS-side provider login state

## AWS deployment

The implementation commit `deb95179f8f12e3caff6baf1afb746ec074f6b0a` was deployed to AWS current using a clean `git archive HEAD` artifact, not the dirty local worktree.

Artifact:

- local archive: `/tmp/aih-fabric-head-deb9517.tar.gz`
- remote archive: `/home/ubuntu/aih-fabric-current/source-deb9517.tar.gz`
- sha256: `818a73c74038e3d2e083ab24e143aa689e1294bb1bf57b24750e21d7668f3c57`

Remote verification before restart:

```sh
cd /home/ubuntu/aih-fabric-current
sha256sum source-deb9517.tar.gz
tar -xzf source-deb9517.tar.gz
printf '%s\n' 'deb95179f8f12e3caff6baf1afb746ec074f6b0a' > DEPLOYED_GIT_HEAD
node --check lib/cli/services/fabric/blocker-catalog.js
node --check lib/cli/services/fabric/closure-plan.js
node --check lib/cli/services/fabric/transport-status.js
node --test test/fabric-blocker-catalog.test.js test/fabric-transport-status.test.js test/fabric-closure-audit.test.js
```

Result:

- remote syntax checks: pass
- remote focused tests: `18/18 pass`

The default `9527` server was restarted only on AWS current:

- old pid: `427144`
- new node pid: `431635`
- `DEPLOYED_GIT_HEAD=deb95179f8f12e3caff6baf1afb746ec074f6b0a`
- `/readyz ok=true ready=true`
- account counts: `codex=1`, `claude=4`, `agy=7`, `opencode=1`
- node env:
  - `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`
  - `HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`
  - `AIH_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home`
  - `AI_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home`

Post-deploy live checks:

- `fabric transport status --node-id aws-current-node --json`
  - `status=complete`
  - `defaultTransport=webrtc`
  - `advancedPromotionReady=true`
  - `blockerDetails[]` present
  - `nextActions[]` present
- `fabric closure audit --node-id aws-current-node --provider opencode --session-marker AIH_BLOCKER_CATALOG_DEPLOY_OK_20260629 --event-timeout-ms 60000 --session-timeout-ms 120000 --json`
  - run id: `15eb9c15-cc75-411b-8b9f-c4e8d7f6ccb3`
  - `summary.status=usable_with_blockers`
  - `coreReady=true`
  - `selectedTransportKind=webrtc`
  - `fallbackUsed=false`
  - marker found: `AIH_BLOCKER_CATALOG_DEPLOY_OK_20260629`
  - events: `5`
  - done observed: yes
