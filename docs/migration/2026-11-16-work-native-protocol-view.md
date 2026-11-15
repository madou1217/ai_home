# WORK native protocol model view prerequisite — 2026-11-16

## Boundary and ownership

This checkpoint is the shared **read-only application prerequisite** for the separate WORK repair. It does not alter ordinary Chat's existing model reader or inference routing behavior, does not claim AGY native authentication, and does not restart the gateway. The complete WORK host/driver/composer integration is still separate in-progress work.

Main W0–W6 owner adds exactly two focused source files:
- `application/inferencegateway/model_route_view.go`
- `application/inferencecatalog/protocol_view.go`

## Why it is needed

The WORK model reader must not combine carriers, aliases and routes from different publications. A raw model name may also be shadowed by an alias targeting an incompatible model. A union of raw IDs and filtered aliases is therefore not execution authority.

`ReadProtocolModelView` loads one immutable route snapshot and returns copied carriers, alias display names resolved through the actual ordered canonical plan, and the same plan's candidates per name. `ResolveModel` reuses the existing exact/wildcard/capability collector without creating synthetic user messages or calling a provider. Matched-but-text-unsupported names have an explicit nil route entry; absence means no canonical rule, which a consumer may consider only through its actual relay protocol contract.

Health is explicitly a separate current observation, not a claim that its stale flag and the route snapshot were atomically published together. Alias generation identifies alias compilation only, not all model changes.

## Review correction and real integration observation

Independent reviewer Hubble found that the first draft filtered display names against their original target before resolving precedence, losing names overridden by a longer wildcard. The correction collects every raw display name first and resolves it through the same snapshot's complete ordered plan. The reviewer then reported no remaining blocking finding for these two focused APIs.

The main agent ran an actual isolated full Go server with the in-progress WORK consumer and a private database copy. Through real authenticated management API operations, it published:
- `work-demo* → gpt-6.1-sol`, displaying `work-demo-v1`;
- longer `work-demo-v* → gemini-2.5-flash`, without its own display item;
- a high-priority `gpt-6.1-sol → gpt-image-2` shadow.

Actual WORK composer output retained `work-demo-v1`, excluded the image-shadowed raw name and the image model, and returned source observation for alias generation42. Removing only the shadow via the actual API restored the raw name at generation43 while retaining the wildcard display name. These observations exercise the new view through its real consumer; they do not prove that the consumer or all WORK runtime code is committed by this prerequisite.

- Exercised integration binary SHA-256: `2d643fa872091338c8806b5e65c4e14b32e205ea930b146a849ede0574000607`.
- Ephemeral evidence: `/tmp/aih-work-catalog-alias-result-20261116.json`.
- No provider inference was triggered for this catalog check. Alias changes were only in the disposable private copy; private server/state were removed.

## Verification and delivery limits

`go build ./application/inferencecatalog ./application/inferencegateway` and corresponding `go vet` passed; no test cases or mock services were added. Source review used physical files and HEAD blobs, not the stale shared index. Commit includes only these two modules and this note; ordinary Chat, shared composition, native runner, user DB and staged peer files are excluded.

The native catalog consumer, account environment preparation, authenticated AGY execution, full global WORK gateway business and visual acceptance remain independent requirements. The goal is not complete.
