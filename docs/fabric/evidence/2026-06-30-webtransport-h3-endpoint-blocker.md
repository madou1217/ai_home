# 2026-06-30 WebTransport H3 Endpoint Blocker

Goal: close the WebTransport failure classification loop for AWS current. The
previous product output said only `webtransport_connect_failed`, which was true
but not actionable enough. This pass proves that the browser environment is
ready, while the AWS default `9527` endpoint is still not a real HTTPS/H3
WebTransport endpoint.

Only AWS current was used:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- ssh: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: `9527`

## Real WebTransport Probe

Command:

```bash
node "bin/ai-home.js" fabric transport webtransport \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `ok=true`
- `browserChannel=chrome`
- `pageUrl=https://example.com/`
- `webTransportUrl=https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo`
- `probe.isSecureContext=true`
- `probe.webTransportType=function`
- `probe.failureReason=webtransport_connect_failed`
- browser error: `WebTransportError: Opening handshake failed.`
- `summary.candidateReady=false`
- `summary.promotionReady=false`
- `summary.blockers=webtransport_connect_failed,webtransport_h3_endpoint_missing`

Interpretation:

- This is not a browser capability failure.
- This is not an insecure-page failure.
- The missing piece is the server-side HTTPS/H3 WebTransport endpoint.

## Real Prerequisite Audit

Command:

```bash
node "bin/ai-home.js" fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `ok=true`
- `target.nodeId=aws-current-node`
- `target.port=9527`
- `baseReady=true`
- AWS base gate:
  - `server.readyzHttp=200`
  - `processCount=1`
  - supervisor relay, registry agent, and webrtc services all `running`
  - registry has `nodes=2`, `relayNodes=2`, `projects=2`, `runtimes=8`, `transports=3`, `nodeInventory=2`
- `promotionReady=false`
- summary blockers:
  - `turn:turn_ice_server_not_configured`
  - `turn:turn_default_udp_9527_unreachable`
  - `webtransport:webtransport_connect_failed`
  - `webtransport:webtransport_h3_endpoint_missing`
  - `multipath:local_mptcp_unavailable`
  - `multipath:openmptcprouter_not_detected`
  - `multipath:default_listener_is_plain_http_not_multipath_transport`

The TURN UDP evidence stayed consistent with the previous cloud-edge diagnosis:
remote UDP echo was ready, AWS host firewall was not blocking, but tcpdump saw
`0 packets captured` and the local UDP probe timed out.

## Code Change

`classifyWebTransport()` now adds a second blocker when all of these are true:

- `failureReason === webtransport_connect_failed`
- `isSecureContext === true`
- `webTransportType === function`

The second blocker is `webtransport_h3_endpoint_missing`. It keeps the original
low-level failure while adding the actionable product cause.

## Verification

Local:

```bash
node --check "scripts/fabric-m6-promotion-gate.js"
node --test \
  "test/fabric-transport-webtransport.test.js" \
  "test/fabric-m6-prerequisite-audit.test.js" \
  "test/fabric-m6-promotion-gate.test.js"
```

Result:

- syntax check: pass
- focused tests: `39/39 pass`

AWS current focused tests:

```bash
ssh -i "${HOME}/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-transport-webtransport.test.js test/fabric-m6-prerequisite-audit.test.js test/fabric-m6-promotion-gate.test.js"
```

Result:

- focused tests: `39/39 pass`
- AWS locale warning was non-fatal and exit code was `0`.

Hash parity between local and AWS current:

| File | SHA-256 |
|---|---|
| `scripts/fabric-m6-promotion-gate.js` | `365ab37b82670b6c0fc340aee2ce819591304656917c181a877260bdbed1910c` |
| `test/fabric-transport-webtransport.test.js` | `0847d18e7d65277cf22a4712972660b729205851e73f04f8069b6af8e2533075` |
| `test/fabric-m6-prerequisite-audit.test.js` | `66e2eb2ce2ea4e023c29f47912db881ddefb5d6eaf9f66ffef183f19d62442c6` |
| `test/fabric-m6-promotion-gate.test.js` | `2b1635b4b88bbc51a9de501292cda957a730009d8b5240909d796b3e5b086964` |

## Business Closure and Stream Recheck

After the WebTransport classification fix, the product closure workflow was
run again to avoid treating a transport prerequisite as an unverified business
loop.

Command:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-webtransport-h3-20260630.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-webtransport-h3-20260630.json" \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- `workflow=closure_verify`
- `conclusion.status=usable_with_recorded_failures`
- `businessClosureProven=true`
- `streamProofProven=true`
- `automationState=awaiting_external_input`
- `runnableCount=0`
- `operatorInputCount=7`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- real session run: `85f4630c-4a57-4bde-bdff-5237afce8079`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_191413`
- events: `ready`, `session-created`, `delta`, `result`, `done`
- `markerFound=true`
- `doneObserved=true`

The closure handoff groups the remaining work into four external prerequisites:

- `cloud-udp-policy`
- `webtransport-h3-endpoint`
- `multipath-underlay`
- `provider-credentials`

This confirms that repeating the same business session is not the next step.
The next useful work is to satisfy one of the external prerequisites and then
rerun the relevant gate.

## Failure Ledger

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| WebTransport diagnostics only said `webtransport_connect_failed` | The classifier preserved the browser handshake failure but did not translate a secure-context/API-present handshake failure into a product prerequisite. | Add `webtransport_h3_endpoint_missing` while preserving `webtransport_connect_failed`. | Do not retry WebTransport as an unknown timeout when `isSecureContext=true` and `WebTransport` exists; require a real HTTPS/H3 WebTransport endpoint first. |
| Prerequisite audit did not show the actionable WebTransport blocker in the aggregate summary | The aggregate gate reused the old single blocker. | Update prerequisite and promotion-gate expectations to require both blockers. | Focused tests now assert `webtransport_h3_endpoint_missing` in WebTransport command, prerequisite audit, and M6 promotion gate. |
| Same business closure loop could be rerun after the transport diagnosis | The transport blocker was external, but without a fresh closure handoff it could look like the product was still waiting on a session proof. | Run `fabric closure verify` again and write diagnostics plus handoff files. | Stop repeating closure/session smoke while `runnableCount=0` and `automationState=awaiting_external_input`; pick one external prerequisite instead. |

## Remaining Required Input

WebTransport promotion still requires an approved product topology that serves
real HTTPS/H3 WebTransport on the target endpoint. Under the current default
`9527` server, the AIH HTTP listener is reachable, but it is not an H3
WebTransport listener.

## Follow-up: Closure Handoff Canonical Blocker

The transport probe and prerequisite audit already reported
`webtransport_h3_endpoint_missing`, but `closure verify` still received older
readiness blockers from transport status:

- `webtransport:webtransport_endpoint_not_configured`
- `webtransport:webtransport_not_promoted`

That made the same product prerequisite appear under multiple blocker names.
The closure plan now canonicalizes this specific WebTransport prerequisite at
the plan/handoff layer:

```text
webtransport:webtransport_h3_endpoint_missing
```

The readiness report remains unchanged as source evidence; the closure plan is
the product handoff surface and now exposes the actionable H3 prerequisite.

Real AWS closure verification after the canonicalization:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-h3-canonical-20260630.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-h3-canonical-20260630.json" \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- real session run: `3c79192c-015d-40e3-8bb4-e423104b9eae`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_192428`
- events: `ready`, `session-created`, `delta`, `result`, `done`
- `businessClosureProven=true`
- `streamProofProven=true`
- `automationState=awaiting_external_input`
- `runnableCount=0`
- `closurePlan.nextQueue[transport-webtransport-h3].blockers=["webtransport:webtransport_h3_endpoint_missing"]`
- `handoff.externalPrerequisites[webtransport-h3-endpoint].blockers=["webtransport:webtransport_h3_endpoint_missing"]`

Additional verification:

- `node --check "lib/cli/services/fabric/closure-plan.js"` -> pass
- `node --test "test/fabric-closure-audit.test.js" "test/fabric-blocker-catalog.test.js"` -> `20/20 pass`
- AWS focused: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js test/fabric-blocker-catalog.test.js` -> `20/20 pass`
- Hash parity verified:
  - `lib/cli/services/fabric/closure-plan.js` -> `23f8a95b27b5dc0046c8c9a01236f334fe8a6916c66f73dcc6dc68bd71d7c4b6`
  - `test/fabric-closure-audit.test.js` -> `8801980a1eb5a65420f00a3b28596c889496ded34d996621dd61b846e12f5a57`

## Follow-up: External Transport Requires Confirmation

The closure queue already marked transport prerequisites as
`blocked_external`, but the public queue item still had
`requiresConfirmation=false` while its `blockerDetails[]` said the same item
requires operator confirmation. That mismatch could make automation treat an
external network prerequisite as a normal retry candidate.

The closure plan now sets `requiresConfirmation=true` for all external
transport prerequisites:

- `transport-cloud-edge-udp`
- `transport-cloud-api-readback`
- `transport-webtransport-h3`
- `transport-multipath-underlay`

Real AWS closure verification:

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-external-confirmation-20260630.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-external-confirmation-20260630.json" \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- real session run: `ca9a3014-360c-4175-ab67-e0ab2cbafce7`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260629_193159`
- events: `ready`, `session-created`, `delta`, `result`, `done`
- `businessClosureProven=true`
- `streamProofProven=true`
- `automationState=awaiting_external_input`
- `runnableCount=0`
- all four transport failures listed above have:
  - `external=true`
  - `requiresConfirmation=true`

Verification:

- `node --check "lib/cli/services/fabric/closure-plan.js"` -> pass
- `node --test "test/fabric-closure-audit.test.js"` -> `15/15 pass`
- AWS focused: `./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js` -> `15/15 pass`
- Hash parity verified:
  - `lib/cli/services/fabric/closure-plan.js` -> `c7bf94ef1dc34d1893cf3a29dd8706e251156b76c2c653e03e4993ec13153ec5`
  - `test/fabric-closure-audit.test.js` -> `f70fb5aca95d891090b6f2143aaa5bde31d5e2dec940a8810a71137bea6cba7f`
