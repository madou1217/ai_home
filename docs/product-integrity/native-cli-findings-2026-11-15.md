# Native CLI boundary execution — 2026-11-15

Scope: M1/M2 Node CLI prefix/native suffix boundary. No official client fork, no tests added, no credentials exported or paid inference. Shared Go/bin migration changes are not rewritten by this task.

## NCLI-01 — native escape intercepted AIH actions (P1)

Actual public CLI before:
- `node bin/ai-home.js codex -- --help` printed AIH provider help, not Codex help.
- `node bin/ai-home.js codex -- ls --help` printed AIH List Mode Help.
- Source helper also removed the account prefix when stripping the marker; session-control extractor consumed post-marker flags.

Implementation:
- `services/ai-cli/native-escape.js`: stable prefix/suffix value, explicit account selector belongs only before marker; numeric text after marker remains native.
- `session-control-args.js`: extracted focused prefix parser from command router. It stops at marker and rejects missing values before mutating the environment.
- Node router resolves/checks explicit account, then directly hands immutable native args to existing launch port, before management actions/resume rewrites. AccountRef readiness guard matches normal path. Explicit nonexistent IDs fail instead of switching to another account.
- `provider-resume-verb.js` retains existing public helper but delegates escape parsing to focused module. External harness code uses escaped flag and its own original argv parser; its behavior is unchanged.

Actual official Codex verification:
| Public command | Observed result |
|---|---|
| `aih codex -- --help` | official Codex CLI help, exit0 |
| `aih codex -- ls --help` | official Codex help, not AIH list help, exit0 |
| `aih codex -- delete --help` | official saved-session deletion usage, exit0; nothing deleted |
| `aih codex -- login --help` | official login usage, exit0; no auth started |
| `aih codex -- exec --help` | official noninteractive usage, exit0 |
| `aih codex -- exec --session <sentinel> --help` | official unexpected `--session`, exit2; proves suffix was not consumed as AIH label |
| `aih codex -- exec --model-alias <sentinel> --help` | official unexpected `--model-alias`, exit2; no AIH alias rewrite |
| `aih codex 999999 -- --help` | missing explicit account, exit1; no fallback |
| `aih codex -- 999999 --help` | official CLI help, exit0; suffix numeric is not an account |

Reviewer found missing prefix values could swallow marker: use harmless `codex --session -- ls --help` rather than destructive suffix. It reproduced AIH list dispatch. After fix, all six session/remote/runner flag forms fail `missing_value` exit2. Valid pre-marker session label plus post-marker `--session` still reaches official error. Review accountRef configured guard added; actual unconfigured account fixture not created, so only source evidence for that guard.

Remaining boundaries:
- `bin/ai-home.js` fast-path classification and Go root/native launch have separate escape/verb gaps (CLI map F02–F05). This Node slice does not claim to fix them.
- End-to-end explicit valid account pin / cross-provider identity requires controlled credentials and original CLI acceptance, not a mock child. Not exercised here.
- Read-only native helps may create account-projection/runtime artifacts through existing launcher; no inference, login, deletion or service restart intentionally triggered.
- Version flag/PTY/empty argument and all-provider terminal behavior still need broader matrix.

## NCLI-02 — completion suggests wrong argument kind (P2)

- Actual `aih codex sessions <TAB>` returned native session UUIDs; feeding one into real `aih codex sessions <uuid>` returned Invalid ID (expects account selector).
- Changed sessions position to account candidates and gateway profile; resume/fork remain native session identities.
- Account-first action suggestions narrowed to current router-supported resume/fork/usage/home plus launch flags; do not advertise delete/set-default/login after an account when it would become native text. No new management-order semantics introduced.
- `deleteall` no longer receives account candidates.
- Actual global `aih ss --history` rejects the flag; declaration now advertises real `--detail`, provider sessions retains `--history`.
- Actual `edge remove nginx --help` confirms only frp removal is supported; completion now lists frp only. No new deletion capability added.
- Added existing shell doctor to completion, removed unimplemented import `-j` suggestion and obsolete directory/zip wording. Import remains native JSON; formats were not expanded.

Only source declaration changes for the last import/doctor rows; no account import or edge mutation performed. Runtime Node/Go routing support and provider list still require remaining work in the approved full plan.

## NCLI-03 — shared session-command contract

- 本机官方帮助核实：AGY --conversation，Cline --id，Gemini --resume latest，OpenCode --session/--fork，Qoder/Grok/CodeBuddy --resume + --fork-session。
- Go 原来按任意 flags 推断 --resume/--continue，已改为 `core/providers.NativeSessions.Resume/Fork` 显式 argv 模板；模板只接受一个身份占位符且操作 flag 必须被合同声明。Node 同读生成 manifest，不再保留独立 interactive/fork 参数表；持久重启的身份和文件恢复逻辑保留。
- defensive clone 同步新增slice字段；provider-manifest --check 和真实 Go CLI build通过。临时外部driver使用实际应用包，29次官方CLI --help返回0，21条明确拒绝，14条未实际启动；64条Go/Node参数比对无差异。详见 session-command-evidence JSON。**只证明参数形态/拒绝，不证明已有对话恢复成功或所有版本支持。**
- WorkBuddy无本轮独立CLI fork证据，保持未声明；CodeBuddy CLI已现场确认fork，仅在那里声明。
- Go `login --no-browser --help` 原来绕过登录handler报Relay不支持，现实际exit0输出正确登录用法，不启动认证。Go native marker在管理dispatch前交到launch intent，数值后缀不再当账号；临时HOME/dead网关下官方Codex帮助通过，未调用推理。bin family restart只查marker前。

## NCLI-04 — broken output pipe lifecycle

- 实际 `aih codex -- exec --help | head -6` 触发 Node 未处理 EPIPE，错误栈从 shell-drawer output 泄出。
- 增加专责pipe-lifecycle观察器，EPIPE收口当前child与watcher，不全局吞错误；closed pipe不flush，退出141；正常退出移除监听。
- 实际 head -6/head -1管道 exit141/0，无错误栈；未截断官方help exit0且尾部完整。独立审查进行中，尚未验证长流背压、Windows SIGPIPE语义与所有清理失败路径。

## MODEL-01 — runtime drift isolated diagnosis

实时公共服务ready但Codex effort空数组；当前源码固定投影存在，binary stamp source_sha为空。没有重启共享服务。独立 `/tmp` 构建+空HOME真实Server端口0，通过真实management PUT复制公共已观察的模型元数据；OpenAI/Codex GET均200且梯度一致。Server SIGTERM exit0，隔离实例已退出。源码修复正确的证据见 model-projection-live JSON；公共实例仍需受控发布，不据隔离成功宣称线上已恢复。
