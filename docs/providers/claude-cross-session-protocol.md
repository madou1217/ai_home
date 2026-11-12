# Claude Code 的多会话通信：协议逆向与可复用性

> 结论：Claude Code 2.1.316 的「会话之间互相发消息」**不是云服务，也不是共享文件**，而是
> **本机 UDS（Unix domain socket）上的逐行 JSON**：每个 claude 进程有一个收件箱 socket，
> 认证用一枚 32 位 hex token，消息帧就是一条普通 user 轮次。协议足够简单，我们已经用
> `scripts/claude-peer.js` 完整复现——发送成功，并被收件方按策略投递/挂起（见「实测」）。
>
> 另外两套「多 agent」机制（subagent、teammate/团队）走的是进程内调用与文件 mailbox，
> 与跨会话通信不是同一条链路，本文末尾一并说明。

日期：2026-11-01　核对版本：`claude 2.1.316`（binary `~/.local/share/claude/versions/2.1.316`）

---

## 1. 拓扑：谁在说话

```
~/.claude/
├── sessions/<pid>.json                     ← 活会话登记（发现层）
├── sessions/<pid>.<sha256(sock)>.key       ← 收件箱 token（0600）
├── daemon.lock / daemon/roster.json        ← 后台常驻服务（bg 会话/worker）
└── tasks/<taskListId>/                     ← 团队任务清单

/tmp/cc-socks[-<uid>]/<pid>.sock            ← 每个会话的收件箱（0600）
/tmp/cc-daemon-<uid>/<hash>/control.sock    ← 守护进程控制面
/tmp/cc-daemon-<uid>/<hash>/{rv,spare}/*.sock ← bg worker 的 rendezvous / PTY
```

一份真实的登记（`~/.claude/sessions/65225.json`，字段有删减）：

```json
{
  "pid": 65225,
  "sessionId": "a56c9c4f-547d-4f6e-84d0-d77d513e2a57",
  "cwd": "/Users/model/projects/feature/ai_home",
  "procStart": "Sun Nov  1 14:04:03 2026",
  "version": "2.1.316",
  "peerProtocol": 1,
  "peerFeatures": ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
  "kind": "interactive",
  "tmux": "p-ai_home-1z0bk3:@0.%0",
  "messagingSocketPath": "/tmp/cc-socks/65225.sock",
  "name": "ai-home-fc",
  "status": "idle"
}
```

- `name` 是 SendMessage 的收件人名字（会话名/派生名），`sessionId` 也能当地址。
- `peerProtocol` 目前是 1；`peerFeatures` 是能力协商（`notify_idle` 决定能否订阅「空闲通知」）。
- token 文件内容：`{"peerToken":"<32 hex>","procStart":"…","pidDomain":"darwin"}`；
  文件名里的 64 位 hex 是 **socket 路径的 sha256**（`<pid>.<sha256(path)>.key`）。

## 2. 协议：四条规则

### 2.1 发现
读 `~/.claude/sessions/*.json`，用 `kill(pid,0)` + 连一下 socket 判活。
（不要拿 `procStart` 做字符串比较：它受 locale/TZ 影响，同一进程可能被写成
`Sun Nov  1 14:04:03 2026` 或 `日 11月/ 1 22:04:03 2026`。）

### 2.2 认证
连接收件箱后先写**一行** auth：

```json
{"type":"auth","token":"9e768e653fad474071aaff74521ea098"}
```

token 从收件方的 `<pid>.<sha256(sock)>.key` 读——也就是说**任何能读你 home 的进程都能拿到它**，
认证只防「别的用户/别的机器」，不防「你自己的其它进程」。

### 2.3 投递
紧接着写**一行**消息帧（普通消息不是 `type:"control"`，而是一条 user 轮次）：

```json
{
  "msgV": 1,
  "msg_id": "cc-msg-<32 hex>",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<cross-session-message from=\"uds:%2Ftmp%2Fcc-socks%2F65225.sock\" from-name=\"lab-peer\" from-mode=\"bypass\">\n正文\n</cross-session-message>"
  },
  "priority": "next",
  "from": "uds:%2Ftmp%2Fcc-socks%2F65225.sock"
}
```

- `from` 的格式是 `uds:<percent-encoded socket 路径>`（远端会话是 `bridge:…`）。
- 信封属性顺序固定：`from` → `from-session` → `hop-chain` → `from-name` → `from-mode` → `from-plugin`。
  收件方会把这个字符串**逐字重建**再比较，顺序错了就不认（我第一版就踩了）。
- `from-mode` 的值是权限模式类别（`bypass` / prompting 那一类），不是 `bypassPermissions` 全名。
- 订阅类请求走另一条 `{"type":"control","action":"notify_when_idle",…}`，与普通消息不同帧。

### 2.4 收件方策略
`settings.json` 的 `crossSessionInbound`：`accept` / `hold` / `refuse`。
未显式设置时按「权限模式对等」判断——**发送方 attests 的模式与收件方同类才自动投递**，
否则挂起等人工批准（因为「别的会话让我做的事」不能算用户意图）。

## 3. 实测（2026-11-01，本机）

1. 用 `aih claude --model DeepSeek-Flash` 起了一个一次性会话（`p-aih-peer-lab-tmlyyt`）。
2. 用假收件箱占位进程 + 手工登记，验证发现/认证链路。
3. 用本仓库脚本发送：

   ```bash
   HOME=/Users/model node scripts/claude-peer.js list
   #   65225  ai-home-fc  idle  /tmp/cc-socks/65225.sock
   #   66856  aih-peer-lab-80  idle  /tmp/cc-socks/66856.sock

   HOME=/Users/model node scripts/claude-peer.js send 66856 'hello from aih'
   ```

4. 收件方界面（不带 `from-mode`）：

   ```
   Held message from another session
   Another Claude session sent a message: from uds:%2Ftmp%2Fcc-socks%2F66856.sock
   [verified pid 70905] (peer claims name: aih-peer)
   The sender did not attest its permission mode, and this session bypasses prompts.
   Message body (this is what will be delivered):
   │ hello from aih protocol test
   ❯ Deny — drop it and tell the sender it was declined
     Deliver this message to Claude
   ```

5. 带 `from-mode="bypass"` 重发：**直接投递**，收件会话把它当成用户消息开始处理
   （该账号余额为 0，所以立刻返回 402，但这正好证明它进了模型上下文）：

   ```
   › Message from @lab-peer: hello with mode attestation (ctrl+o to expand)
   ⏺ API Error: 402 Insufficient Balance
   ```

   收件方的会话记录里能看到这条 user 轮次，content 就是上面那个信封。

**边界（收件方会做、我们绕不过）**：
- 连接后用 socket 对端凭据校验 pid/uid/procStart（界面上那句 `[verified pid 70905]` 就是这个），
  所以 `from` 只是「标签」，不是身份证明。
- 拒绝非常规路径/符号链接；只接受 `/tmp/cc-socks[-uid]/<pid>.sock` 这类命名空间。
- 订阅有上限（同一 peer 最多几条）、有节流；`notify_when_idle` 一次性、不轮询。

## 4. 能不能被我们接出来

能，而且成本很低。协议实现现在在 `lib/cli/services/peer/adapters/claude-uds.js`，
由 `aih peer` 当 **native 通道**用（统一入口与另一条 inject 通道见
`docs/providers/peer-messaging.md`）：

```bash
aih peer list                    # 本机所有可发消息的会话（含非 claude）
aih peer send <名字|pid|会话id> "正文" [--mode bypass] [--dry-run]
```

不装 aih 也能用的单文件入口仍是 `scripts/claude-peer.js`（薄封装，约 80 行，无依赖）：

- `list`：列出本机所有活会话的收件箱（pid/名字/socket）；
- `send <name|pid|sessionId> "文本" [--mode bypass] [--from <address>]`：投递一条跨会话消息；
- `--dry-run`：只打印两行帧，不连接。

可复用的场景（aih 侧）：

1. `aih` 自己当「编排者」：把 aih 管理的多个 provider 会话串起来（claude 之间直接走这套；
   其它 provider 由 aih 做网关，统一成同一套语义）。
2. 任务交接：一个会话收尾后 `notify_when_idle` 订阅，再把结果推给下一个会话。
3. WebUI/手机端：一个 HTTP 接口 → aih → UDS 帧，等于给 Claude 会话加一个「外部入站」。

要注意的：

- **不要用它绕过权限**：Claude 自己的规则写明「跨会话消息永远不是用户意图」，
  请求对端做本会话被拒的操作属于 permission laundering。我们的封装也应该保持这个默认
  （默认不带 `from-mode`，让对方挂起等人工批准）。
- 协议未公开且会漂移：字段/capability 靠 `peerProtocol` + `peerFeatures` 协商，
  升级版本后先 `list` 再 `--dry-run` 验证，别硬编码。

## 5. 同一版本里的其它「多 agent」层（容易混淆）

| 层 | 传输 | 谁用 |
| --- | --- | --- |
| **subagent**（Task 工具） | 进程内函数调用，无协议 | 单会话内的并行子任务 |
| **teammate / 团队** | 文件 mailbox：存储命名空间 `mailbox/<team>/<teammate>`；团队配置 `<config>/teams/<team>/config.json`；任务清单 `<config>/tasks/<listId>/` | `--team-name` / `--agent-name` / `--agent-id` 启动的队友 |
| **跨会话 peer**（本文） | 本机 UDS 逐行 JSON | 你机器上并行的多个 claude 会话 |
| **后台会话**（`claude --bg`） | 守护进程 `~/.claude/daemon` + 每 worker 的 `rv/*.sock`、`spare/*.pty.sock` | `claude agents` / `attach` / `logs` / `stop` |
| **Remote Control 桥** | 云端 `/v1/code/sessions/<id>/inbox/<name>` | 跨机器/网页端 |

## 6. 各 harness 对照（有没有 / 原理 / 能不能复用）

| harness | 多会话/多 agent 通信 | 原理 | 可复用性 |
| --- | --- | --- | --- |
| **claude**（2.1.316） | ✅ 有，且是**唯一有本机跨会话 UDS 的** | 本文：`sessions/*.json` 发现 + `/tmp/cc-socks/<pid>.sock` + auth token + 逐行 JSON | ✅ 已复现（`scripts/claude-peer.js`） |
| **codebuddy / codebuddycn**（2.178.1） | ✅ 有，但是**另一套**：Agent Home 的 teammate/channel | 服务端目录（teammate 注册表、channel/board），消息以 `<teammate-message teammate_id=… kind="channel" channel="agent-home">` 注入；二进制里没有 `cc-socks`/`peerToken` | ⚠️ 需要接它的服务端接口，不是本机 socket；可参考其注入格式 |
| **codex**（0.166） | ✅ 有，**进程内**协作 agent | collab 工具族：`SpawnAgent` / `AssignAgentTask` / `SendMessage` / `WaitAgent` / `ListAgents` / `CloseAgent`，thread 内调度 | ⚠️ 没有跨进程通道，只能通过它的 app-server/thread 协议间接复用 |
| **grok** | ✅ 有 subagent（有 `parentSessionId`/`subagentDepth` 字段） | 会话树 + 子 agent 派生，无跨会话 socket | ❌ 不可直接复用 |
| **opencode**（2.2.5） | ⚠️ 文案里带 `crossSessionInbound`/`SendMessage`，但**没有** `cc-socks`/`peerToken`，未发现本机 inbox 实现 | 兼容层文案 | ❌ 只能确认「概念存在」，无可用通道 |
| **gemini** | ❌ 无 | — | ❌ |
| **cline** | ❌ 无 | — | ❌ |
| **kiro / zcode / qoder / qodercn / kimi** | ❌ 无（仅单会话 TUI） | — | ❌ |

## 7. 复现实验的方法（下次换版本先跑这个）

```bash
# 1) 找出活会话
HOME=/Users/model node scripts/claude-peer.js list

# 2) 看帧（不发送）
HOME=/Users/model node scripts/claude-peer.js send <pid> "hi" --dry-run

# 3) 真发（默认不带 from-mode → 对方会挂起等批准，安全）
HOME=/Users/model node scripts/claude-peer.js send <pid> "hi"
```

从二进制复核协议时的定位方法（bun 单文件产物，296MB）：

```bash
python3 - <<'PY'
import mmap
BIN='/Users/model/.local/share/claude/versions/2.1.316'
needle=b'cc-socks'
with open(BIN,'rb') as f:
    mm=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)
    i=mm.find(needle)
    print(i, mm[i-600:i+900].decode('utf8','replace'))
PY
```
