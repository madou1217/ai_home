# Repository Guidelines

> This is the single source of truth for agent/contributor guidance in this repo. `CLAUDE.md` intentionally links here instead of duplicating content.

## Project Overview
`ai-home` (`aih`) manages multi-account sandboxed runs of Codex / Claude / Gemini / Antigravity (agy) and exposes them uniformly as one OpenAI/Anthropic-compatible gateway. Core capabilities: per-`(account, model)` routing and circuit-breaking, model-alias fallback, tmux-compatible persistent CLI sessions, a Herdr/tmux multiplexer abstraction for native headless runs, and a React WebUI.

## Project Structure & Module Organization
- `lib/` contains runtime code, CLI commands, server logic, and service modules.
- `lib/cli/commands/` holds command routers and command entry logic.
- `lib/cli/services/` holds business logic (import/export, PTY, account orchestration, etc.).
- `lib/cli/bootstrap/` wires dependencies between commands and services.
- `test/` contains Node test files (`*.test.js`) covering CLI, backup, PTY, server, and wiring behavior.
- `bin/ai-home.js` is the CLI executable entry.
- Root documentation is intentionally limited to `AGENTS.md` and `README.md`.

Fuller layer map:
- `bin/` — CLI executable entry (`ai-home.js` → `lib/cli/app.js`).
- `lib/cli/app.js` — composition root: imports all bootstrap wiring, dispatches commands.
- `lib/cli/commands/` — command routers (root, ai-cli, backup).
- `lib/cli/services/` — business logic (PTY, account orchestration, import/export, server daemon).
- `lib/cli/bootstrap/` — dependency injection via explicit factory functions, no IoC container.
- `lib/cli/config/` — constants, paths, feature flags.
- `lib/server/` — gateway engine (~143 files): request ingestion → protocol translation → provider routing → circuit-breaking.
- `lib/account/` — account domain: loading, identity, state cache, cross-host sync.
- `lib/sessions/` — session reading: `session-reader.js` parses each provider's history.
- `lib/runtime/` — platform abstraction: `persistent-session.js` owns the current tmux/psmux-backed interactive CLI sessions; `multiplexer/` defines tmux/Herdr drivers used by detached server-side runs; `pty-launch.js` handles PTY launches.
- `lib/usage/` — usage tracking, pricing, cycle scheduling.
- `lib/protocol/` — SSE parsing, tool-call adaptation, token counting.
- `web/src/` — React WebUI (pages + hooks + services).
- `test/` — all test files (`*.test.js`, ~155).

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm test`: run full test suite (`node --test test/*.test.js`).
- `node --test test/backup.router.test.js`: run a focused test file during iteration.
- `node bin/ai-home.js --help`: verify CLI bootstrap and command wiring.
- `npm run postinstall`: repair local executable permissions/hooks (already runs after install).
- `npm run web:dev`: WebUI dev server (`cd web && npm run dev`, Umi Max).
- `npm run build`: build the WebUI (`cd web && npm run build`, Umi Max/Webpack).
- `cd web && npm run lint`: lint the WebUI.
- `.github/workflows/web-build.yml`: on push to `main` and on PRs, install web
  deps and run `npm run lint` + `npm run build` for the WebUI. This is the CI
  gate that catches missing imports/undefined references and other TS compile
  errors that local Node tests cannot see.
- `npm run models:sync`: fetch `https://models.dev/catalog.json`, validate its schema,
  pin its content hash in `data/models-dev/catalog.json`, then regenerate the Go
  `modalities.json` index. Model metadata (modalities, context window, pricing) comes
  from this fixed API snapshot. The command refuses to overwrite dirty generated
  outputs and never commits; both generated files remain reviewable repository changes.
- `npm run models:check`: offline-verify the fixed catalog source/hash/schema and that
  the generated Go index matches it. It never contacts upstream, so unrelated CI and
  runtime work do not fail while the asynchronous updater waits for its next run.
- `.github/workflows/models-dev-sync.yml`: every two hours, asynchronously refresh the
  fixed API catalog and generated Go index, verify both, and commit only those two files
  to `main` when they changed. Runtime startup and inference requests always use the
  last verified local snapshot and never wait for models.dev or GitHub.
- `npm run gateway:routes`: read-only scan of both gateways' HTTP paths and their
  data-plane diff. Backs `docs/architecture/go-node-parity-matrix.md`; `--json`
  for CI. Note it collects path literals, so router scope guards (`/v1/`,
  `/v1beta/`) show up as if they were endpoints — the matrix records which are.
- `npm run gateway:shadow -- --node <url> --go <url> [--include-inference]`:
  send the same requests to both gateways and diff status plus response
  structure. Read-only probes by default (no token cost); `--include-inference`
  adds one minimal request per client protocol. Keys come from flags or
  `AIH_SHADOW_NODE_KEY` / `AIH_SHADOW_GO_KEY` and are never written to disk or
  printed. This is the only evidence that Go can replace Node — unit tests cannot
  see upstream behaviour differences. Re-run it after any change to Canonical
  encode/decode.

## Coding Style & Naming Conventions
- Main body (`lib/`): Node.js CommonJS (`require`, `module.exports`).
- Formatting style in repo: 2-space indentation, semicolons, single quotes.
- File names use kebab-case (for example `account-import-orchestrator.js`).
- Prefer small, composable functions; avoid feature growth in one large file.
- `web/`: TypeScript + React 18 + Ant Design + Umi Max (Webpack build), ESM.

## UI Visual Constraints
- 全局禁止使用大面积的告警/提示块作为页面主内容，包括黄色、蓝色或灰色的整块 `Alert` 卡片；保留无障碍语义，但统一使用紧凑的行内状态、标签或操作旁说明。
- 全局禁止在卡片、状态项、导航项和列表项上使用粗左侧彩色竖条、`border-left` 装饰条或等价的 `inset` 强调条；状态应通过背景、完整边框、图标、标签或留白表达。
- 新增或修改页面必须遵守上述规则，并通过真实页面检查确认不存在大块提示容器和左侧粗竖条。1px 的功能性分隔线仅可用于明确的控件分界，不得作为状态装饰。
- 账号列表及各管理卡片的操作按钮必须保持语义化功能图标（例如 Desktop 使用 `DesktopOutlined`、CLI 使用 `CodeOutlined` 等），严禁将其替换为 Provider 厂商 Logo（`ProviderIcon`），避免与主体厂商图标重复混淆导致失去操作语义。

## Architecture & Layering Principles
- Enforce separation of concerns: each module should have one clear responsibility (composition, domain logic, integration, or I/O).
- Keep orchestration and business logic separate. Flow control modules should delegate behavior to focused service modules.
- Depend inward on abstractions, not outward on concrete implementation details. Avoid circular dependencies across layers.
- Add new behavior by extending focused modules, not by growing “god files.”
- Refactor trigger: if a file mixes unrelated responsibilities or becomes difficult to test in isolation, split it before further feature work.
- Exceptions must be explicit in PR notes, including why boundary-preserving design was not feasible and what follow-up refactor is planned.

## Web UI Componentization (frontend pages)
- 单个页面文件禁止无限堆积。`web/src/pages/` 下的页面一旦超过 ~2000 行，就必须把弹窗、抽屉等 UI 块拆成 `web/src/features/<domain>/` 下的独立受控组件，而不是继续在页面里加 JSX。历史参照：`Accounts.tsx` 从 2538 行拆分后稳定在 ~2000 行，拆出的 `CliPickerModal` / `EditAccountModal` / `ImportAccountsModal` / `AddAccountModal` / `AuthProgressModal` 都在 `web/src/features/accounts/`。
- 拆分组件保持「状态留在页面、行为严格等价」：页面持有 state 和业务 handler，组件通过 `props + 回调` 受控渲染；不要为了拆分把页面级状态挪进组件，也不要顺手改行为。
- 组件文件里的纯函数（文案、派生工具）若同时被页面和其他组件引用，直接 `export` 复用，不要在页面里重复实现。
- 只在纯渲染层转发页面共享状态的小块（例如移动端底部筛选 Drawer / 操作 Sheet，直接转发 `activeProvider`/`filterStatus`/`actionAccount` 及页面 handler）不强制抽取——加 props 管道不降复杂度，KISS/YAGNI 允许留在页面。
- 每拆一个组件必须独立完成「eslint（限改动文件）+ 相关单测 + `npm run build`」验证并独立提交推送，禁止批量拆分、禁止越过验证直接合并。
- **任何改动只要涉及 `web/` 下的源码文件（新增/修改/删除），提交前必须完成并记录三项验证：`cd web && npm run build`（全量 TS 编译，能捕获未导入引用等运行时 ReferenceError 根源）、eslint（限改动文件）、相关单测。** 完成报告必须逐项列出 web 侧验证证据；未运行 `npm run build` 的 web 改动禁止声称已完成，也不得在未验证时提交。历史教训：`Accounts.tsx` 曾因漏导入 `AccountActivityIcon` 导致 WebUI 运行时 `ReferenceError` 整页白屏，本地 Node 测试全部通过而未被发现。

## Agent Runtime Compatibility & Advisor Semantics
- Treat `advisor` as a workflow intent (`independent_review_intent`), not as a guaranteed concrete tool name.
- Never hard-fail solely because a copied Claude/Antigravity prompt references an unavailable `advisor` tool. Resolve the intent through the runtime capability chain first.
- Resolution order: `reviewer_subagent` -> `native_review` -> `self_review` -> `plan_check` -> `warning_noop`.
- `warning_noop` must be explicit and observable; do not silently skip review semantics.
- For high-risk operations (commit, push, destructive file/database changes, production API calls, permission/config mutation), missing reviewer/advisor capability must trigger explicit human confirmation or a documented bypass.
- Keep this compatibility in a focused adapter/resolver layer. Do not scatter `advisor`/`review` string replacements across provider launch code, protocol routers, or prompt templates.
- Preferred design: map runtime-specific tool names into stable workflow intents, then map those intents to the current provider's available capability. Tool aliases handle executable tools; workflow aliases handle stages such as plan, review, self-verify, and advisor.
- Preserve the canonical protocol direction: client protocol -> canonical request/intent -> account/model router -> upstream/provider adapter -> canonical result/events -> client renderer.

## Design Pattern Reporting Requirement
- After completing any non-trivial optimization, compatibility change, architecture change, or runtime behavior change, the final report must list where design patterns were used.
- Required format: `file/module -> pattern -> why it was used -> verification evidence`.
- This section defines the reporting rule only. Do not write task-specific pattern inventories or completion results into `AGENTS.md` or `CLAUDE.md`; put them in the final response or PR notes unless the user explicitly asks to update documentation.
- If no design pattern was appropriate, state that explicitly and explain why KISS/YAGNI rejected adding one.
- Pattern claims must be tied to actual changed code or documentation. Do not claim generic SOLID/Clean Code compliance without pointing to the concrete boundary, module, or abstraction.
- At minimum, review each change against SOLID, KISS, DRY, and YAGNI before reporting completion.

## Persistent sessions and multiplexer integration
- Goal: a CLI session started locally (`aih claude 1`) survives the foreground client and can be explicitly re-attached later — e.g. SSH back into the same host, run `aih claude sessions 1`, and select a compatible exact session. A bare `aih <provider> [id]` launch always creates a fresh session; cwd must never imply re-attach intent. Picker rows marked as legacy runtime or completed/dead intentionally create a fresh compatible replacement instead of attaching.
- **Interactive CLI persistence currently uses the tmux-compatible backend.** `lib/runtime/persistent-session.js` directly owns create, exact attach, listing, closing, and reboot restore through tmux on POSIX and tmux-compatible psmux/tmux binaries on Windows. Fresh launches use `<tmux-command> -u -L <socket> [-f conf] new-session -s <unique-session> -c <cwd> -- <cmd> <args>` without `-A` / `-D`; compatible exact selections use `<tmux-command> -u -L <socket> attach-session [-d] -t <exact-session>` without launching another provider process.
- **tmux is not the repository-wide only multiplexer.** `lib/runtime/multiplexer/` defines tmux and Herdr drivers selected by `AIH_MULTIPLEXER=auto|tmux|herdr`, currently consumed by detached WebUI/background native-run helpers. Herdr is not yet wired into interactive CLI session discovery, attach, close, or reboot restore, so it must not be described as having full interactive parity; verify actual call-site wiring before claiming the auto selection is active end to end.
- Interactive persistent-session addressing model (this is what makes one account run many concurrent windows):
  - **socket = per runtime target** (`aih-<cliName>-<runtimeScope>`, where `runtimeScope` is an `accountRef` or `gateway`): one tmux-compatible server per isolated runtime target, so credentials never cross account boundaries. Secrets ride the process env only — never tmux `-e`/argv (would leak to `ps`).
  - **session = unique launch, grouped by project, or an explicit label**: `p-<basename>-<hash(cwd)>` is a stable project grouping/name prefix, not an implicit re-attach target. Every bare launch allocates an unused exact session name under that prefix. `-S <label>` / `--session <label>` (or `AIH_SESSION=<label>`) is a named upsert for `s-<label>`: create when missing, enter when compatible, or create a replacement sibling when the existing named target is incompatible.
  - **intent controls the operation**: bare launch means strict fresh create. The `sessions` picker / `AIH_SESSION_TARGET` select an exact identity; a successfully probed missing or incompatible exact target fails without creating or substituting a sibling. A picker row already known to be legacy/completed clears the exact target and starts a fresh compatible replacement in that row's project. If an exact identity is already known but the list probe itself is unavailable, attach may still proceed by that identity.
  - **latest selection is separate from exact selection**: `-R` / `-M` select the greatest `session_created` under the current project's generated prefix. An abnormal probe fails closed without attach/create; a healthy empty result may upsert the project base. `-R` takes over the selected latest session and `-M` shares it.
  - The foreground launcher never automatically runs `kill-server`; stale, legacy, incompatible, and unrelated sessions remain untouched. `new-session -A -d` is reserved for reboot restore, where idempotently recreating a registry-owned exact target is required. Normal foreground create/attach paths must not use `-A`.
  - A generated transparent `tmux.conf` (`status off`, `window-size latest`, `escape-time 0`, `extended-keys on` via `-q`) keeps tmux invisible under the aih overlays. Version-sensitive options use `set -gq` so older tmux builds (< 3.2 for `extended-keys`, < 3.5 for `extended-keys-format`) silently skip them — no forced upgrades. The psmux variant of the conf also sets these two options: psmux stores them inertly (its modified-Enter delivery is hardcoded in its own input layer), which makes provider CLIs' `show -gqv extended-keys` probe return `on` and silences their "extended-keys is off" warning.
- Discovery / re-attach UX: `aih <provider> sessions [id]` lists an account's live sessions. The interactive picker passes a compatible selected identity into the exact-target path; legacy/completed rows instead request a fresh compatible replacement. Unnamed parallel siblings must never be entered by emitting a bare command that relies on cwd selection.
- Interactive persistence gating: best-effort — applied only when a tmux-compatible engine is found, stdout is a TTY, the run is not a login/oauth flow, and `AIH_PERSIST_ACTIVE` is unset (avoids nesting). Escape hatch: `AIH_NO_PERSIST=1`.
- Cross-platform for the current interactive CLI path: the backend is real tmux on macOS / Linux / WSL. On **native Windows** `detectTmux()` looks for a tmux-compatible binary — `psmux` (native ConPTY, speaks tmux's CLI) first, then an MSYS2/Cygwin `tmux.exe` (`C:\msys64\usr\bin`, `C:\cygwin64\bin`) or anything named `tmux` on PATH. If none is found, persistence degrades to a plain direct spawn and `sessions` prints an install hint (psmux / MSYS2). The Windows wiring is implemented but needs validation on a Windows host.
- **Reboot survival (registry + restore)**: the current restore path is tmux-compatible. Because those servers are in-memory, every persistent launch also records a small JSON entry under `$AIH_HOME/run/persistent-sessions/` (`lib/runtime/persistent-session-registry.js` — addressing metadata only, never credentials). After a reboot the restore engine (`lib/cli/services/ai-cli/persistent-session-restore.js`) reconciles entries against live servers and re-creates reboot-killed sessions detached, spawning `aih <provider> <cliAccountId>` children with `AIH_PERSIST_DETACHED=1` + `AIH_SESSION_TARGET=<session>` so the full normal launch pipeline (env isolation, config sync) is reused; conversation continuity uses provider-native resume (`codex /resume` by cwd, `claude --continue`). Triggers: server startup (`aih server serve`, covers `aih server autostart` reboots) and lazily on `aih ss`. Sessions whose server is alive but session gone, or whose entry was last seen alive during the current boot, are dropped, not restored.

## Headless CLI runs (`aih <provider> <id> -p …`)
- A non-interactive invocation is a **Unix command, not a session**: stdout carries the model's answer and nothing else, every aih-owned line goes to stderr, no ANSI/OSC is injected, and the child's exit code is propagated (Ctrl-C → 130).
- **Detection has one source of truth.** The per-provider trigger table lives in the Go contract (`core/providers/builtins.go` → `cli.headless` in `contracts/providers/manifest.json`) and is read through `lib/provider-catalog.js` (`getProviderHeadlessConfig`). `lib/cli/services/pty/headless-invocation.js` is the only place that answers "is this call headless?" — never re-derive it inline. Current triggers: claude `-p`/`--print`, codex `exec`, opencode `run`, agy/qoder/qodercn `--print`, grok `--single`; **gemini has no headless entry** and always uses the PTY path.
- A headless run skips the whole interactive shell: no PTY, no tmux wrapper (`lib/cli/services/pty/headless-spawn.js` spawns directly), no raw mode, no resumed stdin, no boot spinner, no usage/clipboard watchers, and no terminal icon / OSC title / iTerm profile / Warp agent mapping (`lib/cli/commands/ai-cli/router.js`).
- Child stdout and stderr stay **separate** (`onData` / `onErrorData`); stderr text still feeds the auth/error scan buffer. stdin is only connected for `--input-format stream-json`.
- Exit waits for stdout/stderr to drain before `process.exit` (`exitAfterFlush` in `pty/runtime.js`) — `process.exit()` discards queued pipe writes, which silently truncated `out=$(aih … -p …)`.
- **Never clear terminal rows on teardown.** The shell drawer only clears rows it actually painted (`shell-drawer-controller.js`); the old unconditional teardown wiped the bottom of the screen on every exit, which erased a `-p` answer as soon as the process ended.
- Waiting must look alive: `lib/cli/services/pty/headless-progress.js` animates the `Running …` line with a spinner + elapsed seconds and replaces it with `✔ … 首字节 <n>s` on the first byte from the child (stdout or stderr). It writes **only to stderr and only when stderr is a TTY**, so `out=$(aih … -p …)` still animates on screen while the captured stdout stays clean, and a redirected stderr gets the plain one-line banner instead. Escape hatch: `AIH_HEADLESS_SPINNER=0`; Windows falls back to ASCII frames.
- Escape hatch: `AIH_HEADLESS_DIRECT_SPAWN=0` forces the PTY path. Side effect: on a TTY that run then falls back into the tmux persistent wrapper, since `shouldPersist` does not inspect argv.

## Server 重启与 launchd 环境安全（2026-08-18 事故教训）
- **绝不在 provider 沙箱会话（agy/codex/opencode 等 auth-projection 环境）里执行 `aih server start/restart/stop`、`aih daemon *`、`aih server autostart *` 或任何 `launchctl bootstrap/kickstart` 类命令。** 沙箱会话的 `HOME` 被覆盖为 `~/.ai_home/run/auth-projections/<provider>/<accountRef>/`；在这些环境里安装/重启 launchd job 会把 `com.clawdcodex.ai_home.plist` 写到投影目录，且 plist 内的 `HOME` 会固化指向沙箱。Server 随后从投影的空 `.ai_home` 启动：账号全 0、无 management key、WebUI 数据面全 503 `webui_unauthorized`，前端被 gate 重定向到 `/server-setup`。
- 重启 Server 前先确认环境：`echo $HOME` 必须是真实家目录（如 `/Users/<user>`），或显式钉住 `AIH_HOST_HOME=/Users/<user>`；不确定就 `env | grep -i home` 检查。
- 症状识别：`curl -s http://127.0.0.1:9527/readyz` 若 `ready: false` 且各 provider 账号全 0，同时 `curl -i http://127.0.0.1:9527/v0/webui/accounts` 返回 503 `webui_unauthorized`，先怀疑 launchd job 的 plist 来源，不要改代码。
- 修复方法：`launchctl bootout gui/$(id -u)/com.clawdcodex.ai_home` 移除错误 job，再用真实家目录的 plist `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.clawdcodex.ai_home.plist` 重新拉起；若投影目录（`~/.ai_home/run/auth-projections/<provider>/<accountRef>/Library/LaunchAgents/`）残留错误 plist 应一并清理。
- Background: on 2026-08-18 13:38 一次在 agy 投影会话中执行的重启导致 launchd 加载了投影 plist（HOME 指向沙箱），Server 以空库启动，WebUI 被强制重定向到 `/server-setup`；账号/密钥数据完好（真实 `app-state.db` 29 行账号未受影响），仅启动环境错误。

## Windows 平台开发陷阱（2026-08-22 WebUI CLI 启动三层事故总结）
所有规则共用一条根知识：**引号经过任何一层 shell/转义边界都会失真**。libuv（`child_process.spawn` 与 node-pty 都用它）会把参数里的 `"` 转义成 `\"`，而 cmd.exe 不认识 `\"`（其 `/c`/`/k` 只按 `/s` 规则剥首尾引号）。当天的三层事故——点击 CLI 图标无窗口只有"叮"一声（`start` 收到 `\"` 乱串永久挂死）→ codex hook 垫片 `if "%~1"==""` 被污染参数击穿（`was unexpected at this time`）→ 修好后暴露 hook 辅助层直接 spawn `.cmd` 抛 `EINVAL`——全是同一根知识的变体，洋葱式地一层层暴露。
- **用 spawn 执行 cmd.exe 命令串**：必须走 `lib/runtime/windows-cmd-launch.js`（`buildWindowsCmdLaunch` 产出 `{file, args, windowsVerbatimArguments}` 规格，`windowsSpawnOptions` 提取 spawn 选项片段），整条命令行自己拼、以 verbatim 关闭 libuv 转义。禁止手写 `spawn('cmd.exe', ['/c', <含引号串>])`；独立探针脚本无法 require 仓库模块时，就地加 `windowsVerbatimArguments: true` 并注释指向该模块。
- **经 PTY/cmd 包装传 CLI 参数**（`buildPtyLaunch` 的 `chcp 65001>nul & …` 包装，node-pty 同样会 `\"` 转义）：参数必须无引号、无空格——`quoteForCmd` 安全类已含 `=`，`key=value` 保持裸文本；需要引号的值（如 provider 显示名）必须走文件通道（codex config.toml 同步），不得进命令行。传输层不变量有测试守卫：**cmd 包装行不允许出现 `"`**（test/pty-launch.test.js、test/codex-provider-args.test.js）。
- **`&&` 链的归属**：`cmd /c start "t" cmd /k set A && set B && <cli>` 的 `&&` 由外层解析，新窗口只拿到第一段；整链必须包进内层 `cmd /d /s /k "…"`（`windows-cmd-launch` 的 newConsole 模式即此形态）。
- **spawn .cmd/.bat 垫片**：Node ≥18.20 直接 spawn 一律 `EINVAL`（CVE-2024-27980 防护）。必须先经 `resolveWindowsUpstreamSpawn`（`lib/runtime/pty-launch.js`）：npm node 垫片解析成 `node.exe + 脚本` 直连（argv 语义正确、可携带任意引号参数）；其余 .cmd 回退 cmd 包装 + verbatim。该函数只在显式 `platform:'win32'` 时介入，posix/未指定平台零行为差异。
- **Store 应用可执行别名（AppExecutionAlias）是 existsSync 的盲区**：`wt.exe` 这类商店应用别名是 0 字节 reparse point，`fs.existsSync`（内部 stat 跟随解析点）对它返回 **false**（指向受 ACL 保护的 WindowsApps，EACCES），而 `where`/`FindFirstFile`、`accessSync`、`lstatSync` 都能看见。探测终端/可执行文件时必须用 `pathEntryExists`（`lib/runtime/client-terminal.js`，existsSync → accessSync → lstat 三级探测），否则 WT 会被误报"未安装"。
- **「默认终端应用」deflection 从隐藏父进程启动时不生效**：detached + windowsHide 的启动链里，`start cmd` 创建的新控制台只会被 conhost 承载（拿到"cmd 窗口"），Win10/11 的默认终端 deflection 不会介入。因此 `system-default` 适配器在 Windows 上探测到 `wt.exe` 时直接委托 Windows Terminal 适配器，未装 WT 的机器才走 `start cmd` 兜底；Windows 终端列表**没有「系统默认」概念**（`listClientTerminals` 的 `applyWindowsTerminalPresentation`）：默认 Windows Terminal、其次 CMD，default 标记跟随探测结果。
- **wt.exe 子命令陷阱（1.24 实测）**：`wt new-window` 不是合法子命令——wt 把它当待运行程序名，打开一个标题为 `new-window` 的失败窗口且 stdio ignore 下完全静默。强制新窗口的唯一写法是全局选项 **`wt -w new new-tab --title <t> cmd.exe /k <cmd>`**；裸 `new-tab` 会把标签塞进最近使用的既有 WT 窗口（目标窗口在别的虚拟桌面/最小化时，用户表现为"点了没反应"）。
- **spawn GUI 宿主终端（wt.exe）禁止 windowsHide:true**：`CREATE_NO_WINDOW` 会把 WT 新窗口创建成**隐藏窗口**——进程链完全正常、E2E 只查进程会误判通过，但用户什么都看不到（2026-08-22 对照实验：仅 windowsHide true/false 之差，窗口 visible=False/True）。wt 启动规格必须声明 `windowsHide: false` 并由 spawner 透传（`client-terminal.js`）；cmd.exe 瞬态启动器不受影响（真正窗口由 `start` 创建）。
- **给用户开可见终端**：detached + windowsHide 的进程自身无控制台；须经 `start`（或 wt.exe 适配器）创建，新窗口由系统"默认终端应用"承载（Win10/11 通常即 Windows Terminal）。
- **服务重启环境安全（Windows 补充）**：`resolveHostHomeDir` 优先序为 `AIH_HOST_HOME` → `USERPROFILE` → `HOMEDRIVE/HOMEPATH` → `HOME`，投影 HOME 不会污染 `.ai_home` 定位，但重启前仍按上一节规程检查并钉住 `AIH_HOST_HOME`；`aih server restart` 不接受 serve 参数、以保存配置为唯一事实来源，重启前先 `aih server config show` 核对（host/port/proxy_url/models_probe_accounts），验证以 `/readyz` + 账号数 + accounts 端点 401（而非 503）为准。
- **本机调试纪律**：PowerShell 一律走 `.ps1` 脚本文件（bash 内联会吞 `$_` 等）；bash heredoc 会把 `\\` 折叠成 `\`（JS 字符串里 `\n`/`\t` 随之变控制字符），写含反斜杠路径的代码/测试用编辑工具而非 heredoc；进程取证用 `Get-CimInstance Win32_Process`（`CommandLine` 是原始命令行，`\"` 污染一眼可辨；高频采样可抓到瞬时子进程）；spawn `EINVAL` 用 `NODE_DEBUG=child_process` 定位调用方。
- **Windows 全量 `npm test` 存在既有卡死/失败**（`web-ui-router.projects` 挂起、native 会话类及依赖本机真实安装状态的用例），与代码改动无关；判定是否回归用 git stash A/B 对照是最快手段（本日三次使用均以逐字节一致结果排除嫌疑）。
- **WSL 与 Windows 共用配置时的路径互通**：`/mnt/<drive>/...` 与 `<drive>:\...` 指向同一文件但互不认路径（blender MCP 的 `/mnt/c/...uvx.exe` 在 Windows 原生 codex 报 os error 3，且坏 MCP 会连累 `codex_apps` 等后续 MCP 未初始化）。自愈在 `lib/cli/services/pty/codex-config-heal.js`（codex 启动时自动执行，MCP 与 projects 两类）：跨端路径可无损转换且目标存在 → 改写为当前平台路径（备份 + 日志，幂等）；绝对路径两种形态都不存在 → 移除条目；相对命令（uvx/npx 走 PATH）、`~`、环境变量路径不强求、原样保留。`[projects.*]` 信任表同用此策略（WSL/Windows 双跑产生双形态重复条目：保本平台形态、删外来重复；死条目清理）。注意 TOML 双引号基本串的 `\\` 需反转义。另一根因：`resolveHostHomeDir` 此前忽略调用方注入的 `options.hostHomeDir`（现为最高优先级），测试与运行时曾因此把 projects 信任写进真实宿主 `~/.codex/config.toml`（`aih-remove-project-*` 垃圾条目）。

## Gateway & Account Internals
- Gateway routing (`lib/server/`): request enters → `router.js` (account selection + failure/success accounting) → `capability-router.js` (route by provider capability) → `protocol-*.js` (OpenAI/Anthropic/Gemini protocol translation) → upstream.
- Account unique identity: `accountRef` is the persisted DB primary key and the only identity used by server, WebUI, runtime, events, and usage. `cliAccountId` is only a mutable numeric alias for CLI input/display. Registration derives `accountRef` once from the provider identity seed through `lib/account/account-registration.js`; no `unique_key` column or profile-directory identity fallback exists.
- **Account authorization scope:** AIH remains a local, single-operator control plane. Do not absorb or introduce account-level RBAC, tenant roles, per-account ACLs, permission hierarchies, or equivalent authorization products. Preserve the existing Client Key and Management Key trust boundaries; repairing those existing boundaries is security maintenance, not permission-scope expansion.
- Model alias + circuit-breaking: aliases resolve fallback at runtime and `/v1/models` does not expose the wildcard `claude-*`; 429s trip a circuit breaker at `(account, model)` granularity rather than locking the whole account.
- WebUI real-time push: `session-event-bus.js` → `webui-sse-broadcaster.js` → browser SSE connection.
- **kimi 桌面版登录态与托管扫码登录（2026-08-19 取证结论）：桌面 App（Kimi Work，Electron）的登录态是 kimi.com Web session（HS512 JWT，iss=account、aud=kimi.com，refresh TTL ~90 天，App 内自动续期）；与 ai_home 持有的 kimi-code CLI OAuth token（iss=kimi-auth、scope=kimi-code）是两套凭证，实测全新 CLI token 打 `www.kimi.com/api/user`、`/api/auth/token/refresh`、`AuthService/ConfirmLoginQRCode` 均 401，无互换通道。** 权威存储是主进程 token 仓 `<userDataDir>/bridge-store/token-store.json`（`{encryption:"safeStorage.v1", data}`，data 为 Chromium v10 AES-256-GCM，密钥 = 同 profile `Local State` 的 `os_crypt.encrypted_key` 经 DPAPI(CurrentUser) 解出；渲染层 localStorage 只是镜像）。**App 明确拒绝一切调试开关**（`--remote-debugging-port`/`--remote-debugging-pipe` 启动即 exit 1，stderr "[kimi] refusing to start with debug switch present"），不要再尝试 CDP 注入。可行链路（已实现）：webUI 扫码一次走官方 `auth.kimi.com/api/account.gateway.v1.AuthService`（CreateLoginQRCode → 微信扫码 → GetLoginQRCodeStatus(SUCCESS) 拿 web token，路由 `/v0/webui/accounts/kimi/:ref/desktop-session/start|poll`，托管进 `nativeAuth.desktopSession`）→ 启动前 `lib/server/kimi-desktop-injector.js` 把 session 离线加密写进隔离 profile 的 token 仓（Windows DPAPI 属用户域，可离线加解密；Local State 缺失时预写自生成 key）→ App 自行续期并轮换 refresh_token → 下次启动先 adopt 回读 profile 轮换结果再 seed，托管链自愈。仅 Windows；macOS/Linux safeStorage 走系统密钥环，格式不同，seed 直接跳过。
- **kimi refresh_token 轮换与多端协调（2026-08-19 实测）：kimi 的 refresh_token 是"用一次就轮换"，且多条未使用的 refresh_token 链可以并行有效。** kimi-code CLI（OAuthManager.ensureFresh）每次刷新前都重读凭证文件、失败后还会再读一次做恢复，只有连续读到旧 grant 才写 revoked tombstone。server 侧（daemon/relay/quota 共用 `lib/server/kimi-token-refresh.js`）的规则：刷新前先 reconcile 吸收两处可能更新的 grant——host `~/.kimi-code`（调用方注入 `reconcileHostCredentials`）和账号 projection（`<projection>/.kimi-code`，aih 沙箱 CLI 真正写的文件，内置 reconcile）；刷新成功后把新凭证写回 projection（及 host），写回带 CAS：文件里的 refresh_token 不是本次被消费的那个就放弃覆盖（说明 CLI 持有另一条独立链，不能踩）。缺了写回，长驻 CLI 会话下一次续期会撞上已被消费掉的旧 grant 并 tombstone 掉自己的凭证文件。
- **zcode provider scope (2026-08-19): OAuth 计划账号只做账号管理、桌面 App 启动、用量/额度查看，不做推理 relay。** `zcode.z.ai/api/v1/zcode-plan/*` 是 ZCode 桌面端的私有通道（闪促活动窗口 + 设备态 + 阿里云验证码三重门，405/3012 已由两天端到端取证确认客户端侧无解），不要再尝试对它做 relay。正规 relay 走官方 Coding Plan 端点 + API Key（zcode API-key 账号）：Anthropic `open.bigmodel.cn/api/anthropic` 或 `api.z.ai/api/anthropic`，OpenAI Chat `.../api/coding/paas/v4`，Responses `.../api/v1`（docs.bigmodel.cn / docs.z.ai 的 coding-plan/tool/others）。
- **zcode 桌面启动的 HOME 沙箱化（2026-08-19）：ZCode 的 settingService 写死按 `HOME || USERPROFILE`（HOME 优先）定位 `<home>/.zcode/v2/setting.json`，无视 `ZCODE_DATA_BASE_DIR`/`ZCODE_HOME`。** setting.json 持有 `modelProviderFamilySelectedKeys`/`providerFamilyDomain` 等套餐选择状态；若 HOME 留在真实家目录，所有账号实例共享一份 setting.json 互踩，表现为"看着登录了但套餐未连接/无可用模型"的假登陆。`account-app-launcher.js` 的 zcode 桌面分支因此把 `HOME` 指向账号沙箱。**绝不能同时改 `USERPROFILE`**——实测 Windows 上 USERPROFILE 指向投影会让 ZCode 主进程在 deep-link 注册前静默卡死。z.ai-only 账号的"编程套餐（BigModel）"卡片显示"未连接"是产品行为（需单独 BigModel OAuth），不是故障。
- **zcode 会话状态跨账号共享（2026-08-19）：`launch-profile/zcode-shared-session-store.js` 在每次启动（CLI 与桌面都经过 `zcodeStrategy.prepare`）把会话数据链接回宿主 `~/.zcode`**：`v2/tasks-index.sqlite`（含 -wal/-shm，文件符号链接）、`v2/sessions`、`v2/session-bindings`、`v2/checkpoints`、`cli/`、`workspace/`、`plugin-workspace/`（目录 junction）。身份文件（credentials.json、config.json、setting.json、缓存、日志）保持每账号私有。SQLite 干净关闭会经投影路径删掉 wal 链接，下次启动自动修复。**不做任何复制/迁移/备份**：投影路径上的真实残留数据直接就地删除再建链，宿主 `~/.zcode` 是唯一数据源。

## Testing Guidelines
- Framework: built-in Node test runner (`node:test`) with `assert/strict`.
- Name tests by behavior, e.g. `test('runGlobalAccountImport reports provider progress callback', ...)`.
- Add/adjust tests for every behavior change, including fallback paths and error handling.
- Run targeted tests first, then run full `npm test` before submitting changes.
- Repository policy tests must keep root generated bundles and non-whitelisted Markdown out of source control.

## Git Worktree & Branch Safety
- **Only `main` may be kept long-term.** Do not keep feature branches around: once work lands on `main`, delete the temporary branch. Never leave commits that exist only on a side branch or a detached HEAD.
- Do not create git worktrees or git branches unless the user explicitly approves that operation for the current task.
- Do not use worktree or branch creation as the default isolation strategy for agent work.
- If a worktree is used, it must not be released (removed/pruned) until all of its commits have been merged into the main project's `main`. Verify with `git cherry main <worktree-head>` (or `git log main..<head>`) that nothing remains before releasing it.
- Resolve integration inside the worktree first: rebase/merge `main` into the worktree branch and resolve conflicts there, run tests there, so landing on `main` in the primary workspace is a clean fast-forward (or trivial merge) with minimal conflict probability.
- Before merging or cherry-picking from an existing worktree or branch, inspect its status, commit divergence, and diff scope; report the proposed source and affected files first.
- Treat pruning or deleting worktrees as a destructive cleanup step; ask for explicit approval before running it.
- **Never discard local unpushed commits.** When a rebase hits conflicts, prefer `git rebase --abort` and re-plan; never `git reset --hard origin/main` (or any hard reset) while the branch carries unpushed work. Before any destructive history operation, tag the current HEAD as a backup (e.g. `backup/<date>-<topic>`) and confirm the operation with the user.
  - Background: on 2026-08-14 a session aborted a conflicting rebase and then ran `reset --hard origin/main`, silently dropping 13 local commits (~17k insertions, including the full kimi integration) plus leaving a 3k-line stash. Recovery cost far exceeded the merge it was trying to avoid.
- When multiple agent sessions share this repository, each session must assume another session may hold unpushed commits; check `git reflog` for recent `reset`/`rebase` operations before rewriting history, and never reset past commits you did not create.

## Commit & Pull Request Guidelines
- Follow conventional-style messages seen in history: `feat(...)`, `fix(...)`, `refactor(...)`.
- Keep commits focused (one logical change per commit).
- PRs should include:
  - purpose and scope,
  - key files changed,
  - test evidence (commands + pass result),
  - screenshots/log snippets for CLI UX changes when relevant.

## Security & Configuration Tips
- Never commit real tokens or credential exports.
- Validate import paths and avoid absolute/parent traversal inputs.
- Prefer environment-based configuration for sensitive runtime settings.
