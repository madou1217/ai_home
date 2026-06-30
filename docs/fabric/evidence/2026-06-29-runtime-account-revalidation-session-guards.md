# 2026-06-29 Runtime Account Revalidation Session Guards

## Scope

- Target: AWS current only.
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Product port: `9527`
- Node id: `aws-current-node`
- AWS deployed head during test: `3c1067aa5d347b7bb220e067e1193c8add1f71ab`

No mock data was used. This test did not create a local account archive and did
not upload local provider credentials. It only cleared AWS runtime blocker
state, reloaded the already deployed AWS profiles, republished the registry, and
started real provider sessions against AWS.

## Code Change

`scripts/fabric-runtime-account-activation.js --remote-revalidate --yes` now:

1. reads AWS `account_state.db` through SSH;
2. clears clearable runtime blockers on AWS;
3. calls AWS management reload;
4. publishes the AWS runtime registry;
5. waits for runtime registry readback;
6. runs real `fabric session start` guards per provider;
7. retries transient `remote_transport_unavailable` session-start races;
8. continues through provider account pools until a marker is returned or every account is proven blocked;
9. treats only canonical `delta` / `result` / `done` marker output as validation, not terminal echo text.

## Local Verification

```text
node --check scripts/fabric-runtime-account-activation.js
node --test test/fabric-runtime-account-activation.test.js
```

Result:

- focused activation tests: `15/15 pass`

New coverage:

- `--remote-revalidate` requires explicit `--yes`;
- no account archive is created or copied during remote revalidation;
- transient `remote_transport_unavailable` is retried;
- runtime-blocked events override terminal-output marker false positives;
- provider account pools continue after a blocked account.

## Real AWS Revalidation Command

```text
node scripts/fabric-runtime-account-activation.js --remote-revalidate --yes --json
```

Top-level result:

- `ok=true`
- `mode=remote-revalidate`
- `localArchive=null`
- `remote=null`
- `runtimeBlockClear.cleared=5`
- `managementReload.ok=true`
- `managementReload.reloaded=13`
- `registryPublish.ok=true`
- `registryPublish.runtimes=4`
- `registryPublish.accounts=13`
- `readyz.ready=true`

The command first observed existing blockers from prior real attempts:

| Provider | Profiles | Pre-clear blocked | Pre-clear reason |
|---|---:|---:|---|
| codex | 1 | 1 | `auth_invalid:upstream_401` |
| claude | 4 | 2 | `auth_invalid:claude_not_logged_in` |
| agy | 7 | 2 | `auth_invalid:agy_not_signed_in` |
| opencode | 1 | 0 | none |

After blocker clear and reload, `postClearAudit.summary.runtimeBlocked=0`.

## Real Session Guard Results

| Provider | Accounts attempted | Validated | Final blocker |
|---|---:|---|---|
| codex | 1 / 1 | no | `auth_invalid:upstream_401` |
| claude | 4 / 4 | no | `auth_invalid:claude_not_logged_in` |
| agy | 7 / 7 | no | `auth_invalid:agy_not_signed_in` |
| opencode | 1 / 1 | yes | none |

Run evidence:

| Provider | Account ids | Run ids | Transport | Event result |
|---|---|---|---|---|
| codex | `2` | `cdc5bd36-2d6a-4835-8e03-efe74c102a0d` | relay fallback | runtime-blocked `upstream_401` |
| claude | `1,2,3,4` | `5959cb1e-a291-4477-bac0-7cfd58ec22d0`, `94e94dc0-bc95-47c7-b4d2-5018f8b6e32b`, `0fbd81e0-d980-4bfc-90e1-b8725a9b3727`, `b052506f-85ed-47bf-913f-aba685647977` | relay fallback then WebRTC | all runtime-blocked `claude_not_logged_in` |
| agy | `1,2,3,4,5,6,7` | `5bf16077-41b0-44be-95f7-cde3380474fb`, `043b395c-9b78-4cc7-8e44-7d3b6d112c31`, `e7054ddc-4653-4f01-84ce-d0e6311356d6`, `f44bd368-96bf-4307-b533-9bbabe165b2a`, `4dbe8b6b-f19f-4299-b416-cfac03dd8e10`, `2150c0e5-d655-42de-b542-5e2763f60413`, `d19337f2-e39a-4ead-aa3d-a67da58aded0` | WebRTC | all runtime-blocked `agy_not_signed_in` |
| opencode | `1` | `a8e4402f-6a5c-4474-896b-a29ed41fd184` | WebRTC | marker returned in canonical output |

Conclusion from the command:

```text
status=provider_session_validated
providersValidated=opencode
providersBlocked=codex,claude,agy
providersTransportUnavailable=[]
finalRuntimeBlocked=12
```

Final runtime blockers:

| Provider | Runtime blocked | Reason |
|---|---:|---|
| codex | 1 | `auth_invalid:upstream_401` |
| claude | 4 | `auth_invalid:claude_not_logged_in` |
| agy | 7 | `auth_invalid:agy_not_signed_in` |
| opencode | 0 | none |

## Node Readback

Command:

```text
node bin/ai-home.js fabric nodes aws-current-node
```

Result summary:

```text
http unauth=401 auth=200
registry nodes=2 relay_nodes=2 projects=2 runtimes=8 transports=3
transports=relay,webrtc online
runtimes=agy,claude,codex,opencode
open-project=enabled
configure-ssh=enabled
start-session:codex=blocked provider_account_unavailable:codex
start-session:claude=blocked provider_account_unavailable:claude
start-session:agy=blocked provider_account_unavailable:agy
start-session:opencode=enabled
```

## Transport Readback

Command:

```text
node bin/ai-home.js fabric transport status --node-id aws-current-node --json
```

Result summary:

```text
status=usable_partial
remoteDevelopmentReady=true
defaultTransport=relay
fallbackReady=true
relayMeasurementPass=true
advancedPromotionReady=false
cloudEdgeReady=false
udpReachable=false
packetArrivalCaptured=false
hostFirewallBlocksUdp=false
cloudApiCredentialsReady=false
```

Remaining external transport blockers:

- `webrtc:webrtc_not_promoted`
- `webrtc:turn_relay_gate_not_ready`
- `webtransport:webtransport_endpoint_not_configured`
- `webtransport:webtransport_not_promoted`
- `omr:openmptcprouter_not_detected`
- `mptcp:mptcp_data_plane_not_promoted`
- `turn_default_udp_9527_unreachable`
- `aws_public_udp_path_blocked`
- `aws_cli_missing`
- `aws_iam_role_missing`

## Product Conclusion

AWS current is connected, authorized, visible as a Fabric node, and can run real
remote sessions through AWS. The currently usable provider on AWS is
`opencode`. `codex`, `claude`, and `agy` are blocked by real runtime credential
state on AWS, not by node connectivity, registry visibility, SSH binding, or
Fabric transport routing.
