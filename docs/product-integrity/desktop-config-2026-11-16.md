# Desktop configuration preparation — 2026-11-16

Part of the original M0–M5 plan; continues the explicit desktop-preparation gap from `f8902ad9c`. Before evidence was collected on **November 15, 2026**; implementation and after evidence on **November 16, 2026**. The four previously uncommitted owner paths are now part of a connected implementation, not standalone planning scaffolding.

## Confirmed failure

Actual Go `PrepareClaudeDesktopGateway` on a disposable profile replaced broken developer/desktop JSON and a same-name foreign library entry, returned success and changed mode0640→0600. Actual Node preparation rejected the broken later file, but had already overwritten the entry and selected it in `_meta.json`.

## Fix and ownership

- `claudedesktopconfig` is the focused shared Go planner/publisher. It never launches Desktop or operates account/server lifecycle.
- Toolkit `open.go` delegates preparation to it; the Node account/gateway preparation module uses a bounded private CLI pipe. Missing/incompatible child results fail explicitly; no old writer fallback. The original public Node modes and account-profile validation remain.
- All participating JSON files are read/validated before publication. Bad/empty/nonobject/duplicate-key/invalid Unicode input fails, preserving existing data. Numbers, unknown fields, existing modes and native setting symlinks are retained.
- A display name is not ownership. Existing entries are accepted only with a matching private receipt or exact known legacy managed configuration. Foreign or user-edited managed fields fail. Changes create a fresh entry ID; old library entry bytes are not overwritten/deleted. Unknown settings/metadata in owned entries are preserved.
- Supporting entry, developer settings, library selection, activation configuration and ownership receipt are guarded by one coordinator lock plus the shared per-file publication machinery. The coordinator journals observed paths, preimages, postimages and read-only guards before publication.
- The same request can resume after an interrupted step. Different requests, path retargets and external content changes fail closed and retain recovery material; no automatic rollback discards external edits. Success requires all postimages and guards still match.
- Formal no-op preparation also takes the coordinator lock and validates guards; it does not rewrite native files. Dry-run remains read-only, including an absent profile. Cancellation is checked before/following publication and before an app spawn is attempted.

## Real acceptance

See `desktop-config-2026-11-16/manifest.json` and named records:

| Journey | Observation |
|---|---|
| Original broken Go input | developer/desktop/foreign entry all retained; `desktop_config_invalid` |
| First/repeated Node→actual Go CLI prepare | api_configured; same ID; repeat changed=false with unchanged bytes/inode/mtime |
| Native settings preservation | mode0640, unknown JSON and integer9007199254740993 retained |
| Endpoint change | new managed entry, old entry bytes preserved, no embedded gateway credential |
| API→Web→API/Web account profile | both modes usable, web ID reused, native mode1p after return, two managed list entries |
| Foreign same-name entry / user-edited owned entry | explicit ownership conflict, no selection/activation overwrite |
| Native setting symlink / two logical files aliasing one file | single symlink preserved; ambiguous shared target rejected without change |
| Dry-run | absent home remains absent |
| Held real supporting-file OS lock | publication stops, durable journal retained, original settings/activation unchanged |
| Changed pending request | rejected without taking over the old operation |
| External edit during interrupted preparation | edit retained; activation untouched; no success |
| Retry after restoring the owned synthetic preimage | same request completes, journal removed, repeated request no-op |
| Held coordinator lock on fully prepared no-op | returns native_config_busy, not false readiness |
| Pre-cancelled actual preparation | no profile creation and explicit cancellation |

Validation used real files, actual flock, actual CLI processes and the real Go preparation entry. No GUI was launched. Go package/CLI/server builds and windows/amd64 cross-build pass; Node syntax check passes. Rawls independently reviewed ownership/publication and closed the no-op/cancellation gating issues. Real post-prepare cancellation at the OS spawn boundary and Windows filesystem behavior remain unverified.

## Boundaries and remaining acceptance

This is recoverable multi-file preparation, **not an atomic visibility guarantee to a simultaneously running native Desktop process**. It reduces partial activation risk with versioned entries and ordered publication; existing Desktop instances can independently observe files. It neither terminates those instances nor promises an OS-wide sandbox against adversarial filesystem changes.

Unknown external edits retain the journal for explicit reconciliation; the code does not guess how to merge them. Previous versioned entries are retained rather than garbage-collected. Full native Desktop login, model discovery, GUI behavior and upstream inference are not validated here. No shared gateway restart, standard binary replacement, database migration, credential export or production user configuration change occurred.

## Shared-workspace delivery

Owner-audit first verified 84 previously committed paths byte-for-byte against HEAD, then synchronized **only those stale index entries** as requested. All other index entries were unchanged; `internal/host/aihserver/composition.go` was explicitly skipped because it contained peer work. Audit directory: `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-own-index-audit-gdx6ubwl`.

The desktop checkpoint is committed with an explicit pathspec and isolated index, after checking staged diff and final file scope. It does not include composition/work-native/terminal/WebSocket/peer changes. Overall M0–M5 remains active.
