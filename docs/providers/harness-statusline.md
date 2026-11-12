# 各 harness 的 status line：它写什么、能不能自定义、模型从哪来

> 结论先行：**只有 Claude 系（claude / codebuddy 家族）把「当前模型」当成状态栏数据吐出来**；
> Codex / AGY / Grok 的状态栏是「显示哪些项」的配置，不提供数据；Gemini / OpenCode / Cline /
> Kiro / ZCode / Qoder / Kimi 压根没有可执行的状态栏命令。
>
> 这一页是为了回答 2026-11-01 的一个具体 bug：**终端标题里的模型和当前会话完全无关**。
> 根因不在标题渲染，而在取值——见文末「对 aih 的含义」。

本文的事实来源分三类，正文里逐条标注：

- **二进制核对**：直接读本机安装的 CLI 产物（版本写在标题里），从打包后的 JS 里提取
  状态栏数据的构造代码。
- **配置 schema 核对**：仓库里 `lib/providers/config-schemas/data/*.json` 对各 CLI 配置项的
  声明（每条都带官方文档 URL 与 `verifiedCliVersion`）。
- **未验证**：本机没装、也没有可依赖的文档口径，明确标注，不猜。

---

## 总表

| provider | 状态栏机制 | 能否挂自定义命令 | 「当前模型」的权威来源 | aih 现在的读法 |
| --- | --- | --- | --- | --- |
| `claude` (Claude Code 2.1.316) | `settings.json.statusLine`（`type: command`） | ✅ 每轮渲染把 JSON 喂给命令 | 状态栏 JSON 的 `model.id` / `model.display_name` | `--model` → 会话状态 → `settings.json.model` |
| `codebuddy` / `codebuddycn` (CodeBuddy Code 2.178.1) | 同上（同一套 Claude 兼容 schema） | ✅ | 状态栏 JSON 的 `model.id`（内部取 `requestOptions.model ?? options.model ?? settings.model`） | 同上，读 `settings.json.model` |
| `workbuddy` / `workbuddycn` | 家族同内核（桌面端 + 同一份 CLI 配置） | 预计 ✅（未单独验证） | 同上 | 同上 |
| `codex` | `config.toml` 的 `tui.status_line`（**项目 id 列表**，不是命令） | ❌ 只能用内置项 | `config.toml` 的 `model`；会话 rollout 里 `turn_context.model` | `--model` → `config.toml.model` |
| `agy` (Antigravity CLI) | `settings.json.statusLine.enabled/type/command` | ✅ | `settings.json.model`（客户端存的是**显示名**） | 读 `settings.json.model` |
| `grok` | `config.toml` 的 `ui.status_line.command` | ✅ | `[models] default` | 读 `[models].default` |
| `gemini` | 无命令式状态栏；只有 footer 开关 `ui.footer.hideModelInfo` | ❌ | `settings.json` 的 `model.name` | 读 `model.name` |
| `opencode` | 无命令式状态栏（TUI 状态栏由 TUI 自己画） | ❌ | `opencode.json` 的 `model` | 读 `model` |
| `cline` | 无状态栏 | ❌ | 客户端自己的 provider 设置；aih 启动时会显式给 `-m <model>` | `-m` 就是事实 |
| `kiro` / `qoder` / `qodercn` / `zcode` / `kimi` | 无（或仅内置 TUI 底部信息） | ❌ | **本机没有可解析的当前模型声明** | 不显示模型段 |

---

## 1. Claude Code（`claude`，2.1.316）

**机制**：`settings.json` 里 `statusLine: { type: "command", command: "...", padding, refreshInterval, hideVimModeIndicator }`，
另有 `subagentStatusLine`（改写子 agent 列表行）。每次渲染把一份 JSON 从 stdin 喂给命令，
命令的 stdout 就是状态栏文字。`/statusline` 斜杠命令负责配置它。
来源：`config-schemas/data/claude.settings.json`（官方 settings-reference，verifiedCliVersion 2.1.303）。

**它喂给命令的 JSON**（二进制核对：`/Users/model/.local/bin/claude` 里构造该对象的那段代码）：

```js
{
  // …session_id / transcript_path / cwd / permission_mode（bp(e, be) 展开）
  session_name,                                          // 有会话名时
  model: { id: <mainLoopModel>, display_name: <人类可读名> },
  workspace: { current_dir, project_dir, added_dirs, git_worktree?, repo? },
  version,
  output_style: { name },
  cost: { total_cost_usd, total_duration_ms, total_api_duration_ms,
          total_lines_added, total_lines_removed },
  context_window: { total_input_tokens, total_output_tokens, context_window_size,
                    current_usage: { input_tokens, output_tokens,
                                     cache_creation_input_tokens, cache_read_input_tokens },
                    used_percentage, remaining_percentage },
  exceeds_200k_tokens,
  fast_mode, effort: { level }, thinking: { enabled },
  rate_limits: { five_hour: { used_percentage, resets_at },
                 seven_day: { used_percentage, resets_at },
                 spend_limit: { used_percentage, resets_at, used_usd, limit_usd, period } },
  vim: { mode }, agent: { name }, remote: { session_id },
  pr: { number, url, review_state?, kind? }, worktree: { name, path, branch, ... }
}
```

要点：**`model.id` 是主循环当前真正在用的模型**（不是账号默认值），`context_window.used_percentage`
是已经算好的百分比——这正是「自建状态栏」最该拿的两项。

## 2. CodeBuddy / CodeBuddy CN（2.178.1）

**机制**：与 Claude 同构。`settings.json` 里 `statusLine.command`，JSON 走 stdin、stdout 当状态栏；
`/statusline` 可配置。家族四支（`codebuddy` / `codebuddycn` / `workbuddy` / `workbuddycn`）
共用同一份 CLI 配置（见 `docs/architecture/` 与 `lib/runtime/codebuddy-shared-config.js`）。

**它喂给命令的 JSON**（二进制核对：`/Users/model/.local/bin/codebuddy` 的 `collectStatusLineData()`）：

```js
{
  hook_event_name: "Status",
  session_id, session_name, transcript_path, cwd, permission_mode,
  model: { id, display_name },
  workspace: { current_dir, project_dir, added_dirs },
  version, output_style: { name }, cost,
  context_window: { total_input_tokens, total_output_tokens, context_window_size,
                    current_usage: { input_tokens, output_tokens,
                                     cache_creation_input_tokens, cache_read_input_tokens },
                    used_percentage, remaining_percentage },
  exceeds_200k_tokens,
  // …vim 模式、team 信息
}
```

**模型的取值链**（源码原样）：`requestOptions.model ?? options.model ?? settingsManager.get("model")`。
也就是说 `model.id` 是「本会话当前模型」；而我们能离线读到的持久事实是 `settings.json.model`
（用户选了模型后 CLI 会把默认模型写回去）。两者的差别只在「会话中途切模型但还没落盘」这一瞬。

## 3. Codex

**机制**：没有「命令式状态栏」。`config.toml` 的 `tui.status_line` 是**有序的 item id 列表**
（`null` 关闭），`/statusline` 是「配置显示项」而不是「挂脚本」。
来源：`config-schemas/data/codex.config.json`（developers.openai.com/codex/config-reference）。

**模型来源**：`config.toml` 顶层 `model = "..."`；会话文件（rollout JSONL）里的 `turn_context.model`
记录每轮真实模型，标题用不到那么细。aih 早已按 `config.toml` 读（`codex-launch-support.readCurrentCodexModel`）。

## 4. AGY（Antigravity CLI）

**机制**：`settings.json` 的 `statusLine.enabled` / `statusLine.type` / `statusLine.command`，
可以挂自定义命令；`/statusline` 是开关。
**模型**：`settings.json.model`，客户端存的是显示名（如 `"Gemini 3.8 Flash (Low)"`）。
来源：`config-schemas/data/agy.settings.json`（antigravity.google/docs/cli）。

## 5. Grok

**机制**：`config.toml` 的 `ui.status_line.command`（「Script for a command status line」）。
**模型**：`[models] default = "..."`（也被 `--model`/`-m`、`GROK_DEFAULT_MODEL` 覆盖）。
来源：`config-schemas/data/grok.config.json`。

## 6. Gemini CLI

**机制**：没有命令式状态栏，只有 footer 显示开关：`ui.footer.hideModelInfo`、
`ui.showModelInfoInChat`。`/status` 一类命令列出信息但不喂 JSON。
**模型**：`settings.json` 的 `model.name`。
来源：`config-schemas/data/gemini.settings.json`（geminicli.com/docs/cli/settings）。

## 7. OpenCode

**机制**：无命令式状态栏（TUI 自己画）。`/models` 切模型，配置里 `model` 是默认模型
（`small_model` 管标题生成这类小任务）。
来源：`config-schemas/data/opencode.config.json`（opencode.ai/docs/config）。

## 8. Cline

无状态栏。aih 启动 Cline（网关模式）时会显式传 `-m <model>`——所以标题里的模型来自命令行，
是最硬的事实。

## 9. Kiro / Qoder / Qoder CN / ZCode / Kimi

本机装了 `~/.kiro`、`~/.qoder`、`~/.qoder-cn`、`~/.zcode`，但配置里**没有**「当前模型」的可解析声明
（`zcode/v2/setting.json` 是纯 UI 偏好）。这些 harness 也没有状态栏命令。
因此 aih 对它们的标题**不显示模型段**，而不是拿账号目录的默认模型顶上。

---

## 对 aih 的含义（这次修的东西）

标题里的模型原来这么取：

```
--model/-m  →  codex 的 config.toml  →  账号目录里「可路由的第一个模型」
```

最后一段来自 `lib/harness/pinned-default-model.js`：它是**给 harness 启动用的默认模型**
（保证钉选账号时不会 503），语义是「这个账号能接哪个模型」，跟「用户此刻在用哪个」无关。
实测这台机器上：

```
acct_a35609bf34bcf0f4c26b（codebuddycn）→ deepseek-v4-pro     ← 目录第一条
acct_04a193ed26f71e4619c5（codebuddy）  → balanced-model       ← 目录第一条（pi 池的入口名）
```

而用户实际在用的是 `deepseek-v4.1-flash`（`settings.json.model`，也是本会话环境里的
`CODEBUDDY_CURRENT_MODEL_ID`）。于是标题写出了 `CodeBuddycn:acct_…:deepseek-v4-pro` ——
和会话毫无关系。

修复后的取值顺序（`lib/cli/services/pty/pty-runtime-run.js` 的 `resolveActiveModelLabel`）：

1. **运行中 `/model` 切出来的模型**（仅 CodeBuddy 家族）：CLI 会把新模型写回共享
   `settings.json`；`lib/cli/services/pty/active-model.js` 的 tracker 只认「值发生变化」，
   所以它压过启动参数，而启动参数和配置里的历史值谁新谁旧不靠猜；
2. `--model` / `-m`：本次会话的显式选择；
3. 会话状态里 harness 自报的 `model`（`statusline` 事件带回的 `model.id`/`display_name`）；
4. harness 自己的配置：`settings.json.model` / `config.toml`（`lib/harness/harness-current-model.js`）；
5. 都读不到 → 标题少一段，**不写假模型名**。

家族换号（同站/跨站）还会按目标账号的模型目录适配：当前模型支持就
原样带过去；否则优先恢复该站上次用过的模型，再退到目标站默认档位（`default-model` /
`primary-model` / `balanced-model` / `fast-model`）。目录未知时 fail-open，不猜替代项。

上表「aih 现在的读法」一列就是逐个 provider 落地的结果。

读配置时用的是**账号沙箱里那一份**，也就是 harness 子进程自己的 env：

| harness | 配置根（按优先级） |
| --- | --- |
| claude | `--settings <file>` → `<项目>/.claude/settings.local.json` → `<项目>/.claude/settings.json` → `$CLAUDE_CONFIG_DIR/settings.json` → `$HOME/.claude/settings.json` |
| codex | `$CODEX_HOME/config.toml` → `$HOME/.codex/config.toml` |
| gemini | `$GEMINI_CLI_SYSTEM_SETTINGS_PATH` → `$GEMINI_CLI_HOME/settings.json` → `$HOME/.gemini/settings.json` |
| agy | `$GEMINI_CLI_SYSTEM_SETTINGS_PATH` → `$HOME/.gemini/antigravity-cli/settings.json` |
| codebuddy 家族 | `$HOME/.codebuddy`（cn 是 `.codebuddy-cn`；workbuddy 是 `.workbuddy-ai` / `.workbuddy`）`/settings.json` |
| opencode | `$HOME/.config/opencode/opencode.json` |
| grok | `$HOME/.grok/config.toml` |

（这些变量就是 `lib/cli/services/pty/pty-runtime-spawn.js` 里 `shared.lastRuntimeEnv` 的值；
不看它就会读到宿主 HOME 的那份配置，而不是本账号沙箱里 CLI 真正在读的那份。）

### 后续可以做的（没在这次改动里）

- **状态栏桥接**：给 claude / codebuddy 家族装一层 `statusLine` 包装脚本，把 JSON 原样转给
  aih（现有 `statusline-updated` 事件与终端标题的 `statusline` 源已经支持），再链式调用用户
  原来的状态栏脚本。收益：模型、context 百分比、rate limit 全部变成**实时**值，
  且不再依赖「配置文件是否已落盘」。风险：要改写用户的 `statusLine.command`，必须保证链式
  调用与失败回退；`settings.json` 还是家族共享的一份物理文件。
- **会话级模型**：对没有状态栏的 harness，用 native session id 从会话记录里读最后一条
  assistant 消息的 `model`（各 reader 已经解析了 `message.model`/`providerData.model`）。

---

## 怎么核对（下次怀疑口径过时）

```bash
# Claude / CodeBuddy：状态栏数据的构造代码
strings -a ~/.local/bin/claude    | grep -o 'model:{id:[^}]*}'
grep -abo 'exceeds_200k_tokens' ~/.local/bin/codebuddy | head -1   # 再 dd 出上下文

# 配置 schema（带官方文档 URL 与验证版本）
node -e "console.log(require('./lib/providers/config-schemas/data/claude.settings.json').fields.filter(f=>f.path.startsWith('statusLine')))"

# 本机各 harness 的「当前模型」实测
node -e "const {resolveHarnessCurrentModel}=require('./lib/harness/harness-current-model');
for (const p of ['claude','codebuddy','codebuddycn','codex','gemini','opencode','grok','agy'])
  console.log(p, JSON.stringify(resolveHarnessCurrentModel({provider:p})));"
```
