# 窗口激活（window activation）重设计

日期：2026-10-16
状态：规划（待确认后实施）
范围：`lib/server/window-activation-scheduler.js` 及其周边（探测规格、状态存储、WebUI 路由与弹窗）
不在范围：`/v1` 数据面、router 调度语义、额度刷新（reset credit）

---

## 1. 需求（用户口径）

GPT Plus（Codex）这类账号的 5 小时限额按**滚动窗口**计算：

- 你**使用**账号时才开窗：第一次请求把窗口锚定在该时刻，`重置时间 = 锚点 + 5h`。
- 窗口期内继续使用**不会**推迟重置点。
- 你在窗口外（无活跃窗口时）使用，会立刻开一个**新的** 5h 窗口 —— 于是你从"开始用"那一刻起，还要等整整 5 小时才能等到刷新。

于是不激活的代价是：

> 00:00 开始用 → 窗口 00:00–05:00；2 小时用完额度 → 要等到 05:00 才能继续，**干等 3 小时**。

而如果账号的窗口**已经被提前跑起来了**（例如 02:00 开始用时窗口已经跑了 2 小时）：

> 窗口 00:00–05:00；我 02:00 开始用 → 2 小时用完（04:00）→ **只等 1 小时**就刷新，接着用。

**所以窗口激活的目的不是"到点续窗"本身，而是让账号的 5h 窗口在你真正开始用之前就一直在滚动**：任何时刻开始使用时，窗口剩余时间都 < 5h（平均 2.5h），用完后平均只需等约 1 小时而不是 3 小时。

推论（决定了方案取向）：

- 窗口**关着**的每一分钟都是损失：用户这时候开口就是"从零计时的 5h"。
- 窗口**开着**的时候探测毫无收益（不移动锚点，纯烧 token）→ 探测只在"窗口刚关闭"时发生一次。
- 比 5h 更密的间隔不产生额外收益（窗口期内每一次探测都是空操作）；正确的节奏是**关窗即续**。
- 相位/作息对齐属于过度设计：链一直滚动时，用户开口时刻落在窗口期内的位置本身就近似均匀分布。

---

## 2. 上游事实（本机取证，2026-10-16）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 窗口由"关闭后的第一个请求"锚定，`reset = 锚点 + 5h`，秒级精确 | gmail `13:50:34.877` 探测 → 锚点 `13:50:35.000`（reset 18:50:35）；126.com `09:57:10.360` → reset 14:57:10；meadeodeo `10:21:40.571` → reset 15:21:40 |
| F2 | 窗口期内请求**不移动**锚点 | meadeodeo 10:21:40 锚定后 11:30 / 11:45 / 12:35 / 13:40 四次探测，reset 恒为 15:21:40 |
| F3 | 窗口关闭且无人使用时，快照报 `reset ≈ 读取时刻 + 5h`、`remaining = 100%`——**幻影值**，与真实活跃窗口形态完全一致 | gmail 12:43:51 读取；126.com 03:44:05 之后 |
| F4 | 只有真实请求（含我们的极小探测）会开窗；纯只读（用量快照刷新）**不**开窗 | 13:46:49 的 refresh 不开窗；F1 的探测开窗 |
| F5 | 探测响应**不**回写用量快照（codex relay 路径不采集 `x-codex-*` 速率头）| `lib/cli/services/usage/usage-snapshot-codex.js` 是唯一写入者（app-server `account/rateLimits/read`）|
| F6 | 探测签名：`in=10 / out=5`、model `gpt-5.6-sol`、`source=server_codex_proxy`、body `Reply exactly OK.` | `model_usage_records`、server.log |

---

## 3. 旧实现为什么没做到（BUG 根因）

旧触发链（`decideActivation`）：`reset_at 对齐` → `固定周期`（interval，默认 4h / 用户设 1h）+ `活跃闸门`，锚点 `max(lastActivatedAt, lastResetAtMs)`，并且**在 reset 点前 5 分钟内**就视为"已重置"。

失效率证据链（gmail `acct_55865084c85f0c4b34d3`，今日锚点 01:39:27 → 07:43:05 → 12:43:18 → 18:50:35）：

1. `12:42:55` 对齐探测打在**旧窗口**（比关窗早 23s）→ 空探，窗口没续上。
2. `12:43:51` 快照变幻影（F3）：`reset = 17:43:51 = 读取时刻 + 5h`。
3. `12:52–13:42` 所有 tick 全部判 `not_due` —— 因为决策只看 `now >= resetAtMs - 5min`，幻影 reset 永远在未来，于是**对齐触发永不成立**。
4. `13:50:32` 周期兜底才复开（距关窗 **67 分钟空窗**），而且这 67 分钟里"窗口是关的"，用户此时开口就要重新等 5 小时。

同类证据：126.com `03:43:06 / 09:50:06` 两次对齐探测都是"提前打进旧窗口"；两段实测延迟 63.6 分钟与 13 秒。
**结论：`reset_at 对齐` 从未成功复开过一次窗口。**

根因清单（都要在新设计里修掉）：

| # | 缺陷 | 后果 |
|---|---|---|
| R1 | 幻影与真窗口不可区分（只看 `resetAtMs` 是否在未来） | 对齐触发永久失效 → 只剩周期兜底 |
| R2 | "提前 5 分钟探测" | 窗口期内的探测是空操作（F2）→ 白探，且没续上 |
| R3 | 周期锚点受"窗口重置事件"影响（`lastResetAtMs`，空闲窗口不产生事件） | 兜底时刻漂移、不可预测 |
| R4 | `runtime_blocked` 早退排在所有触发之前，且**无恢复路径** | 实测 agy `acct_3ce26162844e68a9e25b` 停在 13 小时前，界面看起来"开着但其实永远不探" |
| R5 | 可观测性为零 | 弹窗只显示"上次探测 + outcome"，看不出窗口开没开、为什么跳过 |
| R6 | 探测计入 `accountActivity` | 活跃闸门被自己的探测干扰（虽不致命，但让"是否有人在用"失真） |
| R7 | agy 只有 `resetIn: '5h'` 标签（无 `resetAtMs`） | 对齐触发对 agy 天生不可用，只能纯周期 |
| R8 | `activated` 语义太粗（`matched` 即算成功，不看响应是否成功） | 上游报错的那次探测也会推进周期锚点 |

---

## 4. 新设计

### 4.1 一句话

> **每个账号维护一份「窗口账本」（锚点、关窗时刻、来源）；关窗后（或发现压根没有活跃窗口时）立刻补一次极小探测把窗口续上；窗口开着的时候一次都不探。**

三件事：**账本（ledger）+ 关窗即续（rechain）+ 幻影检测（phantom detection）**，删除 `reset_at 对齐` 与 reset 事件依赖。

### 4.2 状态与术语

- **锚点 `anchorAtMs`**：当前窗口起点（上游"关闭后第一个请求"的时刻）。
- **关窗时刻 `closeAtMs = anchorAtMs + windowMinutes*60000`**：窗口自然结束的时刻（窗口期内请求不移动它，F2 → 一旦知道锚点，关窗时刻就是**确定值**，不需要新鲜快照）。
- **活跃窗口 / 无窗口**：`now < closeAtMs` 为活跃；否则（且没人用）为无窗口。
- **幻影（phantom）**：无活跃窗口时上游按 `读取时刻 + 窗口时长` 现算出来的 reset；`resetAtMs - windowMinutes*60000 ≈ capturedAt`。
- **续窗（rechain）**：在窗口关闭后补一次极小探测，让下一个 5h 窗口立刻开始 —— 这是本功能唯一的"动作"。

### 4.3 快照观察（把快照翻成「窗口视图」）

对 spec 命中的 entry（codex：`windowMinutes = 300`）：

| 视图 | 判据 | 含义 |
|---|---|---|
| `live` | `capturedAt - (resetAtMs - windowMinutes*60000) > PHANTOM_TOLERANCE_MS`，**或**该锚点附近就是我们自己的探测点（`\|anchor - lastProbeAt\| ≤ 容差`） | `capturedAt` 时刻有一个活跃窗口，锚点已知（权威） |
| `absent` | `\|capturedAt - anchor\| ≤ 容差` 且锚点不落在我们的探测点附近 | `capturedAt` 时刻没有活跃窗口（幻影） |
| `unknown` | entry 缺失 / 无 `resetAtMs` / 无 `windowMinutes`（agy 形态） | 观察不出来 |

- `PHANTOM_TOLERANCE_MS = 90_000`：幻影的差值≈0（上游读取时刻与本地 `capturedAt` 相差秒级），真实活跃窗口的差值至少是"上次开窗到现在"（分钟级起）。**容差必须偏小**，因为两类误判代价不对称：
  - 误判成 `absent` → 多探一次（窗口开着时探测是空操作，无害）；
  - 误判成 `live` → 错过一次续窗（窗口一直关着，有害）。
  所以宁可多探，不可漏探。
- "刚探测过然后马上读到快照"是唯一会造成 `|capturedAt - anchor| ≤ 容差` 的真窗口场景，用 `lastProbeAt` 消歧（探测点附近即认定为 `live`，锚点取探测时刻）。

### 4.4 账本（per account）

落在既有 `account:window-activation-state:<ref>`（`lib/account/window-activation-store.js`，app_kv），在现有字段上**追加**（旧记录缺字段按 0/'' 兼容，读侧不抛）：

```
anchorAtMs        窗口锚点
windowMinutes     窗口时长（codex 300）
closeAtMs         关窗时刻 = anchorAtMs + windowMinutes*60000
windowSource      'snapshot' | 'probe' | 'activity'   （来源与置信度）
windowObservedAtMs 上次观察到的时刻（快照 capturedAt 或探测时刻）
probeFailureCount 连续失败次数（退避用）
lastDecision      最近一次判定 { action, reason, atMs }   ← 可观测性
lastProbeAt / lastActivatedAt / lastOutcome   （保留，语义收窄，见 4.7）
```

**推进规则**

| 事件 | 账本动作 |
|---|---|
| 快照观察 `live` | 覆盖：`anchor = resetAtMs - windowMinutes*60000`，`source = 'snapshot'`（权威） |
| 快照观察 `absent` | 若 `capturedAt > 已知 closeAtMs` → 置 `无窗口`（保留 `closeAtMs` 用于展示）；否则保留原账本（快照更旧，不倒退） |
| 探测成功且命中（`matched && ok`）且当时视图为 `无窗口/关窗已过` | 重新锚定：`anchor = probeAt`，`source = 'probe'`，`probeFailureCount = 0`，`lastActivatedAt = probeAt` |
| 探测未命中 / 失败 / matched 但上游报错 | 不推进账本，`probeFailureCount++`（按退避重试） |
| 关窗时刻已过，但发现关窗后有**非探测**流量 | 按"用户自己开了新窗"重锚（`anchor ≈ lastActivityAt`，`source = 'activity'`，置信度低；下一次快照观察会纠正） |

### 4.5 判定（`decideActivation` 新形态，仍是纯函数）

```
1  !enabled                → skip disabled
2  !spec                   → skip no_spec
3  apiKeyMode              → skip api_key_account
4  status === 'down'       → skip account_down
5  runtimeStatus 阻塞       → skip runtime_blocked        （不再无条件早退，见 4.6）
6  now - lastProbeAt < 45s → skip debounced
7  probeFailureCount > 0 && now - lastProbeAt < retryBackoffMs(10min)
                           → skip probe_retry_backoff

8  视图 = describeWindowView(ledger, now)
   ├─ open：
   │    now < closeAtMs − 0        → skip window_open          （窗口开着，一次都不探）
   │    now < closeAtMs + 60s      → skip close_grace          （吸收本地/上游时钟偏差）
   │    关窗后有非探测流量          → skip user_reopened        （记账本：activity 重锚）
   │    否则                       → probe window_closed       ★ 续窗
   ├─ absent：
   │    lastActivatedAt > observedAtMs → skip probe_pending_observation（读之后已经成功探过）
   │    否则                       → probe window_absent       ★ 立刻补窗
   └─ unknown：
        anchor = max(ledger.anchorAtMs, lastActivatedAt)
        now - anchor < interval    → skip not_due
        否则                       → probe periodic_fallback   （兜底，与旧版一致）
```

说明：

- **删除** `reset_at 对齐`（含 `PROBE_AHEAD_WINDOW_MS` 的"提前 5 分钟"）与 `listAccountQuotaResetEvents` 依赖（R2/R3）。
- **活跃闸门**从"间隔内有人用就跳过"改成"**关窗之后**有人用才跳过"：窗口期内有人用不影响续窗判定（F2：窗口期内流量不移动锚点，旧闸门会误判成"不用探"）。
- `absent` 分支是"幻影"的出口：看到幻影（或任何证据表明当前没有活跃窗口）就立刻复开，而不用等周期（R1）。
- `unknown` 分支只服务"观察不出来的账号"（agy 形态、快照缺失）：保持 interval 兜底，默认值建议从 4h 降到 1h（成本可忽略：每账号每次只花 ~15 token）。
- 判定与账本更新都在**同一 tick 内**完成（先观察→再对账→再判定）；状态只在**发生变化时**落盘（避免每 10 分钟一次无意义写）。

### 4.6 阻塞账号（R4）

`runtime_blocked` 从"无条件早退且无恢复"改成"跳过但可见、且依赖既有刷新链路恢复"：

- 跳过原因是 **可观察**的：`lastDecision.reason = runtime_blocked`、带上账号运行态的 reason（如 `permission_denied` / `quota_exhausted`），弹窗显示"账号运行态被阻塞，不会探测"。
- **额度类阻塞（`quota_exhausted`）的恢复路径已经存在**：`lib/server/account-quota-probe-scheduler.js` 每 1 分钟扫一次，`remainingPct <= 95 && now >= resetAtMs - 3min`（关窗前后持续成立）会 `forceRefresh` 读一次用量 → 快照回到 100% → 账号可用性恢复（`account-availability.js` 的 `quota_exhausted` 由快照派生）→ 我们下一个 tick 的探测就能命中并续窗。**这是本设计与既有权衡链的显式依赖，需要写进注释与测试。**
- 鉴权/权限类阻塞（`auth_invalid` / `permission_denied`）本质不可由探测修复 → 一直跳过但可见（不再"看起来开着"）。
- 不做"严格钉选（禁止池回落）"：那是 router 调度语义的改动，收益只有极小额度，YAGNI（列在 §9）。

### 4.7 保留但收窄的语义

- `lastProbeAt`：仍是防抖/退避基准（每次探测都写）。
- `lastActivatedAt`：只有 `matched && ok` 才推进（R8 修复），并**只在 `unknown` 兜底分支**当周期锚点用（`live`/`absent` 分支不看它）。
- 间隔 `intervalMs`（账号级配置）：从"主旋钮"降级为"**观察不出窗口时的兜底节奏**"。比 5h 更密的间隔不再有意义（窗口期内探测是空操作），因此 UI 文案要跟着改（避免用户以为调小间隔会更快续窗）。
- `lastResetAtMs`（quota-reset 事件）：不再参与判定；账本与快照是唯一事实来源。

### 4.8 探测结果分类

| 情形 | outcome | 含义 |
|---|---|---|
| `matched && ok` | `activated` | 命中目标账号且请求成功 → **窗口已续上**（账本重锚） |
| `matched && !ok` | `matched_upstream_error` | 打到了账号但上游失败 → 退避重试，不推进账本（R8） |
| `!matched` | `account_not_matched` | 钉选被池回落（额度被别的账号花掉）→ 退避重试 |
| 无模型 | `no_probe_model` | 账号目录里没有可探测模型 → 可见但不重试（等目录刷新） |
| 传输失败 | `probe_transport_failure` / … | 退避重试（既有分类） |

### 4.9 观测性（R5）

- **state 落盘**：每账号 `lastDecision = {action, reason, atMs}` + 窗口视图字段。
- **server.log**：只在**状态发生变化**时打一行（`window activation: <ref> window_open(close 18:50:35)` / `rechain probe → activated` / `skip runtime_blocked(permission_denied)`），避免每 tick 刷屏。
- **WebUI**（`GET /v0/webui/accounts/:provider/:ref/window-activation`）响应追加：

```json
{
  "setting":  { "enabled": true, "intervalMs": 3600000 },
  "global":   { "...既有字段不变..." },
  "lastProbe":{ "at": 0, "outcome": "activated" },
  "window":   { "kind": "open|absent|unknown",
                "closeAtMs": 0, "windowMinutes": 300,
                "observedAtMs": 0, "source": "probe",
                "lastDecision": { "action": "skip", "reason": "window_open", "atMs": 0 } }
}
```

- **弹窗**（`AccountWindowActivationModal` + `window-activation-presentation.ts`）加一行紧凑状态（遵守 UI 约束：不用整块提示、不用左侧色条）：

```
窗口   运行中 · 18:50 重置（探测开启）        [绿色标签]
窗口   无活跃窗口 · 等待复开（下次扫描 ≤ 10 分钟）
窗口   不适用（账号运行态被阻塞：permission_denied）
```

---

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `lib/server/window-activation/window-ledger.js`（新增） | 纯函数：`observeWindow(snapshot, spec, {lastProbeAt, now})` → `live/absent/unknown`；`reconcileLedger(ledger, observation)`；`describeWindowView(ledger, now)`；`anchorWindowAt`/`markProbeFailure`；常量 `PHANTOM_TOLERANCE_MS=90s`、`PROBE_GRACE_MS=60s`、`PROBE_RETRY_BACKOFF_MS=10min`、`ACTIVITY_EPS_MS=15s`。无 IO、无 provider 名硬编码（走 spec） |
| `lib/server/window-activation-scheduler.js` | `decideActivation` 重写（4.5 的判定表）；tick 内先观察再判定；探测结果按 4.8 分类并写账本；删 `PROBE_AHEAD_WINDOW_MS` 与 quota-reset 事件依赖；落盘只在内容变化时发生；`getState()` 暴露 per-account 摘要 |
| `lib/account/window-activation-store.js` | state 记录追加账本字段（4.4）；`normalizeWindowActivationState` 兼容旧记录；写侧保持形状校验 |
| `lib/server/window-activation/probe-specs.js` | **未改**（见 §11 与 §8 的偏差说明：观察是数据驱动的，`windowMode` 推迟到 P1 与 agy 一起做） |
| `lib/server/webui-window-activation-routes.js` | GET/POST 响应追加 `window`（含 `lastDecision`）、`lastProbe` 保持兼容；视图复用 `describeWindowView`（展示与决策同源） |
| `lib/server/args.js`、`lib/server/server-config-store.js` | 兜底间隔默认值 4h → 1h（interval 降级为"观察不出窗口时的兜底节奏"，与下限对齐） |
| `web/src/types`、`web/src/features/accounts/window-activation-presentation.ts`、`AccountWindowActivationModal.tsx` | 渲染 4.9 的窗口状态行与最近判定原因；文案同步"间隔=兜底节奏" |
| `test/window-activation-ledger.test.js`（新增）、`test/window-activation-scheduler.test.js`、`test/window-activation-store.test.js`、`test/webui-window-activation-routes.test.js`、`test/web.window-activation-contract.test.js`、`web/src/features/accounts/window-activation-presentation.test.ts` | §6 |

不改：`probe-dispatch.js`、`probe-model.js`、`/v1` 数据面、router、账号状态服务。

---

## 6. 测试计划

**单元（ledger）**
1. `live` 判定：`resetAtMs - 5h` 远早于 `capturedAt`（含 meadeodeo 真实样例 10:21:40 / 15:21:40）。
2. `absent`（幻影）判定：真实样例（gmail 12:43:51、`reset = capturedAt + 5h`）。
3. 容差边界：差值 89s（absent）/ 91s（live）；"探测后 30s 读快照"→ 靠 `lastProbeAt` 判 `live`。
4. `unknown`：无 entry、无 `resetAtMs`、agy 形态（`resetIn: '5h'` 无分钟数）。
5. `reconcileLedger`：快照更旧不倒退；`absent` 只在其 `capturedAt > closeAtMs` 时置"无窗口"；探测成功重锚；失败计数。

**单元（decideActivation）**
6. 窗口开着（含"远未到关窗"）→ `skip window_open`，且**不**产生任何探测（回归 R1：幻影不会再被当成活跃窗口。
7. 关窗时刻刚过（< grace）→ `skip close_grace`；过期后 → `probe window_closed`。
8. 关窗后已有非探测流量 → `skip user_reopened`（R6 语义修正）。
9. 幻影 → `probe window_absent`（不等周期）。
10. 上一轮探测失败 → `skip probe_retry_backoff`，退避到期后重试。
11. `runtime_blocked` → skip 且带 reason；解除后同一 tick 走 `window_closed/absent` 分支。
12. `unknown` 且距上次激活 ≥ interval → `probe periodic_fallback`；旧版 state 记录（无账本字段）行为等价于当前兜底。
13. `api_key_account` / `no_spec` / `disabled` / `debounced` 不变。

**Web/路由**
14. 路由返回 `window.kind/lastDecision`；旧客户端（不读新字段）不受影响。
15. `window-activation-presentation` 的窗口状态文案单测；`cd web && npm run build` + eslint（改动文件）+ 相关 web 单测。

**真机验收（必须做，不能只看单测）**
16. 选 gmail + 126.com + meadeodeo：连续观察 ≥ 2 个周期，每次关窗后 ≤ 12 分钟（tick 10 分钟 + grace）复开；锚点间隔 5h ± 15 分钟。
17. 24 小时内每账号探测次数 ≈ 5 次（±1，来自 `model_usage_records` 的 `in=10/out=5` 签名）——旧实现下窗口期内还会空探，因此期望是"探测次数明显下降"。
18. `app-state.db` 的 `account:window-activation-state:*` 落到账本形态；server.log 只在状态变化时出行。
19. 弹窗显示"运行中 · X 重置 / 无活跃窗口 · 等待复开 / 不适用（阻塞原因）"。
20. 回归：全局开关关闭 → 零探测；账号开关关闭 → 零探测。

---

## 7. 收益与成本

- 成本：每账号每个窗口一次探测（in 10 / out 5 token），每天 ≈ 5 次 ≈ 75 token（旧实现：窗口期内每 1h 空探一次 → 每 5h 约 5 次）。
- 收益（按"2 小时用完 5h 额度"建模）：用完后的平均等待从 **3 h 降到 ≈ 0.9 h**（窗口剩余时间在 0–5h 均匀分布）；任意时刻开口都能吃到"窗口已经跑过一段"的好处。
- 附带修复：幻影不再让调度器永久空转；阻塞账号不再"静默不动作"；探测次数下降而窗口覆盖度上升。

---

## 8. 分期

- **P0（本次）**：codex 链 —— 账本 + 关窗即续 + 幻影检测 + 阻塞可见 + 观测性 + 测试/真机验收。
- **P1**：agy 并入。先取证 agy 的窗口语义（`windowMatch` 只有 `resetIn: '5h'` 标签、无 `resetAtMs`），确认后给 spec 声明 `windowMode: 'fixed'`（锚点=探测点，时长 300 分钟）；在取证完成前 agy 留在 `unknown` 兜底分支（当前行为）。
- **P2（可选，YAGNI）**：账号列表的窗口状态列、窗口历史/统计。

---

## 9. 明确不做

1. **不做相位/作息对齐**：链持续滚动时用户开口时刻在窗口内的位置天然近似均匀；对齐需要预测用户行为，收益不确定。
2. **不做"提前探测"**：窗口期的探测是空操作（F2），只会白烧 token（R2）。
3. **不做比 5h 更密的探测**：密于窗口时长不产生任何收益（见 §1 推论）。
4. **不做"严格钉选/禁止池回落"**：需要改 router 调度语义，收益仅"少花一次极小额度"，YAGNI。当前以 `matched=false → 退避重试` 处理。
5. **不混入额度刷新（reset credit）**：两件事互相独立（gmail 的 `rateLimitResetCredits.availableCount` 是另一条通道），本设计不碰。
6. **不新增定时"对账读"**：账本自带关窗时刻，不依赖快照新鲜度；需要新鲜快照的场景由既有 `account-quota-probe-scheduler` 覆盖（消费过的账号 ≤15 分钟刷新一次）。

---

## 10. 验收标准（Definition of Done）

1. §6 的 1–15 全绿；`npm test` 全绿。
2. 真机 §6 的 16–20 有可复核的日志/数据库证据（写入本规划文档末尾或提交信息）。
3. 触发名与账本字段在路由/弹窗可见：能回答"这个账号现在窗口开没开、下一次什么时候探、为什么没探"。
4. `docs/architecture/design-patterns.md` 的窗口激活条目同步更新（Registry + Capability Flag 仍在，触发模型变更要写清楚）。

---

## 11. 实施记录（P0，2026-10-16）

实现落在 `lib/server/window-activation/window-ledger.js`（新）+ `window-activation-scheduler.js`（重写判定）
+ store 字段扩展 + 路由/弹窗。与 §4 的设计相比有 4 处有意偏差（都是实现期发现更稳的选择）：

1. **不加 `windowMode`（推迟到 P1）**：观察是数据驱动的（`resetAtMs` + `windowMinutes` 都在就推锚点，
   缺一个就 `unknown`），加一个只有单一取值的字段是投机；agy 因此自然落在 `unknown` 兜底分支 = P0 目标行为。
   P1 并入 agy 时再加 `windowMode: 'fixed'`（锚点=探测时刻）。
2. **账本只在"窗口已确认关闭/缺失"时锚定到探测时刻**（`trigger ∈ {window_closed, window_absent}`）：
   `unknown` 视图下成功的探测不锚定 —— 那时并不知道探测是开了新窗还是落进了旧窗，锚定会把 agy
   误带进链模式（少探 = 窗口可能一直空着）。`lastActivatedAt` 仍然照旧在每次成功探测时推进（兜底节奏锚点）。
3. **失败退避分两类**：`account_not_matched`（池回落）/ `no_probe_model` 按**兜底间隔**重试
   （10 分钟内不会有变化，且池回落会白花别的账号额度）；其余失败（打到账号但上游报错、传输失败）
   按 `10 分钟 × 失败次数` 线性退避、封顶兜底间隔 —— 关窗后的失败要尽快重试。
4. **`unknown` 分支保留旧的活跃闸门**（"兜底间隔内有真实流量就跳过"）：该分支没有"关窗"概念，
   用旧语义最贴近既有行为；链分支的闸门则按 §4.5 收窄为"关窗之后有非探测流量才跳过"。

验证（本次提交）：
- `node --test test/window-activation-{ledger,scheduler,store,probe-specs,probe-model}.test.js test/webui-window-activation-routes.test.js test/web.window-activation-contract.test.js test/server.args.window-activation.test.js test/server-config-store.test.js test/account-quota-probe-scheduler.test.js` 全绿。
- `bun test web/src/features/accounts/window-activation-presentation.test.ts` 全绿。
- `cd web && npx eslint <改动文件> --max-warnings 0` 干净；`cd web && npm run build` 通过。
- 真机验收（§6 的 16–20）待 Server 重启后按 §10.2 记录。
