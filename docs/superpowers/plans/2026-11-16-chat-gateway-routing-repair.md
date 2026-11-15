# Chat gateway routing repair

**Goal:** Close the reported AGY / All accounts Chat failure and check the same failure mechanism across Chat providers.

**Architecture:** Ordinary Chat remains independent of native CLIs. Composer choices and turn validation consume the gateway's published model/alias catalog; account pinning narrows that catalog to the selected account. The supervised Node host retains a separate instance lock from its Go parent.

**Constraints:** No new test cases, branches, worktrees, shared-index cleanup, peer-code rollback, or Go parent restart. Validate with actual service processes, HTTP requests, and the existing background Edge connection. Preserve the global meaning of All accounts.

- [x] Locate original owner: session `01a1dd52-79e3-73d3-b500-5edfe47c0ca4`, Chat independence commit `7c3dcffc7`; original session is not registered for peer delivery. Current coordinator `01a1dfb7` takes the follow-up.
- [x] Reproduce with the actual service: AGY/gateway + `gemini-2.5-flash` succeeds; composer default `DeepSeek-Flash` is absent from `/v1/models` and fails with 503. Composer has 238 IDs versus 224 published gateway IDs.
- [x] Delegate and restore the Node host without restarting the Go parent: only `lib/server/server-singleton.js`; supervised Node uses a role-checked private lock. Public UI returns 200, standalone singleton behavior remains intact.
- [x] Add a focused published-gateway catalog adapter under `internal/runtime/chatruntime`; inject the existing gateway catalog through `ServiceOptions`, `WebUIChatRuntimeBuildOptions` and the host composition dependency. Preserve account pinning and compiled aliases, exclude stale snapshot-only models, and derive metadata from actual carriers.
- [x] Connect GoChatDriver to the same catalog for missing-model defaults, selected-model validation and reasoning-effort alignment. Invalid selections must fail before inference with a useful error.
- [x] Compile the actual Go server, inspect the patch independently, and start an isolated service on a private port with an isolated SQLite snapshot. Do not alter live account configuration or restart 9527.
- [x] Validate actual catalog parity, default/explicit-model sends, multi-turn history, invalid models, provider context changes, pinned accounts and aliases. Reuse existing Edge in the background and retain screenshots plus runtime/usage evidence under `~/.ai_home/run/aih-chat-routing-repair-20261116/`. The original configuration's `auto` default still fails upstream; a controlled private default and explicit published models completed.
- [x] Review real evidence against the original report, record adjacent native-runtime findings separately, and checkpoint only explicit paths after checking both the shared index and resulting commit. Report runtime deployment boundaries precisely. Code commits: `4c05e9c2b`, `85851ec39`; committed candidate SHA-256 `079a565db2f1be7ae138b1006e55558f48c966909f00776a974c8a1e4cbfc644` returned `COMMITTED_RELEASE_OK` on private 19127.

Detailed acceptance and remaining boundaries: `docs/product-integrity/chat-gateway-routing-2026-11-16.md`. Shared Go deployment is pending; this plan does not authorize restarting 9527.
