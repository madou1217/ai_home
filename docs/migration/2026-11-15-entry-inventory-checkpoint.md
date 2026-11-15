# W0 entry inventory and dynamic node-RPC reconciliation — 2026-11-15

This is an evidence refresh against the current source, not a migration completion percentage. It complements, rather than overwrites, the other owner's `docs/product-integrity/entry-inventory-2026-11-15.json` snapshot.

## Authoritative scanner results

`go run ./cmd/route-entry-inventory --root .` read the Go AST and produced 864 registration candidates: 79 mux registrations, 420 WebUI constructors, and 365 derived public alias candidates. Four expressions remain unexpanded by the conservative scanner:

| Source expression | Manual reconciliation | Runtime boundary |
|---|---|---|
| `router.go:newRouter` → `route.Pattern` | Loops over the actual route constructor results. Many individual constructor patterns are recorded separately. | Source reachability/runtime dependencies still need per-leaf proof; do not count it as one missing feature or all routes verified. |
| `router.go:mountPublicManagementAliases` → `alias` | Applies `/v1/management/webui/` → `/v0/webui/`, excluding opt-outs and reserved collisions. | Scanner aliases are candidates; existence/permission/runtime state require direct observation. |
| `webui_noderpc_chat_legacy_routes.go` → `"GET " + noderpcapi.Prefix + op` | Seven current operations listed below under the direct management prefix. | Real isolated Go server observations below. |
| Same constructor → `"GET " + noderpcapi.WebUIPrefix + op` | Same seven operations under WebUI management, also producing public aliases. | Real isolated Go server observations below. |

The seven actual operations are `device-status`, `device-nodes`, `device-accounts`, `device-sessions`, `device-node-sessions`, `device-session-messages`, and `device-node-session-messages`. Their authoritative list is `nodeRPCOperations`; dispatch is `internal/transport/http/noderpcapi/handler.go`. This manual evidence does not change a mutable package slice into a falsely constant AST value.

`node scripts/collect-gateway-routes.js --json` still has asymmetric scope: Node252 endpoints / Go65 endpoints; only14 Node endpoint candidates enter its comparison. Zero missing in that subset is **not** proof of all management/WebUI/WS parity.

`go run ./cmd/route-ownership-manifest --check` passed. Generated contract consistency is distinct from live usability.

## Actual management-prefix traversal

Built and ran the complete `cmd/aih-server` at an independent loopback port, with fresh empty AIH_HOME/HOME and generated keys. It was a real production server with no accounts/private histories, not a stub. Traversed all seven operations at each prefix:

- `/v1/management/node-rpc/`
- `/v1/management/webui/node-rpc/`
- `/v0/webui/node-rpc/`

For each prefix, actual outcomes were identical:

| Request | Result |
|---|---|
| GET each of the five status/list operations | 200, `ok=true`, expected distinct `control_plane.device.*` RPC identifier |
| GET either message operation with explicitly nonexistent sessionRef | 404, `session_not_found` |
| GET device-status without Authorization | 401, `WWW-Authenticate: Bearer`, `unauthorized` |
| POST device-status with management auth | 405, `Allow: GET`, `method_not_allowed` |
| GET unknown-operation with management auth | 404, `rpc_not_found` |

30 actual HTTP operations total. No session payloads were accessed, no business mutation endpoint was invoked, no provider request was sent. Temporary process and directory were removed; shared9527 was not restarted or modified.

- Binary SHA-256: `30a214e9ade8e6015cc93fcd137de34c1fc54f63070864563e82a14432432643`.
- Ephemeral operator/result: `/tmp/aih-w0-noderpc-live-20261115.py`, `/tmp/aih-w0-noderpc-live-result-20261115.json`.
- Build: `go build -o /tmp/aih-w0-noderpc-server-20261115 ./cmd/aih-server` (exit0).

## Review / delivery boundary

This documentation-only checkpoint was self-reviewed against the current scanner JSON, source list/handler dispatch and all30 operator results. The current review capability failures and lack of returned peer verdicts are recorded in the preceding rollback-publication checkpoint; they are not independent approval here. The narrowly scoped documentation commit uses the same explicit self-review fallback. It does not introduce production code, tests, database changes or shared-service operations.

## Remaining inventory obligations

This verifies dispatch/auth/method/not-found and empty-state behavior for these21 dynamic route leaves. It does not prove real populated account/session/message semantics or browser journeys. All other CLI/HTTP/WS/native-hook/background/UI entries remain individually subject to the original W0–W6 acceptance gates. Scanner candidates, feature directories, provider capabilities and overlapping declarations must not be summed into a feature-completion rate. No shared generated inventory or peer-owned ledger was overwritten.
