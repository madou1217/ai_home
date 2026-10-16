# Agent CLI 用法基线（aih 托管）

> 生成命令：`npm run providers:usage -- --write`　生成时间：2026-10-16T16:23:57.445Z
> 这是**当前各 CLI 版本**的用法快照。升级 CLI 后重跑本命令，并与本文档 /
> `agent-cli-usage.snapshot.json` 做 diff：新增的参数、子命令、slash 提示一眼可见。
> slash 命令多数只在 TUI 内出现，本机实测后补记到「slash 命令」小节。

## 版本快照

| provider | CLI | 版本 | aih 统一 resume | 原生 resume 形态 |
| --- | --- | --- | --- | --- |
| codex | codex | codex-cli 0.163.0 | `aih codex resume <id>` | `codex-thread`：resume |
| gemini | gemini | 0.64.0 | `aih gemini resume <id>` | `gemini-session-file`：--session-file |
| claude | claude | 2.1.301 (Claude Code) | `aih claude resume <id>` | `claude-session`：--resume --continue |
| agy | agy | 1.4.0 | `aih agy resume <id>` | `agy-conversation`：--conversation |
| opencode | opencode | opencode v2.0.29 | `aih opencode resume <id>` | `opencode-session`：--session |
| grok | grok | grok 1.0.46 (2765805b9442) | `aih grok resume <id>` | `grok-session`：--resume |
| qoder | qodercli | 1.1.72 | `aih qoder resume <id>` | `qoder-session`：--continue --resume |
| qodercn | qoderclicn | 1.1.72 | `aih qodercn resume <id>` | `qoder-session`：--continue --resume |
| kimi | kimi | 2.2.0 | — | TUI 内：`-c` `-C` `/sessions` |
| kiro | kiro-cli | （未安装） | — | TUI 内：`/rewind` `/chat new` |
| zcode | zcode | （未安装） | — | 未声明会话边界 |
| codebuddy | codebuddy | 2.161.4 | `aih codebuddy resume <id>` | `codebuddy-family-resume`：--resume |
| codebuddycn | codebuddycn | （未安装） | `aih codebuddycn resume <id>` | `codebuddy-family-resume`：--resume |
| workbuddy | workbuddy | （未安装） | `aih workbuddy resume <id>` | `codebuddy-family-resume`：--resume |
| workbuddycn | workbuddycn | （未安装） | `aih workbuddycn resume <id>` | `codebuddy-family-resume`：--resume |
| cline | cline | 3.0.72 | `aih cline resume <id>` | `cline-session`：--id |

## aih 统一入口（所有 provider 共用一套动词）

- `aih <cli> resume [<id>]`：续接上一段对话；省略 `<id>` 时用该 CLI 的「最近一段」（没有安全退路的会明确报错）。
- `aih <cli> fork [<id>]`：从上一段对话**分叉**出新会话（原对话不动）；无 fork 能力的 provider 明确拒绝。
- `aih <cli> <账号> resume|fork [<id>]`：指定账号续接 / 分叉。
- `aih <cli> resume --help`：打印统一动词与各 provider 原生形态对照表。
- `aih <cli> <任意原生参数>`：**完整透传**（`aih codex exec …`、`aih claude --model …` 都走原生），统一动词不影响它。
- `aih <cli> -- <任意原生参数...>`：**逃生门** —— `--` 之后逐字交给原生 CLI，即使撞上 aih 自己的保留字（ls / login / sessions / resume …）也不拦截。
- 事实来源：`contracts/providers/manifest.json` 的 `nativeBoundary.sessions.flags`；翻译表 `lib/runtime/provider-resume.js`。

## 各 provider 明细

### codex（codex-cli 0.163.0）

- 二进制：`/Users/model/.local/bin/codex`
- 版本命令：`codex --version`
- 合同声明的会话入口：`resume` `fork`
- 统一续接：`aih codex resume <id>` → 原生 `resume <id>`
- 统一续接（不带 id）：→ 原生 `resume`

<details><summary><code>codex resume --help</code> 关键行</summary>

```
Resume a previous interactive session (picker by default; use --last to continue the most recent)
Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]
  [SESSION_ID]
          Session id (UUID) or session name. UUIDs take precedence if it parses. If omitted, use
          --last to pick the most recent recorded session
          Optional user prompt to start the session
      --last
          Continue the most recent session without showing the picker
          Show all sessions (disables cwd filtering and shows CWD column)
          Include non-interactive sessions in the resume picker and --last selection
          Error out when config.toml contains fields that are not recognized by this version of
          Run the session in a new managed Git worktree
  -V, --version
          Print version
```
</details>

<details><summary><code>codex exec --help</code> 关键行</summary>

```
Usage: codex exec [OPTIONS] [PROMPT]
  resume  Resume a previous session by id or pick the most recent with --last
  fork    Fork a previous session by id into a new session
          Error out when config.toml contains fields that are not recognized by this version of
          Run the session in a new managed Git worktree
          Run without persisting session files to disk
  -V, --version
          Print version
```
</details>

### gemini（0.64.0）

- 二进制：`/opt/homebrew/bin/gemini`
- 版本命令：`gemini --version`
- 合同声明的会话入口：`--resume` `--session-id` `--list-sessions` `--session-file`
- 统一续接：`aih gemini resume <id>` → 原生 `--resume <id>`
- 统一续接（不带 id）：→ 原生 `--resume latest`

<details><summary><code>gemini --help</code> 关键行</summary>

```
Usage: gemini [options] [command]
  -i, --prompt-interactive        Execute the provided prompt and continue in interactive mode  [string]
      --skip-trust                Trust the current workspace for this session.  [boolean] [default: false]
  -r, --resume                    Resume a previous session. Use "latest" for most recent or index number (e.g. --resume 5)  [string]
      --session-file              Load a session from a JSON file  [string]
      --session-id                Start a new session with a manually provided UUID.  [string]
      --list-sessions             List available sessions for the current project and exit.  [boolean]
      --delete-session            Delete a session by index number (use --list-sessions to see available sessions).  [string]
  -v, --version                   Show version number  [boolean]
```
</details>

### claude（2.1.301 (Claude Code)）

- 二进制：`/Users/model/.local/bin/claude`
- 版本命令：`claude --version`
- 合同声明的会话入口：`--continue` `--resume` `--session-id` `--fork-session`
- 统一续接：`aih claude resume <id>` → 原生 `--resume <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>claude --help</code> 关键行</summary>

```
Usage: claude [options] [command] [prompt]
Claude Code - starts an interactive session by default, use -p/--print for
  --agent <agent>                       Agent for the current session. Overrides
  --bg, --background                    Start the session in the background and
                                        --resume <session-id>, continues that
                                        session in the background under the same
                                        the session is already running
  --cloud [description|session_id|url]  Create a cloud session with the given
                                        one by session ID or claude.ai/code URL
  -c, --continue                        Continue the most recent conversation in
                                        of the terminal (with --continue or
                                        --resume <id> to pick the session)
  --effort <level>                      Effort level for the current session
  --environment <environment_id>        Create a new cloud session that runs on
  --fork-session                        When resuming, create a new session ID
                                        with --resume or --continue)
  --from-pr [value]                     Resume a session linked to a PR by PR
  --ide                                 Automatically connect to IDE on startup
  --model <model>                       Model for the current session. Provide
  -n, --name <name>                     Set a display name for this session
                                        (shown in the prompt box, /resume
  --no-session-persistence              Disable session persistence - sessions
                                        resumed (only works with --print)
  --permission-mode <mode>              Permission mode to use for the session
                                        for this session only; a folder of
                                        session only (repeatable: --plugin-url A
  --remote-control [name]               Start an interactive session with Remote
  --remote-control-session-name-prefix <prefix>
      Prefix for auto-generated Remote Control session names (default: hostname)
  -r, --resume [value]                  Resume a conversation by session ID, or
  --session-id <uuid>                   Use a specific session ID for the
```
</details>

### agy（1.4.0）

- 二进制：`/Users/model/.local/bin/agy`
- 版本命令：`agy --version`
- 合同声明的会话入口：`--continue` `--conversation`
- 统一续接：`aih agy resume <id>` → 原生 `--conversation <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>agy --help</code> 关键行</summary>

```
  --agent                         Agent for the current CLI session
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)
  --model                         Model for the current CLI session
  --new-project                   Create a new project for this session
  --project                       Project ID or project name for the current CLI session
  --prompt-interactive            Run an initial prompt interactively and continue the session
  --remote-control                Create a remote connection for the CLI session on start up
```
</details>

### opencode（opencode v2.0.29）

- 二进制：`/Users/model/.opencode/bin/opencode`
- 版本命令：`opencode --version`
- 合同声明的会话入口：`--continue` `--session` `--fork`
- 统一续接：`aih opencode resume <id>` → 原生 `--session <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>opencode run --help</code> 关键行</summary>

```
  --continue, -c          Continue the last session
  --session, -s string    Session ID to continue, or to create if it does not exist
  --fork                  Fork the session before continuing
  --title string          Session title
  --version, -v                                                       Show version information
```
</details>

### grok（grok 1.0.46 (2765805b9442)）

- 二进制：`/Users/model/.grok/bin/grok`
- 版本命令：`grok --version`
- 合同声明的会话入口：`--continue` `--resume` `--session-id`
- 统一续接：`aih grok resume <id>` → 原生 `--resume <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>grok --help</code> 关键行</summary>

```
Usage: grok [OPTIONS] [PROMPT] [COMMAND]
          Initial prompt for the interactive session, e.g. `grok "fix the bug"` or `grok --worktree=feat "create this feature"`
  -c, --continue
          Continue the most recent session for the current working directory
      --fork-session
          When resuming (`--resume` / `--continue`), create a new session ID instead of reusing the original (optionally set via `--session-id`)
          Open in the standard fullscreen TUI for this session, overriding a config `[ui] screen_mode = "minimal"` preference. Session-scoped only, does not write config. Fullscreen-vs-inline still follows the alt-screen policy (--no-alt-screen, [terminal] alt_screen, terminal auto-detection)
          Experimental: scrollback-native rendering. Finalized blocks are printed into the terminal's native scrollback (use the terminal's own scroll / selection). Session-scoped only, does not write config
          - streaming-json:          NDJSON: one ACP session update per line, the agent's native format
  -r, --resume [<SESSION_ID_OR_TITLE>]
          Resume a session by ID or title, or the most recent if omitted. Non-ID values match session titles for the current directory, ignoring letter case; UUID-shaped values always mean IDs. Among duplicate titles a sole renamed match wins; otherwise the resume fails as ambiguous
          Restore the original session's repository snapshot when resuming. Remote sessions require `--worktree` (never checks out into the current directory). Without this flag, resume restores conversation only
  -s, --session-id <SESSION_ID>
          Use a specific session UUID for a **new** conversation (must be a valid UUID and must not already exist under the target session directory). With `--resume`/`--continue`, only valid together with `--fork-session` (names the forked session). Does not resume existing sessions, use `--resume` / `--continue` instead
  -v, --version
          Print version
          Start the session in a new git worktree, optionally named. With `--resume` of a remote session, pass `--restore-code` to apply the snapshot codebase (conversation is restored either way)
  dashboard      Open the Agent Dashboard view at startup. The dashboard shows every session, top-level and subagents. Disabled when `[dashboard].enabled = false` in `~/.grok/config.toml` or when the `GROK_AGENT_DASHBOARD=0` env var is set
  export         Export a session transcript as Markdown
  memory         Manage cross-session memory
  sessions       List, search, or restore sessions
  trace          Export or upload session trace data
  update         Check for updates or install a specific version
  usage          Print persisted token and cost usage for a session
  version        Print version information [aliases: v]
```
</details>

### qoder（1.1.72）

- 二进制：`/Users/model/.local/bin/qodercli`
- 版本命令：`qodercli --version`
- 合同声明的会话入口：`--continue` `--resume` `--fork-session`
- 统一续接：`aih qoder resume <id>` → 原生 `--resume <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>qodercli --help</code> 关键行</summary>

```
Usage: qodercli [options] [command] [query...]
  -m, --model <model>                  Model for the current session. Default
  -i, --prompt-interactive <text>      Execute prompt and continue in
  -c, --continue                       Continue the most recent session
  --fork-session                       Create a new session from a resumed
  -r, --resume [id]                    Resume a previous session by identifier
  -n, --name <name>                    Set a display name for this session
  --session-id <id>                    Use a specific session ID
  --remote [task]                      Create a cloud remote session and print
  --remote-session <id>                Cold-load and attach to an existing
                                       remote session
  --teleport <id>                      Load and attach to a remote session
  --list-sessions                      List available sessions and exit
  --delete-session <index>             Delete a session by index number
  --no-session-persistence             Disable session persistence - sessions
                                       resumed (only works with --print)
  --agent <name>                       Agent for the current session
  --system-prompt <text>               System prompt for the session
  --output-style <style>               Output style for this session
  -v, --version                        output the version number
  rollback [options]                   Rollback to a previous version
  update [options]                     Update to the latest version
  status [options]                     Show session status
```
</details>

### qodercn（1.1.72）

- 二进制：`/Users/model/.local/bin/qoderclicn`
- 版本命令：`qoderclicn --version`
- 合同声明的会话入口：`--continue` `--resume` `--fork-session`
- 统一续接：`aih qodercn resume <id>` → 原生 `--resume <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>qoderclicn --help</code> 关键行</summary>

```
Usage: qoderclicn [options] [command] [query...]
  -m, --model <model>                  Model for the current session. Default
  -i, --prompt-interactive <text>      Execute prompt and continue in
  -c, --continue                       Continue the most recent session
  --fork-session                       Create a new session from a resumed
  -r, --resume [id]                    Resume a previous session by identifier
  -n, --name <name>                    Set a display name for this session
  --session-id <id>                    Use a specific session ID
  --remote [task]                      Create a cloud remote session and print
  --remote-session <id>                Cold-load and attach to an existing
                                       remote session
  --teleport <id>                      Load and attach to a remote session
  --list-sessions                      List available sessions and exit
  --delete-session <index>             Delete a session by index number
  --no-session-persistence             Disable session persistence - sessions
                                       resumed (only works with --print)
  --agent <name>                       Agent for the current session
  --system-prompt <text>               System prompt for the session
  --output-style <style>               Output style for this session
  -v, --version                        output the version number
  rollback [options]                   Rollback to a previous version
  update [options]                     Update to the latest version
  status [options]                     Show session status
```
</details>

### kimi（2.2.0）

- 二进制：`/Users/model/.nvm/versions/node/v22.16.0/bin/kimi`
- 版本命令：`kimi --version`
- 合同声明的会话入口：`-c` `-C` `/sessions`
- 统一 resume：不支持 —— 会话入口在 TUI 内（合同声明：-c -C /sessions）。

<details><summary><code>kimi --help</code> 关键行</summary>

```
Usage: kimi [options] [command]
  -V, --version                 output the version number
  -S, --session [id]            Resume a session. With ID: resume that session. Without ID:
  -c, --continue                Continue the previous session for the working directory. (default:
  --agent <name>                Agent profile to start the new session with. Custom profiles are
                                be combined with --session/--continue.
                                new session. Cannot be combined with --session/--continue. (default:
  --add-dir <dir>               Add an additional workspace directory for this session. Can be
  export [options] [sessionId]  Export a session as a ZIP archive.
  fork [options] [sessionId]    Fork a session into a new session.
  session                       Manage sessions non-interactively.
  vis [options] [sessionId]     Launch the session visualizer in your browser.
  upgrade|update [options]      Upgrade Kimi Code to the latest version.
```
</details>

### codebuddy（2.161.4）

- 二进制：`/Users/model/.local/bin/codebuddy`
- 版本命令：`codebuddy --version`
- 合同声明的会话入口：`--continue` `--resume` `--session-id`
- 统一续接：`aih codebuddy resume <id>` → 原生 `--resume <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>codebuddy --help</code> 关键行</summary>

```
Usage: codebuddy|cbc [options] [command] [prompt]
CodeBuddy Code - starts an interactive session by default, use -p/--print for
  -V, --version                                    output the version number
  --subagent-permission-mode <mode>                Default permission mode for subagents/teammates (choices: "acceptEdits", "bypassPermissions", "default", "plan", "dontAsk", "auto"). Overrides inheritance from main session.
  -c, --continue                                   Continue the most recent conversation (default: false)
  -r, --resume [sessionId]                         Resume a conversation - provide a session ID or interactively select a conversation to resume (default: false)
  -w, --worktree [name]                            Create a git worktree and start the session in it (optionally specify a name, PR number like "#123", or PR URL)
  --tmux                                           Create worktree in a new tmux session (requires --worktree) (default: false)
  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (default-model, fast-model, balanced-model, primary-model, deep-model, hy4-preview, hy3, deepseek-v4.1-flash, gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gemini-3.5-flash, glm-5.3-flash, glm-5.3, glm-5.2, kimi-k3, kimi-k2.6, kimi-k2.8-preview)
  --ide                                            Automatically connect to IDE on startup if exactly one valid IDE is available (default: false)
  -v, --version                                    Output the version number (default: false)
  --session-id <uuid>                              Use a specific session ID for the conversation (supports letters, numbers, hyphens, underscores, and colons, but must start with a letter or number)
  --resume-create-missing                          With --resume: when the target session no longer exists, start a new empty session with the same id instead of failing (job worker respawn recovery path; explicit user --resume still errors)
  --no-session-persistence                         Disable session persistence - sessions stay in memory and are not saved to disk
  --teleport <value>                               Teleport to existing sandbox (format: session_{cliSessionId})
  --system-prompt <prompt>                         Override the system prompt for this session
  --agent <agent>                                  Default main agent for this process (TUI, --print/headless, --serve Web, ACP). Headless tool use must be pre-authorized (for example with -y). Overrides lastUsed for new sessions; does not write settings.
  --fork-session                                   When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)
  --bg                                             Run the session in the background (detached) (default: false)
  --name <name>                                    Name for background session (used with --bg)
  --exec <command>                                 With --bg: run a shell command as a background job instead of a model session
  install [target]                                 Install CodeBuddy Code native build. Use [target] to specify version (latest, or specific version)
  ps [options]                                     List all active sessions (interactive, background, daemon)
  logs [options] <pidOrName>                       Show logs for a background session
  attach <pidOrName>                               Attach to a running background session
  kill <pidOrName>                                 Terminate a background session
  stop <pidOrName>                                 Stop a background session (alias for kill)
  rm <idOrName>                                    Remove a background session from agent view (the transcript stays on your machine)
  respawn [options] [idOrName]                     Restart a background session with its conversation intact
  agents [options]                                 Open agent view to dispatch and manage background sessions
```
</details>

### cline（3.0.72）

- 二进制：`/opt/homebrew/bin/cline`
- 版本命令：`cline --version`
- 合同声明的会话入口：`--id`
- 统一续接：`aih cline resume <id>` → 原生 `--id <id>`
- 统一续接（不带 id）：→ 原生 `（报错：需要精确会话 id）`

<details><summary><code>cline --help</code> 关键行</summary>

```
Usage: cline [options] [command] [prompt]
  -V, --version                 Output the version number
                                interactive sessions
  --id <session-id>             Resume an existing session by ID
  -m, --model <model-id>        Model to use for the session with the selected
  -z, --zen                     Start a session that runs in the background hub
  history|h [options]           List session history or manage saved sessions
  version                       Show Cline CLI version number
```
</details>

## 本机未安装（无法采集，装好后重跑本脚本即可补齐）

- kiro、zcode、codebuddycn、workbuddy、workbuddycn

