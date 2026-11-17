# Distribution lifecycle closeout

User-approved outcome: ordinary users install/update an AIH release without binary/database commands; detect releases, show a compact tip, and explicitly schedule install/restart. Deploy the same product entry to AWS, Windows and Linux, then verify the legacy Codex hook warning.

## Invariants
- Preserve canonical/legacy accounts, credentials, configuration and histories. No startup gate bypass and no latest-wins reconciliation.
- One native installation transaction: verify bundle -> quiesce owned service -> snapshot -> prepare/verify offline data -> publish data/release/service -> authenticated health and exact release identity -> complete. Failure restores the saved service and data together before normal writes resume.
- Durable journal and OS lock; recover interrupted publication before another install. Never modify unrelated worktrees, staged changes or provider-native data.
- Automatic release checks are read-only. Apply requires immediate confirmation or a persisted, cancellable schedule. Busy tasks/sessions defer; unknown occupancy refuses.
- CLI, SFX/archive installer and WebUI use the same updater/installer. No remote hand-repair scripts masquerading as product acceptance.

## Work
1. Offline data preparation adapter (private consistent snapshots, verified dbunify reuse).
2. Trusted release discovery/download adapter using current GitHub artifact manifest.
3. Native installation/service/journal boundary; platform-specific activation and rollback.
4. Persistent update check/schedule service and authenticated API + CLI.
5. Compact desktop update UI, true browser acceptance where tooling permits.
6. Exact-source packaged builds, review, focused commits/push, staged three-host product installation and business validation.
7. Shared Codex official executable resolution: distinguish orphan hook from actual missing CLI; preserve overrides and user installations.

No test cases are to be added. Use real isolated processes/databases/HTTP/platform installation runs; keep failed probes and passing evidence distinct. Building or uploading a private candidate is not production deployment.
