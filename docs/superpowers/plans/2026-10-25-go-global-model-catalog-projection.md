# Go Global Model Catalog Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize Node's complete global model catalog into Go for `/v1/models` display while keeping Go's routable model index separate and authoritative for inference routing.

**Architecture:** Node remains the source of remote discovery, plugin aggregation, SWR caching, and public `/v1/models` ownership. After constructing the unfiltered global cache, Node pushes a revisioned immutable catalog projection to Go through a new management endpoint. Go stores and renders that projection for its private `/v1/models`, but its route deferral continues to read only the local routable model set.

**Tech Stack:** Node.js CommonJS, Go 1.x, `net/http`, JSON projection handlers, existing Go management-key authorizer, Node `go-core-host` supervisor, Node and Go test suites.

**Spec:** `docs/superpowers/specs/2026-10-25-go-global-model-catalog-projection-design.md`

## Global Constraints

- Node remains the public `gateway.models.list` owner until a later shadow and cutover decision.
- The public projection is read-only in Go; no credentials, account refs, or upstream response bodies may enter it.
- Go routing must continue to use `ListRoutableModels` and `routable_model_ids`, never the public catalog projection.
- Projection replacement is whole-snapshot and fail-closed: invalid input preserves the prior snapshot.
- No new `AIH_*` environment variable is allowed.
- Every coherent task is staged and committed independently; unrelated worktree changes must remain untouched.
- Any web source change would require web build/lint/unit verification; this plan contains no web source changes.

### Task 1: Add the Go model catalog projection domain

**Files:**
- Create: `application/modelcatalog/store.go`
- Create: `application/modelcatalog/store_test.go`

**Interfaces:**
- Produces `modelcatalog.Item`, `modelcatalog.Snapshot`, `modelcatalog.Store`, `NewStore()`, `Store.Replace(revision string, items []Item) (Snapshot, error)`, `Store.Snapshot() Snapshot`.
- `Item` carries `ID`, `OwnedBy`, `InputModalities`, `OutputModalities`, and `ReasoningEfforts`.

- [ ] **Step 1: Write failing tests** for duplicate IDs, empty IDs, invalid/duplicate modalities, invalid reasoning effort, stable sort, whole-snapshot replacement, and revision preservation.
- [ ] **Step 2: Run `go test ./application/modelcatalog` and confirm the tests fail because the package does not exist.**
- [ ] **Step 3: Implement the immutable value objects and synchronized store.** Validate at most 4096 items, normalize no user-visible IDs beyond trimming, reject duplicate IDs, sort by ID, copy all slices, and increment a local generation only after a valid replacement.
- [ ] **Step 4: Run the focused package tests and then `go test ./application/...`.**
- [ ] **Step 5: Inspect `git diff --cached`, stage only the new package, and commit `feat(go): add global model catalog projection store`.**

### Task 2: Add Go management HTTP projection endpoint

**Files:**
- Create: `internal/transport/http/modelcatalogapi/handler.go`
- Create: `internal/transport/http/modelcatalogapi/handler_test.go`
- Modify: `internal/host/aihserver/composition.go`
- Modify: `internal/host/aihserver/router.go`

**Interfaces:**
- Adds `modelcatalogapi.Path = "/v1/management/model-catalog"`.
- `PUT` accepts `{ "revision": "...", "models": [{"id","owned_by","input_modalities","output_modalities","reasoning_efforts"}] }` and returns `{data:{generation,revision,accepted_count,routable_model_ids}}`.
- `GET` returns the same status plus the current public items for diagnostics.

- [ ] **Step 1: Write failing HTTP tests** for management-key rejection, method rejection, malformed JSON, unknown fields, invalid projection preserving the old snapshot, successful replacement, and GET including routable IDs supplied by a separate `RoutableReader` port.
- [ ] **Step 2: Run `go test ./internal/transport/http/modelcatalogapi` and confirm red failures.**
- [ ] **Step 3: Implement the handler with `http.MaxBytesReader`, `DisallowUnknownFields`, existing bearer authorizer conventions, and no partial writes.**
- [ ] **Step 4: Inject the handler into the Go composition root and router. Keep the routable reader separate from the public catalog store.**
- [ ] **Step 5: Run focused HTTP/host tests and `go test ./internal/host/aihserver ./internal/transport/http/...`.**
- [ ] **Step 6: Commit only the endpoint and composition changes as `feat(go): expose model catalog projection management`.**

### Task 3: Render the projection in Go models API without changing routing

**Files:**
- Modify: `internal/transport/http/modelsapi/handler.go`
- Create or modify: `internal/transport/http/modelsapi/catalog_reader.go`
- Modify: `internal/transport/http/modelsapi/handler_reasoning_test.go`
- Create: `internal/transport/http/modelsapi/projection_test.go`
- Modify: `internal/host/aihserver/composition.go`

**Interfaces:**
- Adds an optional `modelcatalog.Reader` to `modelsapi.Dependencies`.
- When the projection has `generation > 0`, standard and Codex model responses use projection items; when it is empty, existing local `RoutableModel` behavior remains unchanged.
- Capability filtering and reasoning-effort rendering operate on the selected source. Route selection never reads this source.

- [ ] **Step 1: Write failing tests** proving a Node-only item appears in Go `/v1/models` after a projection, its `owned_by`, modalities, and reasoning efforts come from the projection, and a local-only model remains routable through the existing reader.
- [ ] **Step 2: Run focused models API tests and confirm failure.**
- [ ] **Step 3: Implement a small adapter that converts projection items to the existing `modelView` path while preserving deduplication, ordering, aliases, and capability filtering.**
- [ ] **Step 4: Ensure empty projection keeps all existing tests unchanged.**
- [ ] **Step 5: Run `go test ./internal/transport/http/modelsapi ./internal/host/aihserver`.**
- [ ] **Step 6: Commit as `feat(go): render projected global model catalog`.**

### Task 4: Add Node management client and host projection push

**Files:**
- Modify: `lib/account/go-bridge/go-management-client.js`
- Modify: `lib/server/go-core-host.js`
- Create or modify: `test/go-core-host.test.js` (use the existing host test file if present; otherwise create the focused test file)

**Interfaces:**
- Adds `pushModelCatalogProjection(payload)` and `getModelCatalog()` to the management client.
- Adds `goCoreHost.pushModelCatalogProjection()` and `goCoreHost.modelCatalogStatus()`.
- Host tracks the last pushed revision and accepted generation; unchanged revisions are skipped; failed pushes do not clear the prior state.

- [ ] **Step 1: Write failing Node tests** for request method/path/body, revision deduplication, successful accepted-generation tracking, and failed push preserving prior status.
- [ ] **Step 2: Run the focused Node test and confirm red.**
- [ ] **Step 3: Implement the client method and host state using the same projection pattern as aliases and upstream rules.**
- [ ] **Step 4: Expose `model_catalog` in Go readiness status without exposing keys or model bodies in logs.**
- [ ] **Step 5: Run `node --test test/go-core-host.test.js` (or the exact focused file) and `node --test test/*.test.js` if the test file is shared.**
- [ ] **Step 6: Commit as `feat(go): add Node model catalog projection handshake`.**

### Task 5: Push Node global cache and separate routable IDs

**Files:**
- Modify: `lib/server/v1-router.js`
- Modify: `lib/server/server.js`
- Modify: `lib/server/go-core-host.js`
- Modify: `test/go-model-policy-sync.test.js` or add a focused `test/go-model-catalog-projection.test.js`

**Interfaces:**
- The global catalog builder emits a stable projection payload from `mergedList` before capability filtering: model ID, owner, modalities, reasoning efforts, and a deterministic revision hash.
- `goCoreHost.refreshRoutableModels()` reads management `routable_model_ids` (not public `/v1/models`) so public projection cannot affect routing deferral.
- On every cold-cache build and successful global-cache refresh, Node attempts a best-effort push; a push failure never fails the public Node response.

- [ ] **Step 1: Write failing tests** for deterministic revision generation, push on cold and refreshed global cache, no push on unchanged revision, and preservation of the local Go routable set when the public projection includes a Node-only ID.
- [ ] **Step 2: Run the focused Node tests and confirm red.**
- [ ] **Step 3: Implement projection construction and invoke it at the two cache publication points.**
- [ ] **Step 4: Change Go routable refresh to consume management status and retain the existing fallback behavior when the management endpoint is unavailable.**
- [ ] **Step 5: Run focused Node tests, the full Node suite, and `git diff --check`.**
- [ ] **Step 6: Commit as `feat(go): publish global catalog while isolating routing models`.**

### Task 6: Live verification, documentation, and cutover evidence

**Files:**
- Modify: `scripts/gateway-shadow-compare.js` only if it needs a read-only projection diagnostic field.
- Modify: `docs/architecture/go-node-parity-matrix.md`
- Modify: `docs/architecture/2026-10-22-go-node-alignment-inventory.md`
- Modify: `docs/plans/2026-10-22-go-full-migration-blueprint.md`

- [ ] **Step 1: Build and restart the local Go Core through the existing supervisor path; do not replace the public Node listener.**
- [ ] **Step 2: Run read-only shadow for `/v1/models`, `capability=vision`, and `capability=image_out`; compare ID sets, order, owners, modalities, and reasoning efforts.**
- [ ] **Step 3: Send one Node-only model inference request with explicit evidence that Node fallback handled it and Go did not receive it.**
- [ ] **Step 4: Run `go test ./...`, `node --test test/*.test.js`, `git diff --check`, and `npm run gateway:routes`.**
- [ ] **Step 5: Record actual counts, revision/generation, fallback evidence, and any remaining mismatch in the parity docs.**
- [ ] **Step 6: Commit documentation separately as `docs(go): record global catalog projection evidence`.**

## Verification Matrix

| Requirement | Evidence |
|---|---|
| Invalid projection cannot partially apply | Go store and HTTP rejection tests |
| Public model catalog can include Node-only items | Go models API projection tests and live private endpoint |
| Go routing remains local-only | Node deferral tests plus Node-only inference fallback observation |
| Node public response is resilient to Go failure | Node handler tests with rejected management push |
| Projection survives Go restart/reconciliation | Supervisor restart plus generation/revision readiness evidence |
| No current cutover claim is made | Manifest remains 12 Go-owned / 3 Node-owned blocking entries |
