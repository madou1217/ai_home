# Credential resolver ownership checkpoint

## Source defect and narrow implementation

The Server constructed a management/model/usage Resolver and a second inference Resolver. Both had independent singleflight/suppression; only the former owned AGY projection/default sync/re-key callbacks. Reusing strategy definitions did not share state.

The host now injects the existing credential authority through `inferenceruntime.CredentialResolver`, combining the already-used routing/observation ports. Standalone Runtime consumers without injection retain the prior construction path. No new lock service, no scope expansion into UI or provider adapters, no refresh strategy changes. Shared resolver close ownership is unchanged.

## Re-key consumer boundary

Independent review identified that successful authorized re-key would return a new reference while Recruiter retained an old immutable candidate. The account-matching guard must remain strict.

- `ResolveObservedCredentialBinding` returns `ErrCredentialIdentityChanged` with zero binding/observation when an authorized refresh moves identity.
- The ordinary management `ResolveCredentialBinding` behavior is unchanged.
- Coordinator reloads candidates at most once **per executeRouteRound**, only before any upstream attempt, when unpinned and not encrypted-reasoning continuation.
- The retry does not replay an upstream request or relax candidate/provider/observation checks. Second failure propagates through existing pending-failure rules. Pinned callers explicitly fail instead of silently moving to a new account.

Review by Zeno: source-level G01/G02 composition and re-key recovery branch accepted; no runtime OAuth executed by reviewer. Cross-process/native-client refresh locks remain a separate unproven boundary.

## Actual evidence

- Real `go build -o /tmp/aih-product-shared-credentials-server-20261115 ./cmd/aih-server` succeeded after final re-key change.
- Actual compiled Server in empty isolated HOME and random loopback port: /healthz200; /readyz200 but ready=false (no accounts/catalog); /v1/models200 empty; SIGTERM exit0. Record `shared-credentials-composition-2026-11-15.json` was captured before the narrow re-key branch, so it proves shared composition startup, not that branch.
- No token/credential copies, imports, refresh grants, paid inference, host sync, production restart or deployment triggered by this checkpoint.

## Unverified required acceptance

A controlled real OAuth account and refresh generation are required to verify token rotation, concurrent management+inference request coalescing, final projection/default state, re-key result and pinned failure. Tests/mocks are not substituted. Source/compile/empty-server evidence does not close these requirements or M3.
