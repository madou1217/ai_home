# 2026-06-29 M6 TURN relay CLI

## Scope

Productize the TURN relay-only WebRTC diagnostic as a Fabric command:

```bash
aih fabric transport turn-relay
```

The command separates configuration readiness from real relay probing:

- without TURN URL/username/credential, it reports a configuration blocker and
  does not launch a browser or fake a relay candidate;
- with complete TURN inputs, it runs real WebRTC DataChannel smoke with
  `iceTransportPolicy=relay` and `useDefaultStun=false`;
- it never prints raw TURN credentials in the report.

## Code paths

- `lib/cli/services/fabric/transport-turn-relay.js`
- `lib/cli/commands/fabric-router.js`
- `test/fabric-transport-turn-relay.test.js`

## Local code checks

```bash
node --check lib/cli/services/fabric/transport-turn-relay.js
node --check lib/cli/commands/fabric-router.js
node --check test/fabric-transport-turn-relay.test.js
```

Result: pass.

## Focused local tests

```bash
node --test \
  test/fabric-real-webrtc-datachannel-smoke.test.js \
  test/fabric-transport-turn-relay.test.js
```

Result: 15/15 pass.

Coverage:

- missing TURN config reports `turn_ice_server_not_configured`.
- missing config does not run WebRTC smoke.
- complete config runs relay-only WebRTC with `iceTransportPolicy=relay` and
  `useDefaultStun=false`.
- raw TURN credential is not serialized into the report.
- `--fail-on-blocked` returns non-zero while preserving `ok=true`.
- router emits JSON and honors the strict exit code.

## Full local test suite

```bash
npm test
```

Result: 2715/2715 pass.

## Real AWS current diagnostic without TURN config

Command:

```bash
node bin/ai-home.js fabric transport turn-relay \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

```json
{
  "ok": true,
  "mode": "fabric-turn-relay-diagnostics",
  "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
  "probe": null,
  "gate": {
    "ran": false,
    "candidateReady": false,
    "promotionReady": false,
    "configuration": {
      "allUrls": [],
      "turnUrls": [],
      "usernamePresent": false,
      "credentialPresent": false,
      "configured": false,
      "blockers": ["turn_ice_server_not_configured"]
    },
    "blockers": ["turn_ice_server_not_configured"]
  },
  "summary": {
    "candidateReady": false,
    "promotionReady": false,
    "blockers": ["turn_ice_server_not_configured"]
  },
  "exitOk": true
}
```

Interpretation:

- the current environment has no configured controlled TURN relay;
- no relay-only browser smoke was run because doing so without a TURN server
  would be fake;
- WebRTC cannot be promoted until this command is run with real TURN inputs and
  returns `promotionReady=true`.

## Fail-on-blocked gate

Command:

```bash
node bin/ai-home.js fabric transport turn-relay \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --fail-on-blocked \
  --json
```

Result:

- process status: `1`
- report `ok`: `true`
- report `exitOk`: `false`
- blockers: `["turn_ice_server_not_configured"]`

## AWS current deployment and remote verification

Artifact:

```text
201ac6f0dde5f86ff84cedc580bad9efb787174952d8d6844ac29bbbee3befa0  source-turn-relay-cli.tar.gz
```

Remote target:

```text
ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current
```

Remote checks:

```bash
node --check lib/cli/services/fabric/transport-turn-relay.js
node --check lib/cli/commands/fabric-router.js
node --check test/fabric-transport-turn-relay.test.js
node --test \
  test/fabric-real-webrtc-datachannel-smoke.test.js \
  test/fabric-transport-turn-relay.test.js
```

Result: 15/15 pass.

Remote default-port diagnostic:

```bash
node bin/ai-home.js fabric transport turn-relay \
  --endpoint "http://127.0.0.1:9527" \
  --json
```

Result:

- `probe=null`
- `gate.ran=false`
- `candidateReady=false`
- `promotionReady=false`
- blockers: `["turn_ice_server_not_configured"]`
- `transportConfig.present=false`
- `exitOk=true`

Remote strict gate:

```bash
node bin/ai-home.js fabric transport turn-relay \
  --endpoint "http://127.0.0.1:9527" \
  --fail-on-blocked \
  --json
```

Result:

- process status: `1`
- report `ok`: `true`
- report `exitOk`: `false`
- blockers: `["turn_ice_server_not_configured"]`

## Verdict

M6 11.3 now has a formal product CLI for TURN relay readiness. It does not
make WebRTC promotion pass; it proves the remaining blocker is the absence of a
real controlled TURN relay configuration.
