# M4 8.3 Canonical Command Envelope Evidence

Date: 2026-06-28

## Scope

Implemented the M4 8.3 API contract for remote development session commands:

- `POST /v0/node-rpc/session-command`
- `POST /v0/node-rpc/device-node-session-command`

Canonical command types:

- `message`
- `slash`
- `approval_response`
- `stop`

The contract requires `sessionId` and `idempotencyKey` for every command. The ack includes `accepted`, `commandId`, `idempotencyKey`, `type`, `sessionId`, and `cursor` when available.

## Boundary

- `slash` is not allowed to carry `approvalId` or `promptId`.
- `approval_response` is a separate command type and carries `approvalId` plus `decision`.
- `stop` requires `scope=run` or `scope=session`.
- Existing lower-level run APIs remain available for internal compatibility, but new clients should use the canonical command envelope.
- Durable event replay, duplicate suppression, approval persistence, and artifact lanes are not claimed here; they remain M4 8.4 and 8.5.
- AWS current end-to-end provider command smoke is not claimed here; it remains M4 8.6.

## Changed Code

- `lib/server/control-plane-device-session-command.js`
  - Normalizes command envelopes.
  - Maps canonical commands to active run input/abort or public session ref input.
  - Filters forwarded payloads for device-node relay calls.
- `lib/server/node-rpc-router.js`
  - Adds local `session-command`.
  - Adds scoped remote `device-node-session-command`.
- `lib/server/control-plane-descriptor.js`
  - Advertises `session-command` and `device-node-session-command`.
- `lib/server/fabric-broker-router.js`
  - Allows broker proxy for `device-node-session-command`.
- `lib/server/remote/relay-server.js`
  - Allows relay management requests for `session-command`.
- `lib/cli/services/node/relay-client.js`
  - Allows outbound node local forwarding for `session-command`.

## Verification

Syntax checks:

```bash
node --check "lib/server/control-plane-device-session-command.js"
node --check "lib/server/node-rpc-router.js"
node --check "lib/server/remote/relay-server.js"
node --check "lib/cli/services/node/relay-client.js"
```

Focused tests:

```bash
node --test "test/control-plane-device-session-command.test.js" "test/control-plane-device-session-catalog.test.js" "test/node-rpc-router.test.js" "test/node-relay-client.test.js" "test/remote-relay-server.test.js" "test/fabric-broker-routing.test.js" "test/server-node-rpc-wiring.test.js"
```

Result:

```text
tests 102
pass 102
fail 0
```

Full repository test was also attempted:

```bash
npm test
```

Result:

```text
tests 2563
pass 2561
fail 2
```

The two failures are outside this M4 8.3 change:

- `test/web.provider-meta.test.js`: `provider meta returns stable labels and tag colors for archived session UI`
- `test/web.provider-meta.test.js`: `provider catalog keeps server and web provider ids aligned`

Both failed with:

```text
ERR_IMPORT_ATTRIBUTE_MISSING: Module "file:///Users/model/projects/feature/ai_home/lib/provider-catalog-data.json" needs an import attribute of "type: json"
```

## Interpretation

M4 8.3 is complete at the API contract and routing layer. The implementation proves the command envelope through local router tests, real in-process HTTP server wiring, real WebSocket broker proxy routing, and real relay request forwarding. It does not claim a full AWS provider conversation; that remains the explicit 8.6 gate.
