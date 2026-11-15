# WebUI management dependency checkpoint — 2026-11-15

## Why this is a separate commit

An exported committed HEAD `e1d1dbdd7` failed `go build ./cmd/aih-server`: the already-committed host route registration referenced `webuimanagementapi.PublicPrefix`, but that declaration existed only in the shared dirty handler. A successful build in the full shared working tree had hidden the missing committed dependency.

The minimum reviewed closure is three existing modified source files:

- `internal/transport/http/webuimanagementapi/handler.go`
- `internal/transport/http/webuiauth/gate.go`
- `internal/transport/http/webuiauth/require.go`

The handler normalizes public prefixes only at path-segment boundaries; its local-management exception requires the private context marker supplied by the auth adapter. The auth adapter preserves configured-key Bearer checks, rejects forwarded requests from the local-only exceptions, and carries the authorization source without trusting an HTTP header as that marker. This checkpoint does not add router registrations or relax configured-key management access.

## Fresh verification

Exported HEAD with `git archive` to an isolated directory and overlaid only these three source paths (no branch/worktree creation):

- `go build -mod=readonly ./...`: exit 0.
- Native `cmd/aih-server` build: exit 0.
- `go vet` of all non-test Go sources in the auth and management-handler packages: exit 0.
- Actual isolated Go Server, synthetic distinct keys, empty temporary HOME/state, ephemeral loopback port: public management status rejects absent/wrong credentials (401), accepts its configured key (200), and the canonical status endpoint accepts the same key (200).
- Bootstrap with a configured key returns 200; a remote Host or any of seven forwarding/remote-server headers without credentials returns 401. Response bodies/keys were not logged.
- The isolated process shut down with exit 0. Shared port 9527 retained PID 7485 throughout this verification. No shared database, configuration, installed binary or service was changed.

## Review capability and limits

The original three review sidecars were reused; their existing contexts subsequently exhausted the model window. No replacement agent was created. Following the repository's review-capability chain, this narrow checkpoint uses a documented `self_review` bypass rather than claiming independent approval: source dependencies, private context provenance, configured-key failures, forwarded-request rejection, path-segment rewriting, and exact staged scope were inspected by the owner. User authorization is to continue and save completed changes promptly. Full independent review of the remaining WebUI route group has not completed.

Anonymous local bootstrap still returns 401 in the exact committed dependency snapshot; its separate pending handler/wiring is not included or claimed fixed. The legacy `/v0/management/status` route is not mounted in that snapshot (404); the existing public restart registration now has its missing constant but was not invoked. No restart, mutation, browser acceptance, unconfigured-key full-server acceptance, Windows runtime acceptance, or new test cases were performed.

Other pending WebUI files are deliberately excluded: rule imports depend on database/wiring changes, remote proxy and session-watch additions need production registration, and asset-cache conditional/range semantics need further review. Database ownership remains with Aquinas; the working tree's unrelated test-file changes are preserved, not staged or discarded.
