# M4 Session Catalog Attach Contract Evidence

## Scope

M4 item 8.2 only: server/API contract for remote development session catalog and attach.

This does not claim AWS current end-to-end success. AWS current real smoke remains item 8.6.

## Changes Verified

- Added `lib/server/control-plane-device-session-catalog.js`.
- Added node routes:
  - `GET /v0/node-rpc/session-catalog`
  - `POST /v0/node-rpc/session-attach`
- Added scoped device-node routes:
  - `GET /v0/node-rpc/device-node-session-catalog`
  - `POST /v0/node-rpc/device-node-session-attach`
- Broker and relay allowlists include the new catalog/attach routes.
- Descriptor capability now advertises `remote-development-session`.

## Commands

```text
node --check lib/server/control-plane-device-session-catalog.js
node --check lib/server/node-rpc-router.js
node --check lib/cli/services/node/relay-client.js
node --test test/control-plane-device-session-catalog.test.js test/node-rpc-router.test.js test/fabric-broker-routing.test.js test/remote-relay-server.test.js test/node-relay-client.test.js
node --test test/control-plane-device-session-start.test.js test/server-node-rpc-wiring.test.js test/active-control-plane.test.js
git diff --check
```

## Results

```text
node --check lib/server/control-plane-device-session-catalog.js -> pass
node --check lib/server/node-rpc-router.js -> pass
node --check lib/cli/services/node/relay-client.js -> pass
catalog/router/broker/relay focused tests -> 82/82 pass
server/active-control-plane focused tests -> 26/26 pass
git diff --check -> pass
```

## Verdict

8.2 API contract is complete locally:

- catalog returns active run and snapshot-backed session summaries;
- attach returns `sessionId`, `status`, `cursor`, `snapshot`, and `allowedCommands`;
- device-node catalog/attach proxies through scoped bearer routes;
- relay client, relay server, and broker routing accept only the new allowlisted paths.

Next required item: 8.3 canonical command envelope.
