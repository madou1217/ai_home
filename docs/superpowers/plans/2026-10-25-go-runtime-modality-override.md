# Go Runtime Model Modality Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make Go consume validated Kimi /models modality descriptors through an atomic provider/model runtime override while preserving static models.dev fallback and the existing account-model contract.

**Architecture:** Add a low-sensitivity descriptor value object and provider-level registrar in the application metadata boundary. Extend the immutable models.dev index with copy-on-write override snapshots, then inject that registrar into the OpenAI-compatible Kimi model source so one successful /models response updates both model IDs and runtime modalities without touching SQLite or credentials.

**Tech Stack:** Go 1.26, existing Go test runner, sync/atomic, modelmetadata.Modalities, modelsdev.Index, and OpenAI-compatible /models JSON parsing.

**Spec:** docs/superpowers/specs/2026-10-25-go-runtime-modality-override-design.md

## Global Constraints

- Do not add AIH_* environment variables, server-config fields, WebUI settings, SQLite columns, or persistent descriptor storage.
- Preserve application/accounts.ProviderModelDiscoverer.DiscoverModels returning only a string model list.
- Only accept low-sensitivity id, supports_image_in, and supports_video_in facts for Kimi; never retain provider text, credentials, account refs, display names, context lengths, or reasoning fields.
- Runtime overrides are process-local provider-level replacement snapshots. Invalid or empty replacement input preserves the previous snapshot; a successful replacement may remove models absent from the new generation.
- No web source changes are expected. If implementation touches web, run the repository-required build, modified-file ESLint, and related tests.
- Keep each coherent unit in its own checkpoint commit and stage only checkpoint paths.

## File Map

- application/modelmetadata/modalities.go: descriptor value object and registrar contract.
- application/modelmetadata/descriptor_test.go: descriptor validation and copy tests.
- internal/adapters/modelmetadata/modelsdev/index.go: atomic override snapshot and lookup precedence.
- internal/adapters/modelmetadata/modelsdev/index_test.go: override replacement, fallback, and concurrency tests.
- internal/adapters/openaicompat/modelcatalog/discovery.go: Kimi descriptor parsing and optional sink.
- internal/adapters/openaicompat/modelcatalog/discovery_test.go: parser and source sink tests.
- internal/host/aihserver/composition.go: shared index and Kimi sink wiring.
- docs/architecture/go-node-parity-matrix.md: parity evidence.

### Task 1: Add the descriptor contract

**Files:** modify application/modelmetadata/modalities.go; create application/modelmetadata/descriptor_test.go.

**Produces:** ModelDescriptorInput, immutable ModelDescriptor accessors ProviderID, ModelID, Modalities, IsValid, and ModelDescriptorRegistrar.ReplaceModelDescriptors(providerID string, descriptors []ModelDescriptor) error.

- [ ] Write failing tests for valid construction, input-slice isolation, empty/invalid provider, invalid model ID, empty/duplicate modalities, and IsValid.
- [ ] Run go test ./application/modelmetadata -run TestModelDescriptor -count=1 and confirm compile/test failure.
- [ ] Implement the value object using runtimecore.NewModelID and NewModalities, copying all inputs.
- [ ] Run go test ./application/modelmetadata -count=1 and confirm green.
- [ ] Commit only these two files with message feat(go): add runtime model descriptor contract.

### Task 2: Add atomic runtime overrides to models.dev

**Files:** modify internal/adapters/modelmetadata/modelsdev/index.go; create internal/adapters/modelmetadata/modelsdev/index_test.go.

**Produces:** modelsdev.Index implements ModelDescriptorRegistrar through ReplaceModelDescriptors(providerID string, descriptors []modelmetadata.ModelDescriptor) error.

- [ ] Write failing tests for override precedence, static fallback on an uncovered model, provider replacement removing omitted models, invalid replacement preserving the previous generation, returned-slice isolation, and concurrent reads/replacements.
- [ ] Run go test ./internal/adapters/modelmetadata/modelsdev -run TestRuntimeModalityOverride -count=1 and confirm red.
- [ ] Add an immutable snapshot stored behind atomic.Pointer. Build and validate a complete provider replacement before publishing. Normalize provider/model keys with the same lookup rules already used by Index.
- [ ] Keep existing namespace, base-model, family inference, reasoning, and image-generation behavior unchanged after an override miss.
- [ ] Run go test ./internal/adapters/modelmetadata/modelsdev -run TestRuntimeModalityOverride -count=1 and go test -race ./internal/adapters/modelmetadata/modelsdev -count=1.
- [ ] Commit only the index and its tests with message feat(go): add atomic runtime modality overrides.

### Task 3: Extend the OpenAI-compatible Kimi source

**Files:** modify internal/adapters/openaicompat/modelcatalog/discovery.go; create or extend internal/adapters/openaicompat/modelcatalog/discovery_test.go.

**Produces:** an optional ModelDescriptorSink in modelcatalog.Options, while DiscoverModels still returns only []string.

- [ ] Write failing tests with a fixture containing image/video flags, missing flags, and malformed optional flag types. Assert IDs remain discoverable while only valid descriptors are emitted.
- [ ] Add source tests that the sink is called once after a successful non-empty response and is not called after HTTP failure, empty catalog, malformed JSON, or an all-invalid descriptor set.
- [ ] Run go test ./internal/adapters/openaicompat/modelcatalog -run TestKimi -count=1 and confirm red.
- [ ] Implement a parser that models only id, supports_image_in, and supports_video_in. Start input modalities with text, append image/video for true booleans, and use text output. Do not retain raw response text.
- [ ] Invoke the optional sink only after existing status, size, and non-empty ID checks pass. Sink rejection returns a refresh error without exposing provider content.
- [ ] Run go test ./internal/adapters/openaicompat/modelcatalog -count=1.
- [ ] Commit only the Kimi source and tests with message feat(go): publish Kimi runtime modality descriptors.

### Task 4: Wire the shared index into production composition

**Files:** modify internal/host/aihserver/composition.go; modify docs/architecture/go-node-parity-matrix.md; use existing composition/model API tests.

- [ ] Add a narrow failing composition seam test or helper assertion proving the production Kimi source receives a non-nil descriptor sink and a successful discovery changes the shared index.
- [ ] Run the focused host test and confirm the shared index remains static before wiring.
- [ ] Construct one modelsdev.Index before model consumers, inject it into Kimi source construction, and pass that same index to vision guard, inference composition, and models API. Do not add a singleton or a second index.
- [ ] Run go test ./internal/host/aihserver ./internal/adapters/modelmetadata/modelsdev ./internal/adapters/openaicompat/modelcatalog -count=1.
- [ ] Add a parity matrix row stating that the Kimi runtime modality override gap is closed and naming the source/index/test evidence.
- [ ] Commit only composition and parity documentation with message fix(go): wire Kimi modality overrides into server composition.

### Task 5: Full verification and handoff

**Files:** inspect all implementation checkpoints and the spec/plan; do not modify unrelated parallel-session files.

- [ ] Run focused modelmetadata, Kimi source, composition, models API, and vision guard tests and inspect output for override precedence and static fallback.
- [ ] Run go test ./..., node --test test/*.test.js, and git diff --check.
- [ ] Run go test -race ./internal/adapters/modelmetadata/modelsdev ./internal/adapters/openaicompat/modelcatalog -count=1.
- [ ] Confirm no web files, no new AIH_* strings, no SQLite schema changes, and no untracked implementation files.
- [ ] Report unrelated parallel-session modifications separately and leave them untouched.

## Plan Self-Review

- Spec coverage: descriptor value object (Task 1), atomic override precedence and replacement (Task 2), Kimi parsing/sink semantics (Task 3), production composition and shared consumers (Task 4), and all verification/security constraints (Task 5).
- Placeholder scan: no TBD, TODO, implement later, or unspecified test steps.
- Type consistency: Task 1 defines ModelDescriptor and ModelDescriptorRegistrar; Task 2 implements the registrar; Task 3 uses the descriptor sink; Task 4 injects the index-backed sink.
- Scope: no web code, persistence, account model contract, or unrelated Provider behavior.
