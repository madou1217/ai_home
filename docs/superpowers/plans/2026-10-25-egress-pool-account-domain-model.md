# Egress Pool and Account Domain Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace the mixed account/node/upstream interpretation with stable pool entities, unique account state, scoped evidence, account-first runtime read models, and a resource-oriented egress pool UI.

**Architecture:** Add a domain contract and identity-map layer first, then introduce scoped evidence and account-first projections without breaking the existing runtime. Refactor planner inputs and writes through the new domain services, preserve old reads behind compatibility adapters, and migrate UI from flat node/account mixing to separate resource and account diagnostic views.

**Tech Stack:** Node.js CommonJS, SQLite/app-state storage, existing egress runtime/lane planner, React 18 + TypeScript + Ant Design, Node node:test, Webpack/Umi build, existing design-pattern and provider-contract conventions.

**Spec:** docs/superpowers/specs/2026-10-25-egress-pool-account-domain-model-design.md

## Global Constraints

- Do not add a new AIH_* environment variable.
- Preserve accountRef as the unique AccountEntity identity; display indexes are projections only.
- A stable NodeEntity identity must survive node reorder, subscription refresh, and runtime restart; node-N is runtime-only.
- “自选节点” means allowlist plus automatic selection; fixed selection is a separate pinned mode.
- A scoped account/upstream/provider evidence record must never become a global node blacklist.
- Keep old egress APIs readable during migration; all new writes go through the new domain services.
- Do not stage or modify unrelated shared-worktree changes.
- Every task ends with focused tests, diff review, and a single-purpose checkpoint commit.
- Web source changes require cd web && npm run build, changed-file ESLint, and relevant tests.
- Follow the existing UI rules: no large Alert blocks as page content and no decorative left color bars.

---

## Task 1: Domain contracts and stable identity helpers

Files:

- Create lib/server/egress-domain-contract.js
- Create lib/server/egress-entity-identity.js
- Create lib/server/egress-domain-registry.js
- Modify lib/account/zcode-egress-binding-store.js
- Test test/egress-domain-contract.test.js
- Test test/egress-entity-identity.test.js

Interfaces:

- normalizeNodeEntity(raw) returns NodeEntity
- normalizePoolGroup(raw) returns ProxyPoolGroup
- normalizeProxyPool(raw) returns ProxyPool
- normalizeAccountEgressAssignment(raw) returns AccountEgressAssignment
- buildNodeEntityId({ protocol, server, port, credentialRef? }) returns string
- buildExitIdentity({ protocol, server, port }) returns string
- normalizeSelectionMode(value) returns auto or pinned
- normalizePoolScope(raw) returns kind all/groups/nodes with groups and nodes arrays
- createEgressDomainRegistry() returns nodes, pools, poolGroups and assignments registries

- [ ] Step 1: Write failing contract tests. Assert that missing stable node fields are rejected, runtime names such as node-1 are not accepted as persistent IDs, account assignments preserve accountRef, scope defaults to allowlist semantics, and pinned requires a node ID.
- [ ] Step 2: Run node --test test/egress-domain-contract.test.js test/egress-entity-identity.test.js and confirm failure because the new exports do not exist.
- [ ] Step 3: Implement normalized entity contracts. Keep them provider-neutral. Use a stable identity fingerprint for protocol/server/port and keep credential references out of persisted display objects.
- [ ] Step 4: Add compatibility normalization in zcode-egress-binding-store.js. Existing pool bindings read as AccountEgressAssignment with selectionMode auto, existing scope becomes an allowlist, and old node/group records remain retired without being promoted to a global blacklist.
- [ ] Step 5: Run focused tests and inspect normalized shapes. Two differently ordered node lists must produce the same NodeEntity ID.
- [ ] Step 6: Commit:

~~~text
git add lib/server/egress-domain-contract.js lib/server/egress-entity-identity.js lib/server/egress-domain-registry.js lib/account/zcode-egress-binding-store.js test/egress-domain-contract.test.js test/egress-entity-identity.test.js
git commit -m "feat(egress): define stable pool and account domain contracts"
~~~

## Task 2: Identity maps and account-first read models

Files:

- Create lib/server/egress-entity-store.js
- Create lib/server/egress-account-view.js
- Create lib/server/egress-resource-view.js
- Modify lib/account/state-service.js only for injected AccountEntity lookup if needed
- Test test/egress-entity-store.test.js
- Test test/egress-account-view.test.js
- Test test/egress-resource-view.test.js

Interfaces:

- createEgressEntityStore({ fs, aiHomeDir, now })
- store.getNode(nodeId), store.putNode(node)
- store.getPool(poolId), store.putPool(pool)
- store.getPoolGroup(poolGroupId), store.putPoolGroup(group)
- store.getAssignment(accountRef), store.putAssignment(assignment)
- store.listAssignments(), store.listNodes(), store.listPools()
- buildAccountEgressView({ account, assignment, runtime, node, evidence, accountState })
- buildEgressResourceView({ poolGroups, pools, nodes, memberships, nodeHealth, nodePolicy })

- [ ] Step 1: Write failing tests for identity-map behavior. Two writes of the same accountRef update one assignment; two node aliases with the same stable identity resolve to one NodeEntity; account views contain only the selected account runtime and evidence.
- [ ] Step 2: Run focused tests and verify failure with node --test test/egress-entity-store.test.js test/egress-account-view.test.js test/egress-resource-view.test.js.
- [ ] Step 3: Implement storage using existing app-state atomic JSON/SQLite helpers. Store entities by stable IDs, preserve old records for migration, and never duplicate AccountGlobalState into egress records.
- [ ] Step 4: Implement account and resource projections. The account projection returns pool group, pool, assignment, current lanes, active node, exit IP, NodeHealth and scoped verdict. The resource projection returns PoolGroup to Pool to NodeEntity and reference counts without account-specific failure labels.
- [ ] Step 5: Run focused tests and verify account A’s view contains no evidence or runtime from account B.
- [ ] Step 6: Commit:

~~~text
git add lib/server/egress-entity-store.js lib/server/egress-account-view.js lib/server/egress-resource-view.js lib/account/state-service.js test/egress-entity-store.test.js test/egress-account-view.test.js test/egress-resource-view.test.js
git commit -m "feat(egress): add identity maps and account-first projections"
~~~

## Task 3: Scoped evidence and legacy evidence quarantine

Files:

- Create lib/server/egress-evidence-store.js
- Create lib/server/egress-evidence-scope.js
- Modify lib/server/egress-region-policy.js
- Modify lib/server/egress-traffic-evidence.js
- Modify lib/runtime/egress-pool-node-health.js
- Test test/egress-evidence-scope.test.js
- Test test/egress-traffic-evidence-isolation.test.js
- Test test/egress-region-policy.test.js

Interfaces:

- buildProviderExitEvidenceKey({ provider, upstreamId, nodeId, exitIp, modelFamily }) returns string
- buildAccountUpstreamEvidenceKey({ accountRef, provider, upstreamId, nodeId, exitIp, modelFamily, credentialGeneration }) returns string
- recordEvidence(record) returns accepted and reason
- listEvidence(query) returns ScopedEvidence array
- classifyLegacyEvidence(record) returns legacy_unscoped_evidence with usableForBlocking false
- notifyEgressRegionDenied({ account, provider, upstream, node, exitIp, reason })
- notifyEgressSuccess({ account, provider, upstream, node, exitIp })

- [ ] Step 1: Write failing isolation tests. Account A blocked evidence cannot affect account B; provider A cannot affect provider B; upstream A cannot affect upstream B; legacy ip_blocked cannot be used for global NodePolicy.
- [ ] Step 2: Run the focused tests and verify the missing scoped-store behavior.
- [ ] Step 3: Implement explicit evidence key builders and bounded records. Every record includes scope, source, timestamp, confidence and optional credential generation; account-specific evidence never uses the old node-only key.
- [ ] Step 4: Adapt egress-region-policy.js as a compatibility evaluator. Old evidence may be read as soft legacy hints, but only scoped evidence can return a blocking verdict.
- [ ] Step 5: Adapt the traffic observer. Region denial writes AccountUpstreamEvidence first; only an explicit promotion rule can produce ProviderExitEvidence; there is no direct node-health global block.
- [ ] Step 6: Keep node health for network failures and NodePolicy only. Remove account/provider IP rejection from the global node failure path.
- [ ] Step 7: Run focused tests and verify all isolation cases.
- [ ] Step 8: Commit:

~~~text
git add lib/server/egress-evidence-store.js lib/server/egress-evidence-scope.js lib/server/egress-region-policy.js lib/server/egress-traffic-evidence.js lib/runtime/egress-pool-node-health.js test/egress-evidence-scope.test.js test/egress-traffic-evidence-isolation.test.js test/egress-region-policy.test.js
git commit -m "fix(egress): scope exit evidence by account provider and upstream"
~~~

## Task 4: Assignment and planner refactor

Files:

- Create lib/server/egress-assignment-service.js
- Modify lib/server/egress-pool-planner.js
- Modify lib/runtime/egress-pool-runtime.js
- Modify lib/account/zcode-egress-binding-store.js
- Test test/egress-assignment-service.test.js
- Test test/egress-pool-planner-isolation.test.js
- Test test/egress-session-lanes.test.js

Interfaces:

- createEgressAssignmentService({ entityStore, accountStateService, evidenceStore, planner, runtime })
- resolveAssignment(accountRef) returns AccountEgressAssignment or null
- resolveRuntime({ accountRef, sessionId, provider, upstreamId }) returns poolGroup, pool, lane, node, exitIp and verdict
- planAssignments({ accounts, assignments, upstreams }) returns RuntimeLanePlan
- selectionMode is auto or pinned
- strategy is shared, sticky or session

- [ ] Step 1: Write failing planner isolation tests. Cover two accounts sharing a pool, two providers sharing a node, two upstreams for one account, and two sessions using session strategy. Test allowlist versus pinned selection.
- [ ] Step 2: Run tests and capture current cross-scope failures.
- [ ] Step 3: Implement assignment service as the only runtime resolver. It reads one AccountEntity, one AccountGlobalState, one assignment, scoped evidence and current runtime lane; it never clones or mutates global account state.
- [ ] Step 4: Refactor planner to consume assignments and scoped evidence. Keep shared/sticky/session intent, add pinned, and keep runtime lane IDs separate from NodeEntity IDs.
- [ ] Step 5: Refactor runtime lookups. laneOf(accountRef), laneActiveNode(accountRef) and session-lane lookups return NodeEntity identity plus runtime name; preserve old methods through compatibility wrappers where needed.
- [ ] Step 6: Run planner/runtime tests and verify session isolation.
- [ ] Step 7: Commit:

~~~text
git add lib/server/egress-assignment-service.js lib/server/egress-pool-planner.js lib/runtime/egress-pool-runtime.js lib/account/zcode-egress-binding-store.js test/egress-assignment-service.test.js test/egress-pool-planner-isolation.test.js test/egress-session-lanes.test.js
git commit -m "refactor(egress): resolve account assignments through scoped lanes"
~~~

## Task 5: Account-first API and direct runtime echo

Files:

- Create lib/server/webui-egress-account-routes.js
- Modify lib/server/webui-zcode-egress-routes.js for compatibility delegation
- Modify lib/server/web-ui-router.js route registration
- Modify web/src/features/accounts/ZcodeEgressModal.tsx
- Create web/src/features/accounts/AccountEgressRuntimePanel.tsx
- Modify web/src/features/egress-upstream/types.ts only for shared display contracts
- Modify web/src/services/api.ts for account-first endpoints
- Test test/webui-egress-account-routes.test.js
- Test web/src/features/accounts/AccountEgressRuntimePanel.test.tsx if the repository frontend test runner supports it

Interfaces:

- GET /v0/webui/accounts/:provider/:accountRef/egress
- PUT /v0/webui/accounts/:provider/:accountRef/egress-assignment
- GET /v0/webui/accounts/:provider/:accountRef/egress-runtime
- getAccountEgressView(provider, accountRef) returns AccountEgressView
- saveAccountEgressAssignment(provider, accountRef, assignment) returns assignment, runtime, migration and apply
- getAccountEgressRuntime(provider, accountRef) returns AccountEgressRuntimeView

- [ ] Step 1: Write failing route contract tests. Verify accountRef/provider/index, poolGroup/pool, selectionMode, allowlist, strategy, lane, nodeId, runtime node name, exit IP, scoped verdict and evidence source.
- [ ] Step 2: Run route tests and verify the new endpoints are absent.
- [ ] Step 3: Implement account-first read/write routes. Validate path accountRef against stored AccountEntity provider; reject cross-provider or unknown account references; delegate storage and runtime resolution to assignment service.
- [ ] Step 4: Delegate old account egress routes to the new service. Preserve old response fields but mark old unscoped evidence as legacy.
- [ ] Step 5: Add account runtime panel to the existing modal. Show pool, assignment, current lane/session, NodeEntity, runtime node, exit IP, NodeHealth and scoped evidence without navigating away.
- [ ] Step 6: Run Web build, changed-file ESLint and route/UI tests.
- [ ] Step 7: Commit:

~~~text
git add lib/server/webui-egress-account-routes.js lib/server/webui-zcode-egress-routes.js lib/server/web-ui-router.js web/src/features/accounts/ZcodeEgressModal.tsx web/src/features/accounts/AccountEgressRuntimePanel.tsx web/src/features/egress-upstream/types.ts web/src/services/api.ts test/webui-egress-account-routes.test.js web/src/features/accounts/AccountEgressRuntimePanel.test.tsx
git commit -m "feat(egress): show account assignment and active runtime directly"
~~~

## Task 6: Resource-oriented pool API and UI

Files:

- Create lib/server/egress-resource-service.js
- Modify lib/server/webui-egress-pool-routes.js to add resource and diagnostic views
- Modify web/src/features/egress-pool/types.ts
- Modify web/src/features/egress-pool/egress-pool-api.ts
- Modify web/src/features/egress-pool/EgressPoolPanel.tsx
- Modify web/src/features/egress-pool/EgressPoolPanel.css
- Create web/src/features/egress-pool/EgressPoolResourceTree.tsx
- Create web/src/features/egress-pool/EgressPoolAccountDiagnostic.tsx
- Test test/webui-egress-resource-routes.test.js
- Test web/src/features/egress-pool/egress-pool-presentation.test.ts

Interfaces:

- GET /v0/webui/egress-pool-groups
- GET /v0/webui/egress-pools
- GET /v0/webui/egress-pools/:poolId
- GET /v0/webui/egress-nodes/:nodeId
- GET /v0/webui/egress-evidence?provider=&accountRef=&upstreamId=&nodeId=
- buildResourceTreeView() returns PoolGroupView array
- buildAccountDiagnosticView(query) returns ScopedDiagnosticView

- [ ] Step 1: Write failing API/presentation tests. Resource responses have PoolGroup → Pool → NodeEntity hierarchy, no account-specific red status in resource rows, and diagnostic responses filter by provider/account/upstream.
- [ ] Step 2: Implement resource service and route adapters. Keep old egress-pool pagination and node actions compatible; add new resource endpoints and a separate diagnostic query.
- [ ] Step 3: Build the resource tree component. It shows pool group, pool, stable node ID, runtime status, NodeHealth, NodePolicy and account/session reference counts.
- [ ] Step 4: Build the diagnostic component. It requires explicit provider/account/upstream selection and shows scoped evidence; it must not infer global blocking from one account.
- [ ] Step 5: Replace the flat main view with resource tree plus explicit diagnostic view. Preserve node actions but move them to NodeEntity resource context.
- [ ] Step 6: Run Web build, changed-file ESLint and presentation/route tests.
- [ ] Step 7: Commit:

~~~text
git add lib/server/egress-resource-service.js lib/server/webui-egress-pool-routes.js web/src/features/egress-pool/types.ts web/src/features/egress-pool/egress-pool-api.ts web/src/features/egress-pool/EgressPoolPanel.tsx web/src/features/egress-pool/EgressPoolPanel.css web/src/features/egress-pool/EgressPoolResourceTree.tsx web/src/features/egress-pool/EgressPoolAccountDiagnostic.tsx test/webui-egress-resource-routes.test.js web/src/features/egress-pool/egress-pool-presentation.test.ts
git commit -m "feat(egress): split resource pool and account diagnostics views"
~~~

## Task 7: Migration, compatibility verification, and end-to-end isolation

Files:

- Create lib/server/egress-domain-migration.js
- Create scripts/migrate-egress-domain.js
- Modify lib/server/egress-domain-registry.js for legacy adapters
- Modify docs/architecture/design-patterns.md
- Create docs/evidence/2026-10-25-egress-domain-migration.md
- Test test/egress-domain-migration.test.js
- Test test/egress-end-to-end-isolation.test.js
- Test test/egress-runtime-compatibility.test.js

Interfaces:

- planEgressMigration({ fs, aiHomeDir }) returns MigrationPlan
- applyEgressMigration({ fs, aiHomeDir, dryRun }) returns MigrationResult
- rollbackEgressMigration({ fs, aiHomeDir, migrationId }) returns RollbackResult
- classifyLegacyEvidence(record) returns legacy_unscoped_evidence
- runEgressIsolationScenario({ accounts, providers, upstreams, sharedNode }) returns ScenarioResult

- [ ] Step 1: Write migration and end-to-end failing tests. Cover old account bindings, stable node identity, legacy ip_blocked, rollback, two accounts sharing a node, two providers sharing an IP, two upstreams for one account, and two session lanes.
- [ ] Step 2: Implement dry-run migration. It produces a complete plan before writes, reports ambiguous node identity and legacy evidence, and never deletes old records.
- [ ] Step 3: Implement apply/rollback with a migration journal. Writes are atomic and reversible; old data remains until post-migration verification passes.
- [ ] Step 4: Add the end-to-end isolation harness. Run account/node/provider/upstream scenarios through assignment service and verify independent state transitions.
- [ ] Step 5: Update design-pattern documentation. Record Entity + Identity Map, Aggregate, Strategy, Specification, Projection and scoped Evidence boundaries with concrete files and verification evidence.
- [ ] Step 6: Run the complete verification set:

~~~text
node --test test/egress-domain-contract.test.js test/egress-entity-identity.test.js test/egress-entity-store.test.js test/egress-account-view.test.js test/egress-resource-view.test.js test/egress-evidence-scope.test.js test/egress-traffic-evidence-isolation.test.js test/egress-assignment-service.test.js test/egress-pool-planner-isolation.test.js test/egress-session-lanes.test.js test/webui-egress-account-routes.test.js test/webui-egress-resource-routes.test.js test/egress-domain-migration.test.js test/egress-end-to-end-isolation.test.js test/egress-runtime-compatibility.test.js
cd web && npm run build
cd web && npx eslint all changed TS and TSX files
git diff --check
~~~

Expected: all focused tests pass, Web build exits 0, changed-file ESLint exits 0, and only unrelated shared-worktree changes remain unstaged.

- [ ] Step 7: Commit:

~~~text
git add lib/server/egress-domain-migration.js scripts/migrate-egress-domain.js lib/server/egress-domain-registry.js docs/architecture/design-patterns.md docs/evidence/2026-10-25-egress-domain-migration.md test/egress-domain-migration.test.js test/egress-end-to-end-isolation.test.js test/egress-runtime-compatibility.test.js
git commit -m "feat(egress): migrate and verify scoped pool domain"
~~~

## Plan self-review

- Spec coverage: all nine goals, four non-goals, six phases, four design layers, migration rules, UI requirements and fourteen acceptance criteria map to Tasks 1–7.
- Completeness scan: no open placeholders or unspecified test/implementation steps remain.
- Type consistency: Task 1 defines AccountEgressAssignment, NodeEntity and stable IDs; Task 2 consumes them for identity maps; Task 3 adds scoped evidence; Task 4 consumes all three in assignment resolution; Tasks 5–6 expose the read models; Task 7 migrates and verifies the complete path.
- Compatibility: old bindings and APIs remain readable through adapters until Task 7 verification.
