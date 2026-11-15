# Import initial enabled-state preservation

## Real reproduction

`import-disabled-before-2026-11-15.json`: compiled isolated Server with actual SQLite accepted an `aih-accounts` v1 static entry with `status: down`, returned created, then GET returned enabled=true. The key was newly generated/unissued, bound to a dead loopback endpoint; no production credential or paid upstream request was used. This verifies persistence semantics, not key validity.

## Design/implementation

- Optional `InitialStateImporter` / `InitialStateRegistration` ports carry `InitialAccountState{Disabled:true}` only along create attempts. Old `Import/Register` contracts and zero-value defaults remain enabled.
- The existing registration transaction inserts `enabled` from `RegistrationRequest.Enabled()`, not a later status UPDATE. Returned Account is adjusted as an unpublished immutable value before commit/route publication.
- Usage/model registration decorators forward initial state and do not schedule a newly disabled account. Reauthentication/rotation still invalidates the old generation before skipping new work for an already disabled returned account.
- Existing-account conflicts go through the unchanged identity/credential-import semantics; document status never flips the target's current enabled choice.
- HTTP bundle accepts empty/up/down (case-normalized), rejects other states per entry. An incapable initial-state port fails before writes, never falls back to default enabled.
- No schema migration, account credential codec changes or host default rewrite in this work package.

## Actual current evidence

`import-disabled-after-2026-11-15.json`: actual compiled Server POST/GET plus shutdown/restart in isolated HOME.

| Scenario | Result |
|---|---|
| new down | enabled=false, created |
| repeat up on that identity | stays false, unchanged, alias stable |
| new up | enabled=true, created |
| repeat down on that identity | stays true, unchanged, alias stable |
| case DOWN | recognized, existing choice remains |
| invalid status | per-item failed, no state change |
| restart | both refs and enabled choices preserved |

Both isolated processes exit0 on SIGTERM. Real compiler succeeds. Absence of a transient enabled route relies on first INSERT + postcommit projection ordering, not merely the final GET. Zeno 的定点只读审查确认同事务/无瞬时启用、冲突不改状态、装饰器/构造器/无新增schema边界；补了缺能力sentinel稳定错误码。审查仅源码，真实证据由主会话执行并单独保存。

## Remaining boundaries

OAuth refresh/reauth, all native bundle shapes, exact external account identity, app startup usage scans and manual probes are not certified by this static-key experiment. Existing startup scanners may still probe disabled entries; this patch only controls creation state and registration lifecycle scheduling. G04 native artifact round-trip and general static provider transfer coverage remain open. No production data migrated, no test cases added, no deploy/commit.
