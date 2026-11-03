# aih peer：会话互通（收件箱 + 空闲推送 + reply-to）

`aih peer` 是一个**入口**，不是一种协议。它把「本机另一个会话给我发消息 / 我给它们发消息」
统一成：

```bash
aih peer list                       # 谁可以收
aih peer send <名字|id|pid|会话id> "正文"
aih peer inbox --self               # 发给我的消息
aih peer reply <msg-id> "正文"       # 回给原发送方
```

底下有三条通道，能力不同，命令会如实告诉你是哪条：

| 通道 | 谁有 | 传输 | 语义 |
| --- | --- | --- | --- |
| `native` | claude（Claude Code 2.1.316+） | 本机 UDS，逐行 JSON（auth + user 帧） | 有 `msg_id`；收件方按 `crossSessionInbound` **投递或挂起等批准** |
| `inject` | aih 管的任何持久会话（codebuddy 家族 / codex / gemini / …） | tmux `send-keys` 把一行信封打进 pane | 等价用户手打：没有已读/挂起，绕不过对方权限确认 |
| `webui-chat` | WebUI chat runtime 里的会话 | `POST /v0/webui/chat/sessions/:id/commands` | 幂等命令：空闲开一轮，忙则排队 |

> 为什么要有 inject：除 claude 外，没有哪家 harness 在本机留了可复用的跨会话通道。
> codebuddy 家族的 teammate/channel 在**服务端**，codex 的协作 agent 在**进程内**，
> 其余干脆没有。但它们在 aih 下都跑在 tmux 里——「往 pane 里打一行字」是唯一
> provider 无关、且不需要改对方代码的办法。
>
> 为什么 webui-chat 单列：chat runtime 有正规命令总线，投递是一次带 `commandId` 的
> 幂等命令，不是敲字。它按 **runtime** 而不是 provider 分类，所以不在 harness 表里。

## 投递模型：落盘 → 立即投 → 空闲推送 → 补看

以前的 `aih peer send` 是**一次性发射**：对方当时在跑回合、没起、或者 pane 正在重绘，
消息就永久丢了；inject 通道连消息 id 都没有，收到的人不知道该怎么回。

现在每条消息都是三段的：

```
1. 落盘   <aiHome>/run/peer/pending/<msg-id>.json
2. 投递   立刻按通道试一次；成功 → archive/，忙/不可达 → 留在 pending
3. 补投   aih server 每 3s tick 一次，目标空闲就投；aih peer flush 可以手动来一轮
```

所以 `aih peer send` 的 `ok` 表示**消息是否安全落盘**，而不是是否已送达：

```bash
aih peer send p-x "继续"
# 已投递 #pm-55a73279 → p-x（inject）
# 或
# 已入队 #pm-55a73279 → p-x（inject）：会话 p-x 正在跑回合（pane 持续有输出）……
# 目标空闲后由 aih server 自动投递；也可以 aih peer flush 手动补投。
```

`--json` 里对应 `state: "delivered" | "pending" | "failed"`。

**server 没起怎么办**：发送链路照常可用（落盘 + 立刻投一次），只是没人自动补投；
消息留在 `pending/`，`aih peer inbox` 能看到，`aih peer flush` 手动推一轮。

### 重试与过期

补投不是无限重试，也不是按次数封顶——**只有时间上限**：

- 退避 `min(60s, 3s × 2^(n-1))`：`3s → 6s → 12s → 24s → 48s → 60s → 60s …`
- 存活上限 **24h**（从 `createdAt` 算）：每轮 `flushPending` 开头跑一次 `expireStale`，
  到点的转 `failed`（`error: "expired"`）进 archive。按上面的节奏，24h 内最多试约 1440 次。
- 目标本身没了的错误**不重试**，立刻 `failed`：`session_completed` / `session_gone` /
  `session_not_found` / `missing_session_target` / `unsafe_session_target`。
- 每轮批量：后台 tick 5 条 / 3s，`aih peer flush` 20 条；先取全部 pending、按
  `nextAttemptAt` 过滤、再截断，避免前面一堆退避中的消息把后面到点的挤掉。

失败的消息默认不出现在 `aih peer inbox`（它只显示 pending + 已送达未读），
用 `aih peer inbox --state failed` 补看。

## 收件箱

```
<aiHome>/run/peer/
├── pending/<id>.json     待投递
├── inflight/<id>.json    已被某个投递者抢到，正在投
└── archive/<id>.json     已投递 / 已读 / 失败
```

**状态迁移一律是 `rename`**（同 fs 内原子）：server 的 tick 和 CLI 的 `aih peer flush`
同时跑时，只有 rename 成功的那一个会去投，不会重复注入。进程在 inflight 阶段被杀会
留下孤儿文件，按 mtime 超过 60s 自动退回 pending。

消息记录：

```json
{
  "id": "pm-<32 hex>",
  "from": { "channel": "inject", "provider": "codebuddycn", "name": "p-src", "address": "p-src", "sessionId": "..." },
  "to":   { "channel": "inject", "provider": "codex", "name": "p-dst", "address": "p-dst",
            "delivery": { "cliName": "codex", "runtimeScope": "acct_…", "sessionName": "p-dst" } },
  "replyTo": "",
  "body": "原始正文，保留换行",
  "state": "pending | delivered | read | failed",
  "attempts": [{ "at": 0, "channel": "inject", "ok": false, "error": "target_busy" }],
  "attemptCount": 1,
  "nextAttemptAt": 0
}
```

`attempts` 只保留**最近 20 条**明细（`DEFAULT_MAX_ATTEMPT_LOG`）：一条 24h 都投不出去的
消息会试上千次，全留会把记录撑到 100KB+，而且每次重试都要整份重写。**总次数记在
`attemptCount`**，退避和 `aih peer read --json` 都读它——数组长度只代表「日志还剩几条」，
拿它算退避会在截断后把等待时间打回 3s。

`to.delivery` 是**重投所需的全部信息**：补投时不必重新列会话（全量扫会话会把
server 主进程拖死，见「空闲判定」）。native 存 socket，webui-chat 只用 sessionId。

CLI：

```bash
aih peer inbox                    # 所有还没处理的（pending + 已送达未读）
aih peer inbox --self             # 只看看发给我的
aih peer inbox --target p-x       # 按收件人过滤
aih peer inbox --unread --json
aih peer read pm-55a73279         # 全文 + 线程，并标记已读
aih peer reply pm-55a73279 "收到"  # 回给原发送方，自动带 replyTo
aih peer flush                    # 手动补投一轮
```

`--self` 的解析顺序：`AIH_PEER_SELF` 环境变量 → tmux 当前会话名
（`$TMUX` + `display-message -p '#S'`）。不在会话里就报 `self_unresolved`。

`reply` 找不到原发送方时**直接报错**，不会把消息塞进 pending——否则用户会以为发出去了。

## 信封：注入通道只有一行

注入通道的表达能力就是「往输入框敲一行字 + Enter」。所以信封必须压成单行，并且自带
收件方需要的三件事：

```
[aih-peer #pm-55a73279 from p-src | reply: aih peer reply pm-55a73279] 正文，换行转义成 \n
```

- **真实换行会破坏「字面量 + 单独 Enter」的约束**（TUI 会把它当提前提交），所以正文里
  的换行一律转成字面 `\n`（两个字符）。原文完整保存在收件箱里，`aih peer read` 能看到。
- 超过 4000 字符截断，尾部补 `… (完整内容: aih peer read pm-xxxx)`。
- 其余 C0 控制字符清掉：`send-keys -l` 会把它们原样打进 pane，可能触发终端快捷键。
- native 通道复用同一个信封再套 claude 的 `<cross-session-message from=…>` 外层；
  webui-chat 直接把信封作为 `turn.submit` 的 content。
- `--no-envelope` 保留裸正文（脚本/调试用）。

## 空闲判定：等一个安静间隙

往一个正在重绘的 TUI 里打字，轻则内容被吞、重则和半截输出粘在一起。用户手打不会遇到
（人在等提示符），但 aih 是异步投递。

信号和账号活性探测同源：tmux `#{window_activity}`（当前窗口最后一次有输出的时刻），
`persistent-session.js` 已经解析成 `lastActivityAt`。

- `aih peer send` 默认最多等 **3 秒**找一个 `quietMs=1200ms` 的安静间隙；等不到就入队。
  `--wait <秒>` 可以改上限，`--wait 0` 表示只入队、不等。
- 后台 tick **不等**（`timeoutMs: 0`）：这一轮不安静就下一轮再来，不在 tick 里睡 3 秒。
- 读不到活动时间（会话刚没 / 旧版 tmux）按「可投」处理——真投不进去时 `send-keys`
  会给出权威失败。
- **列表里的 `lastActivityAt` 不能用来判「已经安静」**：它是全量扫描那一刻的快照，
  而扫描本身可能耗时数秒，快照到投递之间 pane 可能一直在输出。按快照算会把正在跑
  回合的会话误判成空闲、正文直接打进 TUI（真机踩过）。判安静只能现场探测，
  `lastActivityAt` 仅用于列表展示；补投 tick 的行本来就没有这个字段。

`webui-chat` 不用这套：chat runtime 的 `state === 'idle'` 就是权威空闲信号。

## 三条通道的边界

**native（claude）**

- 身份由 socket 对端凭据校验（收件方界面里的 `[verified pid …]`），`from` 只是标签。
- 默认**不带** `from-mode`：收件方会把消息挂起，等人在界面上按「Deliver」。
  这是有意的——「别的会话让我做的事」不算用户意图。
- token 文件可被同用户任何进程读取，所以它只防别的用户/别的机器。

**inject（tmux）**

- 先等安静期再投；等不到就排队，不会硬塞进正在跑的回合。
- 中文/特殊字符按字面量写（`send-keys -l`），Enter 单独一条命令发——同一条里塞
  Enter 会被当六个字符打出来。
- 不产生任何审计记录，也没有投递确认：返回成功只代表按键送到了 pty。

**webui-chat（命令总线）**

- 投递顺序：`turn.submit`（空闲）→ `queue.add {policy:'after_turn'}`（忙）→
  `turn.intervene {mode:'steer_current'}`（前两者都被拒）→ 都失败则留在收件箱。
- `/v0/webui/*` 即使 loopback 也要 Management Key（`webui-auth-gate.js`），地址和 key
  从 server config 读。**server 没起 / 没配 key 时这条通道静默降级成空列表**，
  其余通道照常可用。
- chat 会话固定走 Codex driver 且工具被禁用（`chat-harness-policy.js`），所以发过去的
  消息只能让它「说话」，不能让它执行命令。这是有意的隔离。

## 每个 harness 走哪条通道

`aih peer channels` 打印两张表：per-provider 的通道选择，以及每条通道怎么投递
（`--json` 给脚本用）。表在 `adapters/registry.js`，**逐条显式登记**，不允许
「其它 provider 默认走注入」——

| provider | 通道 | 依据 |
| --- | --- | --- |
| claude | native | 本机 UDS（本文档 `claude-cross-session-protocol.md`） |
| codebuddy / codebuddycn / workbuddy / workbuddycn | inject | teammate/channel 在服务端，本机无 socket |
| codex / codexchat | inject | collab agent 是进程内工具 |
| gemini / agy | inject | 无跨会话通道 |
| opencode | inject | 2.2.5 只有兼容层文案 |
| grok | inject | 只有 subagent（会话树） |
| qoder / qodercn / cline / zcode / kimi / kiro | inject | 单会话 TUI |

通道能力表（`PEER_CHANNELS`）：

| channel | delivery | receive | 说明 |
| --- | --- | --- | --- |
| native | protocol | yes | 对端有协议端点，投递有 id / 挂起语义 |
| inject | inject | yes | 往 pane 敲一行信封 + Enter，先等安静期 |
| webui-chat | turn | yes | chat runtime 命令总线，幂等 commandId |

补一个 provider 却忘了登记，`test/peer-messaging.test.js` 的矩阵断言会直接变红
（名单从 `listSupportedAiClis()` 派生，不是手抄的）。通道表同理：harness 用到但
`PEER_CHANNELS` 里没有的通道也会被挡住。

## 在会话里跑也能用（HOME 是投影这件事）

aih 启动的 harness 跑在**账号投影**里：`HOME=<aiHome>/run/auth-projections/<p>/<ref>`。
而 peer 要找的会话、claude 登记、`ai_home` 库都在宿主家目录。直接拿 `process.env.HOME`
会一条会话都看不到——偏偏「harness 自己发消息」正是主要用法。

所以统一解析宿主家目录：`AIH_HOST_HOME` → 非投影的 `HOME` →
`os.userInfo().homedir`（读 passwd，不受 HOME 影响）。命令、补全、扫描都用这一份
（`runtime/host-home.js` 的 `resolveUnprojectedHostHomeDir`）。

收件箱也在宿主那份 `ai_home` 下（`<hostHome>/.ai_home/run/peer`），所以投影里的会话
和宿主 CLI 看到的是同一个收件箱。

同一条规则也修了 `aih ss` 与它的 TAB：以前在会话内的 shell drawer 里跑 `aih ss`
会显示「没有活跃会话」，因为读的是投影里那个空的 `.ai_home`。

## 补全

- `aih peer send <TAB>` / `aih peer inbox --target <TAB>`：会话名
  （`codebuddy · 标题 · ● 运行中` 这样的注释）。
- `aih peer read|reply <TAB>`：收件箱里的 msg-id，按时间倒序（回复几乎总是针对刚收到的那条）。
- `--channel <TAB>`：`native | inject | webui-chat`。

数据来自**本地登记文件**（持久会话注册表 + 最近一次采集的缓存 + `~/.claude/sessions/*.json`
+ `run/peer/*.json`），不做 socket 探测——TAB 的预算仍是 100ms 量级（实测 ~50ms，
冷缓存首次会走一次完整采集）。

边界：注册表是「会话起过」才写的，刚起的会话可能还没进去；补全因此同时读
`aih ss` / `aih peer list` 写下的采集缓存，把「缓存里有、注册表里没有」的会话补上。

## 代码结构

```
lib/cli/services/peer/
├── index.js                  # target 归一 + 解析 + 落盘/投递/补投编排
├── store.js                  # 持久收件箱（pending / inflight / archive）
├── envelope.js               # 单行信封（换行转义 / 截断 / 控制字符）
├── idle.js                   # 安静期判定与等待（单会话探测，不做全量扫描）
├── scope.js                  # 宿主 home / claude 配置根 / 宿主 ai_home
└── adapters/
    ├── registry.js           # provider → 通道（HARNESS_CHANNELS）+ 通道能力（PEER_CHANNELS）
    ├── claude-uds.js         # native：登记发现 / token / 帧 / 发送
    ├── tmux-session.js       # inject：列 aih 持久会话 + 安静期 + buildSendKeysCommands
    └── webui-chat.js         # webui-chat：chat runtime 命令总线

lib/server/peer-dispatch-daemon.js   # 空闲推送的后台 tick（server 里接线）
```

target 形状统一为
`{ id, channel, provider, name, address, sessionId, cwd, status, lastActivityAt, busy, harness, handle }`，
`harness` 是能力表那一行（label/note），`handle` 是通道自己的句柄（claude 的 peer 记录 /
aih 的会话行）。加一个 harness 通道 = 加 adapter + 在 registry 里登记一行。

**补投 tick 的三条硬约束**（都是踩过的坑）：

1. 绝不在这里做全量会话扫描——`collectGlobalPersistentSessionRows` 会遍历账号目录和
   所有 tmux socket，3s 一轮会把 server 主进程拖死（见用量扫描卡死事件循环那次事故）。
   补投只按消息里存的目标做单点探测。
2. 每轮只处理少量消息（默认 5 条）。`spawnSync` 是同步的，一条卡住就是整个 server 卡住。
3. 不等安静期：这一轮不安静就下一轮再来。

## 与其它「多 agent」概念的区别

| 概念 | 通道 | 谁能用 |
| --- | --- | --- |
| `aih peer`（本文） | claude UDS / tmux 注入 / chat 命令总线 | 本机任何活会话 |
| claude teammate / 团队 | 文件 mailbox | claude 的 `--team-name` 会话 |
| codebuddy teammate / channel | 服务端目录 | codebuddy 家族 |
| codex collab agent | 进程内工具 | 单个 codex 会话内部 |

## 实测（2026-11-02，两条通道都走完整 CLI）

**inject**：在 codebuddy 4 号账号的 socket 上起一个临时会话（跑
`while read l; do echo "$l" >> /tmp/peer-inbox.txt; done`），然后

```bash
node bin/ai-home.js peer list            # 列表里出现 p-peer-selftest
node bin/ai-home.js peer send p-peer-selftest 'hello from aih peer'
cat /tmp/peer-inbox.txt                  # → hello from aih peer
```

收件进程真的读到了那一行（不是「命令返回 0」而已），随后 kill-session 清理。

**native**：造一个假 claude 会话（临时 HOME + UDS server + `sessions/<pid>.json` +
`.key`），`aih peer list` 认出它，`aih peer send --mode bypass` 之后服务端收到
`{"type":"auth"}` 与 user 帧，token 一致、信封是
`<cross-session-message from-mode="bypass">hello native</cross-session-message>`。

另外：`aih peer list` 在账号投影 HOME 下也能看到宿主的全部会话（见上一节），
`aih peer send <TAB>` 实测 50ms 内给出候选。

## 实测（2026-11-03，A/B 双会话完整回路）

在一个真实 aih socket（`aih-codebuddycn-<scope>`）上起两个临时 pane
（`p-peer-selftest-a` / `p-peer-selftest-b`，各自 `cat >> log`），走完整 CLI：

| 步骤 | 结果 |
| --- | --- |
| `aih peer send p-peer-selftest-b '多行正文…' --from p-peer-selftest-a` | `已投递 #pm-32a4f65a`；B 的 pane 收到单行信封，换行是字面 `\n`，引号与 `$HOME` 原样保留 |
| `aih peer inbox --target p-peer-selftest-b` | 1 条「已送达」 |
| `aih peer reply pm-32a4f65a '收到，我在' --from p-peer-selftest-b` | `已回复 #pm-225be2ff`；A 的 pane 收到，原消息自动标记已读 |
| `aih peer read pm-32a4f65a` | 全文（真实换行）+ 线程里列出那条回复 |
| B 的 pane 改成持续输出（`while true; do echo tick; sleep 0.1; done`） | `aih peer list` 的 IDLE 列变 `busy` |
| 此时 `aih peer send p-peer-selftest-b …` | `已入队 #pm-088787aa … target_busy`，pane 里一个字都没打进去 |
| 把 B 切回空闲 + 起一个 1s 周期的补投 tick | 一次 tick 后 `{"attempted":1,"delivered":1}`，消息出现在 B 的 pane |

**这一步抓到一个真 bug**：回复时只按 `sessionId` 找原发送方会失败——codebuddy 的多个
pane 会共享同一个 `agentSessionId`（未绑定原生会话的 pane 落到最近一次会话上），
`findPeerTarget` 于是多义返回 null。修法是按 `sessionId → 名字 → 地址 → id` 逐个试，
取第一个唯一命中；名字才是注入通道最可靠的地址。回归守卫在
`test/peer-messaging.test.js`（「sessionId 多义时退回名字定位」），实测把修复退回旧写法
这条会红。

清理：两个临时 pane 已 kill，测试产生的 3 条消息按 id 精确删除，采集缓存由随后的
`aih peer list` 刷新（确认 `selftest` 残留数为 0）。

## 实测（2026-11-03，重启 server 验证后台补投）

上一节最后一步用的是临时 tick 进程。这次在**真实 server 进程**里验证：

| 步骤 | 结果 |
| --- | --- |
| 按原参数重启（`--host 0.0.0.0 --port 9527 --no-proxy … --models-probe-accounts 8 --window-activation`） | pid 换新、9527 仍在听、`aih server status` 的 `stale` 消失 |
| 临时 pane 跑 `while :; do printf busy…; sleep 0.3; done`，`aih peer send --json` | `state: pending`、`queued: true`、`reason: target_busy`；pane 里 0 处正文 |
| Ctrl-C 让 pane 安静，**不跑 `aih peer flush`** | 约 7s 后消息自动出现在 pane 里 |

消息记录的 `attempts` 就是证据：`…100065 target_busy`（CLI 自己那次）→ `…104007
target_busy`（tick，还在安静期）→ `…113032 ok`（tick 补投成功）。全程没有任何手动命令。

**这一步又抓到一个真 bug**：`aih peer send` 用列表里的 `lastActivityAt` 判安静，而
全量扫描要 6s 左右——快照看着「6 秒没输出」，实际 pane 一直在跑循环，消息被直接打进
忙碌的 TUI。修法是判安静一律现场探测（`waitForQuiet`），不再信任快照。回归守卫在
`test/peer-messaging.test.js`（「列表快照看着安静、现场仍在输出时，必须判忙」），
实测把修复退回旧写法这条会红。

清理：临时 pane 已 kill，测试消息按 id 删除，`run/peer` 三个目录均为空。
