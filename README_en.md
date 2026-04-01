# 🛸 ai-home (The Ultimate AI CLI Multiplexer)

> *Your personal Terminal Hijacker for AI CLIs.*
> [中文文档请点击这里 (README.md)](README.md)

Currently, AI terminal tools like `Gemini CLI`, `Claude Code`, and `Codex CLI` suffer from a critical flaw: they are strictly **monogamous**. They assume you only have one brain, one terminal, and one account. 
When you hit a `429 Rate Limit`, your flow is broken. When you want to run two agents on two different codebases simultaneously, their global state collides and corrupts your session.

`ai-home` (`aih`) is a lightweight, aggressive C++ PTY (Pseudo-Terminal) hijacker and environment multiplexer built for power users. 

It forces these CLIs into strictly isolated sandboxes, allowing you to run **infinite concurrent instances** using different accounts, while routing by trusted account state (including usage snapshots) instead of fragile stdout keyword matching.

## 🔥 Core Hacks

*   **Zero-Pollution Sandboxing**: Modifies process environment trees (`HOME`, `USERPROFILE`, tool-specific config dirs) on the fly. `aih gemini 1` and `aih gemini 2` have zero knowledge of each other.
*   **Deep PTY Hijacking**: We don't just spawn processes; we inject a `node-pty` layer for terminal isolation, session continuity, and account-scoped runtime environments.
*   **Trusted Exhausted Routing**: `aih` no longer marks accounts exhausted from runtime stdout keywords. Exhausted state is managed by trusted usage-remaining snapshots and explicit account state operations.
*   **API Key Phantom Routing**: If `ai-home` detects `OPENAI_API_KEY` (or other supported keys) in your shell environment, it bypasses standard auth. It automatically creates a dedicated sandbox bound to that specific key and base URL, and routes you to it seamlessly.
*   **Ghost Migration**: Instantly clones your existing global `~/.gemini` or `~/.codex` configs into Sandbox 1 without requiring re-authentication.
*   **Auto-Install**: If you don't have the CLI installed, `ai-home` will automatically download and install the global npm package for you.

## 🚀 Usage

Install globally and just use the `aih` alias.

### 1. Initialize & Migrate
```bash
aih gemini
```
*It will auto-install `@google/gemini-cli` if missing, detect your host machine's existing session, and seamlessly phantom-copy it into Account ID 1.*

### 2. Spawn More Clones (OAuth)
```bash
aih gemini add
aih codex add
```
*Creates Account ID 2, 3, etc., and forces the native auth flow.*

### 3. API Key Mode (Bring Your Own Keys)
Instead of browser auth, you can inject third-party API keys (like OpenRouter).
```bash
# Method A: Interactive prompt
aih claude add api_key

# Method B: Auto-detect exported env vars
export OPENAI_BASE_URL="https://api.your-server.com/v1"
export OPENAI_API_KEY="sk-xxxx"
aih codex
```
*`ai-home` detects the env vars, generates a unique hash, and automatically spins up a sandbox bound to those exact keys. If you use the same keys in another window, it routes to the same sandbox.*

### 4. Concurrent Multi-threading
Split your terminal. 
Window A: `aih gemini 1 "Refactor this monolith"`
Window B: `aih gemini 2 "Write unit tests for the monolith"`
They share nothing. They conflict with nothing.

### 5. Auto Account Routing
When you know you are burning through tokens, don't hardcode an ID.
```bash
aih gemini auto "Build a React app"
```
*`auto` selects the next non-exhausted account at launch time. It does not switch accounts mid-session based on terminal output text.*

### 6. Recon
```bash
aih ls
```
```text
📦 AI Home Accounts Overview

▶ gemini
  - Account ID: 1  [Active] [Exhausted Limit] (example@gmail.com) 
  - Account ID: 2  [Active] (work@company.com) 
```

### 7. Manually clear false exhausted flags
If an account is mistakenly marked as `[Exhausted Limit]`, clear it manually:
```bash
aih codex unlock 4
# or ID-first style
aih codex 4 unlock
```

### 8. Check usage snapshot (OAuth / Token)
`aih` only uses trusted sources to refresh usage-remaining snapshots (Gemini / Codex / Claude).
```bash
aih gemini usage 1
aih codex usage 2
aih claude usage 1
aih gemini usages
aih codex usages
aih claude usages
# or ID-first style
aih gemini 1 usage
aih codex 2 usage
aih claude 1 usage
```
If no snapshot is found:
- `gemini`: ensure this account is logged in with OAuth, then retry
- `codex`: ensure this account is logged in with OAuth (`codex login` in sandbox if needed), then retry
- `claude`: if it reports a local provider token, start that provider first, or switch to Claude OAuth login

### 9. Encrypted export/import (age + SSH keys)
```bash
# Export (optional selectors: codex:1,2 gemini)
aih export backup.aes

# Import: skip existing account IDs by default
aih import backup.aes

# Import: overwrite existing account IDs
aih import -o backup.aes
```

Notes:
- Password mode uses `AES-256-GCM`
- SSH-key mode uses `age`, and only lists local `~/.ssh/id_*.pub` keys that are `ssh-ed25519` or `ssh-rsa`
- If `age` is missing, `aih` prints platform install commands and can auto-install interactively
- Without `-o`, existing account directories are skipped; with `-o`, they are overwritten

### 10. Bulk account import (auto-discover accounts/<provider>)
```bash
# Recommended: auto-discover accounts/codex, accounts/gemini...
aih account import accounts

# Preview only (no writes)
aih account import accounts --dry-run

# Provider-scoped import is still supported
aih codex account import accounts/codex --dry-run
```
Notes:
- Top-level import auto-discovers provider directories under `accounts/<provider>`
- Unsupported providers are skipped with a clear notice
- Concurrency is auto-sized to local CPU parallelism (macOS / Windows / Linux)

### 11. Local Account Server (OpenAI-compatible)
`aih` now includes a built-in local server with provider-specific adapter routes:
- `codexBaseUrl` (default `https://chatgpt.com/backend-api/codex`)
- `geminiBaseUrl` (default `https://generativelanguage.googleapis.com/v1beta/openai`)
- `claudeBaseUrl` (default `https://api.anthropic.com/v1`)

Note: when a Gemini account uses `oauth-personal` (Google sign-in from Gemini CLI), the server automatically switches to the Gemini Code Assist route (`cloudcode-pa.googleapis.com`) instead of raw OpenAI-compatible passthrough.

```bash
# Start background server (default 127.0.0.1:8317)
aih serve

# Check status / restart / stop
aih server status
aih server restart
aih server stop
```

In clients (e.g. Cherry Studio), use:
- `base_url`: `http://127.0.0.1:8317/v1`
- `api_key`: `dummy`

Management auth (optional):
- `AIH_SERVER_MANAGEMENT_KEY`: auth key for `/v0/management/*` APIs (the only supported env key; legacy prefixes are removed).

Advanced (optional):
```bash
# Foreground debug mode
aih server serve --port 8317 --provider auto

# Auto-start on boot (macOS launchd)
aih server autostart install
aih server autostart status
aih server autostart uninstall
```

Management APIs:
- `GET /v0/management/status`
- `GET /v0/management/metrics` (success rate, timeout rate, recent errors)
- `GET /v0/management/accounts`
- `GET /v0/management/models`
- `POST /v0/management/reload`
- `POST /v0/management/state-index/upsert`
- `POST /v0/management/state-index/set-exhausted`
- `POST /v0/management/state-index/prune-missing`

State index write policy:
- Single-writer model: CLI no longer writes `account_state.db` directly.
- All state-index writes are delegated to server management APIs to reduce SQLite lock contention.

Windows note (`aih codex usages`):
- `.cmd/.bat` launch path is now handled for Codex usage probes.
- If you still see no usage snapshot, run `codex login` in that sandbox once and retry `aih codex usages`.

TTY smart UX (Codex):
- Interactive keys (up/down selection and confirm) are passed through via native PTY.
- Runtime threshold auto-switch (enabled by default, interactive sessions only):
  - When current account usage reaches threshold (`threshold_pct` in `~/.ai_home/usage-config.json`), `aih` prints a TTY notice and hot-swaps to the next eligible account.
  - Session storage stays shared via session-store links to preserve continuity as much as possible.
- `aih` injects `--skip-git-repo-check` for Codex by default to reduce first-open project confirmation prompts.

Optional toggles:
- `AIH_RUNTIME_AUTO_SWITCH=0` disable runtime threshold auto-switch
- `AIH_RUNTIME_THRESHOLD_CHECK_MS=<ms>` set threshold polling interval (default 60000, minimum 30000)
- `AIH_CODEX_AUTO_SKIP_REPO_CHECK=0` disable auto `--skip-git-repo-check` injection

Mock command for integration testing:
```bash
aih dev mock-usage codex 888 --remaining 4 --duration-sec 60
```
This temporarily writes a low-remaining usage snapshot for `codex#888`, waits 60s, then restores and re-checks.
