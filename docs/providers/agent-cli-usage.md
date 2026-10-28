# Agent CLI 用法基线（aih 托管）

> 生成命令：`npm run providers:usage -- --write`　生成时间：2026-10-28T04:59:33.587Z
> 这是**当前各 CLI 版本**的用法快照。升级 CLI 后重跑本命令，并与本文档 /
> `agent-cli-usage.snapshot.json` 做 diff：新增的参数、子命令、slash 提示一眼可见。
> slash 命令多数只在 TUI 内出现，本机实测后补记到「slash 命令」小节。

## 版本快照

| provider | CLI | 版本 | aih 统一 resume | 原生 resume 形态 |
| --- | --- | --- | --- | --- |
| codex | codex | codex-cli 0.165.0 | `aih codex resume <id>` | `codex-thread`：resume |
| gemini | gemini | （未安装） | `aih gemini resume <id>` | `gemini-session-file`：--session-file |
| claude | claude | 2.1.312 (Claude Code) | `aih claude resume <id>` | `claude-session`：--resume --continue |
| agy | agy | （未安装） | `aih agy resume <id>` | `agy-conversation`：--conversation |
| opencode | opencode | 1.18.18 | `aih opencode resume <id>` | `opencode-session`：--session |
| grok | grok | grok 1.0.70 (f50904eaee6c) | `aih grok resume <id>` | `grok-session`：--resume |
| qoder | qodercli | 1.1.80 | `aih qoder resume <id>` | `qoder-session`：--continue --resume |
| qodercn | qoderclicn | 1.1.80 | `aih qodercn resume <id>` | `qoder-session`：--continue --resume |
| kimi | kimi | （未安装） | — | TUI 内：`-c` `-C` `/sessions` |
| kiro | kiro-cli | （未安装） | — | TUI 内：`/rewind` `/chat new` |
| zcode | zcode | （未安装） | `aih zcode resume <id>` | `zcode-session`：--resume --continue |
| codebuddy | codebuddy | （未安装） | `aih codebuddy resume <id>` | `codebuddy-family-resume`：--resume |
| codebuddycn | codebuddycn | （未安装） | `aih codebuddycn resume <id>` | `codebuddy-family-resume`：--resume |
| workbuddy | workbuddy | （未安装） | `aih workbuddy resume <id>` | `codebuddy-family-resume`：--resume |
| workbuddycn | workbuddycn | （未安装） | `aih workbuddycn resume <id>` | `codebuddy-family-resume`：--resume |
| cline | cline | 3.0.74 | `aih cline resume <id>` | `cline-session`：--id |

## aih 统一入口（所有 provider 共用一套动词）

- `aih <cli> resume [<id>]`：续接上一段对话；省略 `<id>` 时用该 CLI 的「最近一段」（没有安全退路的会明确报错）。
- `aih <cli> fork [<id>]`：从上一段对话**分叉**出新会话（原对话不动）；无 fork 能力的 provider 明确拒绝。
- `aih <cli> <账号> resume|fork [<id>]`：指定账号续接 / 分叉。
- `aih <cli> resume --help`：打印统一动词与各 provider 原生形态对照表。
- `aih <cli> sessions --history [--limit N]`：列出该 CLI 自己的会话（含 id），直接喂给 resume/fork；按账号隔离的 provider 会明确说明。
- `aih <cli> version`：直接向原生 CLI 要版本号与二进制路径（不猜）。
- `aih <cli> <任意原生参数>`：**完整透传**（`aih codex exec …`、`aih claude --model …` 都走原生），统一动词不影响它。
- `aih <cli> -- <任意原生参数...>`：**逃生门** —— `--` 之后逐字交给原生 CLI，即使撞上 aih 自己的保留字（ls / login / sessions / resume …）也不拦截。
- 事实来源：`contracts/providers/manifest.json` 的 `nativeBoundary.sessions.flags`；翻译表 `lib/runtime/provider-resume.js`。

## 各 provider 明细

### codex（codex-cli 0.165.0）

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

### claude（2.1.312 (Claude Code)）

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
  -r, --resume [value]                  Resume a conversation by session ID or
  --session-id <uuid>                   Use a specific session ID for the
```
</details>

### opencode（1.18.18）

- 二进制：`/opt/homebrew/bin/opencode`
- 版本命令：`opencode --version`
- 合同声明的会话入口：`--continue` `--session` `--fork`
- 统一续接：`aih opencode resume <id>` → 原生 `--session <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>opencode run --help</code> 关键行</summary>

```
  -v, --version      show version number                                                   [boolean]
  -c, --continue     continue the last session                                             [boolean]
  -s, --session      session id to continue                                                 [string]
      --fork         fork the session before continuing (requires --continue or --session) [boolean]
      --share        share the session                                                     [boolean]
      --title        title for the session (uses truncated prompt if no value provided)     [string]
```
</details>

### grok（grok 1.0.70 (f50904eaee6c)）

- 二进制：`/Users/model/.grok/bin/grok`
- 版本命令：`grok --version`
- 合同声明的会话入口：`--continue` `--resume` `--session-id`
- 统一续接：`aih grok resume <id>` → 原生 `--resume <id>`
- 统一续接（不带 id）：→ 原生 `--continue`

<details><summary><code>grok --help</code> 关键行</summary>

```
Usage: grok [OPTIONS] [PROMPT] [COMMAND]
  [PROMPT]  Initial prompt for the interactive session
  -c, --continue
          Continue the most recent session for the current working directory
      --fork-session
          When resuming, create a new session ID instead of reusing the original
          Open in the standard fullscreen TUI for this session
  -r, --resume [<SESSION_ID_OR_TITLE>]
          Resume a session by ID or title, or the most recent if omitted
          Restore the original session's repository snapshot when resuming
  -s, --session-id <SESSION_ID>
          Use a specific session UUID for a new conversation
  -v, --version
          Print version
          Start the session in a new git worktree, optionally named
  export       Export a session transcript as Markdown
  memory       Manage cross-session memory
  sessions     List, search, or restore sessions
  trace        Export or upload session trace data
  update       Check for updates or install a specific version
  usage        Print persisted token and cost usage for a session
  version      Print version information [aliases: v]
```
</details>

### qoder（1.1.80）

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
  --remote-session <id>                Cold-load and attach to an existing
                                       remote session
  --list-sessions                      List available sessions and exit
  --delete-session <index>             Delete a session by index number
  --no-session-persistence             Disable session persistence - sessions
                                       resumed (only works with --print)
  --agent <name>                       Agent for the current session
  --system-prompt <text>               System prompt for the session
  --output-style <style>               Output style for this session
  -v, --version                        output the version number
  --remote-control <session-id>        Run a headless Worker for an existing
                                       remote session.
  --remote [task]                      Create a cloud remote session and print
  rollback [options]                   Rollback to a previous version
  update [options]                     Update to the latest version
  status [options]                     Show session status
```
</details>

### qodercn（1.1.80）

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
  --remote-session <id>                Cold-load and attach to an existing
                                       remote session
  --list-sessions                      List available sessions and exit
  --delete-session <index>             Delete a session by index number
  --no-session-persistence             Disable session persistence - sessions
                                       resumed (only works with --print)
  --agent <name>                       Agent for the current session
  --system-prompt <text>               System prompt for the session
  --output-style <style>               Output style for this session
  -v, --version                        output the version number
  --remote-control <session-id>        Run a headless Worker for an existing
                                       remote session.
  --remote [task]                      Create a cloud remote session and print
  rollback [options]                   Rollback to a previous version
  update [options]                     Update to the latest version
  status [options]                     Show session status
```
</details>

### cline（3.0.74）

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

- gemini、agy、kimi、kiro、zcode、codebuddy、codebuddycn、workbuddy、workbuddycn

