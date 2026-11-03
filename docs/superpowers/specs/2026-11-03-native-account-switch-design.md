# Native Account Switch Design

## Goal

`aih <provider> <accountId>` 在**原生模式**下支持会话内换号：额度用完 / 凭据失效时，把当前会话
无缝续接到下一个账号上。用户不再需要退出、再 `aih <provider> 2 resume <session>`。

网关（relay）模式不需要这个能力：请求由本地 server 按池调度，账号本来就不是会话的属性。

## Invariants

- **换号只换凭据，不换对话。** 账号是运行时属性，会话是用户的资产。换号后的进程必须续接
  同一段原生会话（native session identity），而不是新开一段。
- **会话身份只有一个来源。** `lib/cli/services/pty/session-identity.js` 同时服务「标题显示」
  与「换号续接」；不允许标题层和换号层各自解析一遍。
- **身份按可信度取，不猜。** 换号后写回 > 用户显式续接参数 > 持久会话注册表 > provider hook
  上报 > 会话库探测。前四路都是「确定的」，只有最后一路是按时间匹配。
- **续接参数走已验证的下发路径。** 拼参与 `aih <provider> resume <id>` 完全一致
  （`lib/runtime/provider-resume.js` 的策略表），不按 provider 特判。
- **标题不能空。** 会话名帧的三档兜底（真标题 → 用户命名 → 项目名 · #会话号）保证
  「当前是哪一段会话」永远可见。
- **解析不进主线程。** 会话库冷扫描（codebuddy 实测 ~0.8s）在子进程里做，标题只读缓存。

## Flow

```text
launch
  -> createSessionIdentity({provider, cwd, startedAt, forwardArgs, registry, hook})
  -> title watcher probes in a child process (backoff 1.5s..120s, stops at first hit)
  -> terminal title: sessionLabel = formatSessionLabel(oscTitle | storeTitle | named | project + #id)

switch(account N+1)
  -> identity = peekSessionId()            // 不阻塞，通常已在缓存里
  -> plan = planAccountSwitch({forwardArgs, identity, hasRunningPty})
       keepExplicit?  用户写了 --resume/--continue → 原样保留
       no pty / login? 没有「当前对话」可续 → 只摘旗标，不猜
       否则?          buildContinuationArgs(identity) + stripContinuationArgs(forwardArgs)
  -> title notice: '⇄ CodeBuddy 已自动换号 1→2' (12s TTL)
  -> respawn PTY with the new account projection, same native session id
```

## Why a respawn is unavoidable

原生 CLI 在启动时把凭据读进内存（env / 配置 / 账号投影目录），运行中改投影不会生效。
因此「无感」能优化的部分是：**同一段对话** + **一条可读的状态播报** + **不出现
「Waiting for X to boot」这种重开观感**（换号时用专门的等待文案）。

## Provider matrix

| provider | exact continuation | latest-session fallback |
| --- | --- | --- |
| codex | `resume <threadId>` | `--last`（注册表 / 旧账号 sqlite） |
| claude / qoder / grok / zcode | `--resume <id>` | `--continue` |
| codebuddy family | `--resume <id>` | `--continue` |
| agy | `--conversation <id>` | `--continue` |
| opencode | `--session <id>` | `--continue` |
| gemini | `--resume <id>` | `--resume latest` |
| cline | `--id <id>` | 无（明确拒绝） |
| kimi / kiro | 无 | 无（明确告知会开新会话） |

`--fork-session` 一类 fork 旗标**不算**续接旗标：它不是身份，只是「别写回原对话」的修饰，
换号时必须保留。

## Scope

包含：

- 会话身份的解析、缓存与写回（`session-identity.js`）
- 通用换号续接（所有有 resume 入口的 provider）
- 手动触发：会话内 **Ctrl-Alt-A** 换到下一个可用账号（`account-switch-shortcut.js`）
- 自动触发（`auto-switch-policy.js` + `usage-status-runtime` 的看门狗）：见下一节
- 标题的会话名：provider 自己写的 OSC 标题 > 会话库标题 > 用户命名 > `项目名 · #会话号`
- 「已自动换号」播报（`terminal-title` 的 notice 通道，12s，期间每秒重写以对抗 TUI 抢标题）
- 换号等待文案（不再显示「Waiting for X to boot」）

不包含：

- 换号后旧账号 tmux 会话的回收（目前只是与它分离，不影响新会话）。
- 跨进程的 429 冷却表：CLI 进程内的冷却只覆盖本次会话；跨进程的 (账号, 模型) 冷却由
  服务端的失败门禁负责（codebuddy 家族已有 `codebuddy-session-limit-observer`）。

## 自动触发

### 开关

模式默认**关闭**（`config:usage` 的 `auto_switch`）。打开方式：

```bash
aih <cli> auto-switch on|off|status [--remaining <0-100>]   # 全局持久（provider 动作层，与 usage 平级）
AIH_RUNTIME_USAGE=auto_switch=1[,auto_switch_remaining=100] aih agy 1   # 只影响本次会话
```

阈值 `auto_switch_remaining_pct`：缺省 `null` = 跟随 `threshold_pct`（默认 95 → 剩余 ≤ 5%），
与选号门禁 `resolveMinimumRemainingPct` 同一换算；显式给 `0` = 只在真的用完时换。

**行为变化（codex）**：换号看门狗以前只给 codex、且**始终开启**（剩余 ≤ 100−`threshold_pct` 就换）。
现在它与其它 provider 共用同一个开关，默认关闭。要恢复旧行为：
`aih codex auto-switch on`（阈值缺省就是 100−`threshold_pct`）。

### 两条触发

1. **额度见底**（`usage-status-runtime`：启动 5s 首判 + 60s 看门狗 + 每次新快照落地时的即时判定）
   - 启动就先判一次：账号本来就已用完时，用户不该等满一分钟才被换走。
   - 阈值按**账号级剩余**（快照里各窗口的 min，与选号门禁同一口径）；模型级额度的细分不在这一步。
   - 只认 5 分钟内的快照；过期先补一次探测（`refreshUsageForAutoSwitch`，同账号 60s 一次）。
     这条探测不受 `ptyUsageStatus` 限制——那个开关管的是标题显不显示，不是换号该不该有数据。
   - 同一账号 30s 内只尝试一次（900ms 的用量节拍会重复看到同一个数字）。
2. **429 且上游给了恢复时刻**（`observeRateLimitSignal`，从 PTY 输出尾部识别）
   - 认的写法：`usage exceeds frequency limit`、`API Error: 429`、`429 … rate limit`、
     `RESOURCE_EXHAUSTED`、`AI credits balance is too low`、`quota exceeded`。
   - **必须能解析出恢复时刻**才换：绝对时刻（`your usage will reset at 2026-10-31 14:57:00 UTC+8`）
     或相对提示（`try again in 2 hours` / `retry after 300`）。没有时刻的 429 是短促限流，
     换号只会白折腾，交给额度那条路。
   - 恢复时刻离现在不足 60s 不换；超过 24h 的提示按 24h 封顶。
   - 命中后记一条 (账号, 模型) 冷却，换号选目标时跳过仍在冷却里的账号（两个账号互相 429 时
     不会来回弹）。

两条触发最终都调用同一个 `switchToAccount`，因此续接、标题播报、等待文案与手动换号完全一致。

### 误判面

429 识别的唯一风险源是「用户自己敲的字也会出现在 PTY 输出里」。因此检测器**不接受**裸的
`rate limit` / `429`，必须是上游报错的原样写法，且必须带恢复时刻。

## Tests

单测：

- `test/session-identity.test.js`：身份优先级、续接参数矩阵、标题兜底、OSC 标题解析、子进程探测协议。
- `test/terminal-title-notice.test.js`：notice 覆盖轮播帧、优先于错误图标、TTL 到点退场、被 CLI 抢标题后重写。
- `test/account-switch-shortcut.test.js`：Ctrl-Alt-A 的三种终端编码，普通输入不误触。
- `test/auto-switch-policy.test.js`：429 信号（绝对/相对恢复时刻、无时刻不算、已过期不算、
  换行拆分仍能识别、24h 封顶）、误判面（裸 rate limit / 用户口吻不算）、阈值换算
  （缺省跟随 `threshold_pct`、显式 0、会话内覆盖）、冷却表（按 (账号,模型) 键控、过期自清、
  模型未知按账号级、不回退）。

真机 E2E（会用一个真实账号跑一次极短回合）：

```bash
# 手动触发（Ctrl-Alt-A）
node scripts/e2e-account-switch.js --provider codebuddy --from 1 --to 2 --yes
# 自动触发（不碰键盘；用 AIH_RUNTIME_USAGE 把阈值调到 100，让触发确定发生）
node scripts/e2e-account-switch.js --provider codebuddy --from 1 --to 2 --auto --yes
```

断言：换号动作发生、新账号续接同一个 native session id、标题播报了换号、换号后的
TUI 里能看见上一回合的内容、进程没有崩。脚本强制 `HOME` 为真实 home（沙箱里的 HOME
可能是账号投影），跑完清理自己造的 tmux 会话与四个 CodeBuddy 家族会话库目录。

2026-11-03 真机结果：

| 场景 | 结果 |
| --- | --- |
| codebuddy 手动 1→2 | 通过，会话 `01a19fd2-0118-7c48-9955-6b08bdab2a5c`，换号后仍能看到上一轮 PINEAPPLE 回合 |
| codebuddy **自动** 1→4 | 通过，会话 `01a19fde-ccb6-7759-a851-40be7a776c97`，未按任何键，标题 `⇄ CodeBuddy 已自动换号 1→4` |
| codebuddycn **自动** 1→2 | 通过，会话 `01a19fe6-a97f-7307-96c9-5b299e559c5b`，标题 `⇄ CodeBuddy CN 已自动换号 1→2` |
| agy | **不验证**（用户决定，2026-11-03）：本机没有 `agy` 可执行文件，且用户明确「本机 agy 账号我都关闭了，用 codebuddy family 系列测试」。agy 的续接参数矩阵（`--conversation <id>` / `--continue`）由单测覆盖 |

### 真实额度边界（不是恒真阈值）

为了证明换号是由**真实额度数字**驱动的、而不是「阈值设成 100 让条件恒真」，用
codebuddy 5 号（快照真实剩余 **50.0%**）做了两侧边界，不发送任何消息：

```bash
# 阈值 51 ≥ 真实剩余 50 → 必须换
node scripts/e2e-account-switch.js --provider codebuddy --from 5 --auto --remaining 51 --no-turn --yes
# 阈值 49 < 真实剩余 50 → 必须不换
node scripts/e2e-account-switch.js --provider codebuddy --from 5 --auto --remaining 49 --no-turn --expect no-switch --yes
```

| 阈值 | 真实剩余 | 结果 |
| --- | --- | --- |
| 51 | 50.0% | 换号 `5 → 7`，续接会话 `01a1a008-5a07-7dfc-a73d-de5289fbd5bf`，标题 `⇄ CodeBuddy 已自动换号 5→7`，换号后屏幕上重新出现上一段对话的内容（`markerAfterSwitch: true`） |
| 49 | 50.0% | **没有换号**（25s 观察窗，进程存活） |

两次都没发送任何消息、没按任何键：换号完全由「真实额度 50% 与阈值的比较」驱动。

真正的 0% 账号没有制造：那要把一个账号的额度烧光，代价是用户自己的资源。上面的边界证明
比较的是快照里的真实数字（`remaining <= threshold`），0% 时同一行代码必然成立。

429 触发用合成输入的真机 E2E 覆盖（`scripts/e2e-account-switch-limit.js`）：把假 CLI 放进
`<host home>/.local/bin`（CLI 解析链第一顺位），它每 5 秒重放一次上游原话
「429 usage exceeds frequency limit … your usage will reset at <now+10m> UTC」，账号与
凭据投影仍是真实的，只是那个 CLI 不联网、不消耗额度。

```bash
node scripts/e2e-account-switch-limit.js --provider codebuddy --from 1 --yes
```

2026-11-03 结果：`{firstSwitch: true, firstTarget: "7", secondSwitch: true, targets: ["7","4"],
coolingSkipped: true, cooldownMentioned: true, titleNotice: true, processAlive: true}` ——
第二次换号跳过了仍在冷却里的 1 号，没有来回弹。
