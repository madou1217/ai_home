# Usage Threshold And Session Control Contract

Last updated: 2026-03-02

## Scope
- Usage refresh scheduler cadence and persistence.
- Threshold-based auto account switching.
- Session deletion and continue-with-account-mode controls.
- Persistent exec permission policy.

## Current Status
- Scheduler and threshold-switch behavior contracts are implemented and regression tested.
- Session deletion semantics and manual account override resume wiring are implemented and regression tested.
- Persistent exec permission policy contract (load/save/full-access decision) is implemented and regression tested.
- Targeted regression command: `node --test test/usage.scheduler.test.js test/runtime.permission-policy.test.js test/runtime.permission-policy.cli.test.js` (all pass).
- Remaining implementation work in other tasks can expand coverage, but does not block this contract baseline.

## Planned Runtime Config
- `active_refresh_interval`: `1m` or `3m`.
- `background_refresh_interval`: default `hourly`.
- `threshold_pct`: integer percent (planned safe range owned by implementation tasks).
- Permission policy persistence key: owned by `T006`.

## Planned Session Control Surface
- Delete session entry: owned by `T004`.
- Continue selected session with manual account override: owned by `T005`.
- Continue selected session with auto account select mode: owned by `T005`.
- Desktop actions for delete/manual/auto flow: owned by `T008`.

## Planned Verification Matrix
- Scheduler and threshold switching regression tests: `test/usage.scheduler.test.js`.
- Session continuation regression tests: covered by CLI/session baseline and usage scheduler suites.
- Permission policy persistence and full-access decision regression tests: `test/usage.scheduler.test.js`.
- Desktop operation coverage is tracked by T008 and can be incrementally expanded in dedicated UI suites.
