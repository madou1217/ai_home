# Chat legacy 引擎退役就绪度（2026-10-15 审计）

> 结论：**代码层面替换未完成，当前不可删 legacy。** chat 模式已 100% 替换；**work（项目会话）模式除 codex OAuth 账号外一个 provider 都没替换**。
> 本文是删除前的硬性前置条件清单；每条都要有验证方式，未全部满足前不得删除 `web/src/features/legacy-chat/**` 与 `web/src/components/chat/MessageArea.tsx`。

## 1. 现状矩阵（代码事实）

判定入口：`web/src/features/chat-runtime/session-surface-policy.ts` 的 `usesCanonicalSessionRuntime()`：
`session.mode === 'chat'` → 恒 canonical；否则要求 `chatRuntimeProviders.resolve(provider)` 命中且 `descriptor.acceptsAccount(account)`。

| 会话模式 | provider / 账号 | 引擎 | 证据 |
| --- | --- | --- | --- |
| chat（纯对话） | 任意 provider | **canonical** | 模式短路 |
| work（项目会话） | codex + OAuth（非 api-key） | canonical | 注册表唯一条目 |
| work（项目会话） | **codex + API Key**，以及引擎支持的其余 **13** 个 provider：claude / gemini / agy / opencode / grok / zcode / qoder / qodercn / cline / codebuddy / codebuddycn / workbuddy / workbuddycn | **legacy** | 注册表未命中 / `acceptsAccount` 返回 false |

legacy 的真实服务面来自引擎名单 `OFFICIAL_NATIVE_SESSION_PROVIDERS`（`lib/server/native-session-chat-utils.js:22`，含 codebuddy 家族 4 支），
与合同声明的 `session_runtime`（只有 agy / claude / cline / codex / opencode）**不同源** —— 引擎多服务 9 个 provider，
这是替换时要一并收敛的契约缺口。

就绪度守卫（只读，可重复跑）：`npm run chat:legacy-readiness`（`scripts/chat-legacy-readiness.js`）。
当前输出：`legacy 服务面 14 个 provider / canonical 表面注册 1 个 / 驱动 1 个`，退出码 **1（不可删）**。

canonical provider 注册表只有一条：`web/src/features/chat-runtime/runtime-provider-registry.ts`
`nativeCredentialProvider('codex')`，且 `acceptsAccount = provider==='codex' && !gateway && !apiKeyMode`。

## 2. work 模式为什么没替换（根因）

1. **canonical 没有 work 模式的驱动**：`lib/server/chat-runtime-composition.js` 的 `driverRegistry.resolve()`
   对非 chat 会话走 `providerRegistry.resolve(provider)`；而该注册表只注册了 codex
   （`createCodexProviderRegistration`），`options.providerDriverRegistrations` **全仓无人传**。
   → 其它 provider 在 canonical 里没有 driver，只会 `provider_driver_entry_invalid` / `runtime_provider_unsupported`。
2. **canonical 未桥接现有原生会话引擎**：`grep -rn "spawnNativeSessionStream" lib/server/chat-runtime*` 为空
   （legacy 的原生会话实现在 `lib/server/native-session-chat.js`，未接入 canonical driver 契约）。
3. **web 侧注册表同样是硬编码 codex**（且排除 api-key 账号），与后端驱动能力不同源。

## 3. 删除前的硬性前置条件（全部满足才可删）

| # | 前置条件 | 落点 | 验收方式 |
| --- | --- | --- | --- |
| 1 | **原生会话驱动进 canonical**：把 `native-session-chat.js` 的 `spawnNativeSessionStream`（含 resume/continue、PTY 与 headless 两条路）包成 canonical driver 契约（`startTurn` / `waitForIdle` / `rehydrate` / `dispose` / `capabilities` / `composerCatalog` / `handlers`，按 `codex-session-driver.js` 的形状） | 新 `lib/server/chat-runtime/native-session-driver.js` | work 会话在 canonical 下能跑通一轮（真机） |
| 2 | **驱动注册按能力而非 provider 名**：从生成合同（`session_runtime` 能力）派生注册列表，禁止在 composition 里写 provider 清单 | `lib/server/chat-runtime-composition.js` | 新增 provider 只需描述符，不需要改 composition |
| 3 | **web 注册表同源**：`runtime-provider-registry.ts` 由合同派生，并覆盖 api-key 账号（legacy 现在允许 API-key 账号跑 work 会话） | `web/src/features/chat-runtime/runtime-provider-registry.ts` | 每个 `session_runtime` provider × {OAuth, API Key} 都命中 canonical |
| 4 | **能力对齐**：legacy 独有而 canonical 缺失的面必须补齐或显式降级并可观察 —— 至少 **slash 命令全集**（canonical 现在只有 `compact`）与 **终端流**（canonical 快照为 `terminal.stream: unsupported`） | `capability-command-catalog.js` / driver 能力快照 | 逐项对比 legacy 与 canonical 的能力快照，无「静默缺失」 |
| 5 | **守卫**：删除前必须存在一个断言「`usesCanonicalSessionRuntime` 对全部 provider × 账号形态返回 true」的检查，防止删完发现某 provider 没有界面 | 测试或脚本 | 该检查在当前代码下必须红（证明 legacy 仍必需） |

## 4. 当前判定

**进展（2026-10-15 第二轮）：条件 ① ② 已完成，③ ④ ⑤ 待做。**

- ① 原生会话驱动已进 canonical：`lib/server/chat-runtime/native-session-driver.js`（复用 `spawnNativeSessionStream`，
  只做参数适配 + 事件翻译 + 生命周期桥接；事件翻译在 `native-session-event-bridge.js`）。
- ② 注册按能力派生：`chat-runtime-composition.js` 的 `nativeSessionProviderRegistrations()` 名单直接来自
  `OFFICIAL_NATIVE_SESSION_PROVIDERS`（引擎加一支自动跟上），codex 由 app-server 驱动覆盖故跳过。
- 真机验证：work 会话（provider=opencode，accountRef=acct_6019…，projectPath=/tmp/aih-work-e2e）在 canonical 下
  跑通一轮 —— 事件序列 `turn.started → session.runtime.bound → timeline.item.delta → timeline.item.completed →
  turn.phase.changed → turn.completed`，时间线拿到 assistant「开工」；会话 `runtimeId=opencode:<accountRef>`，
  能力快照里 `session.resume=native`、`slash.execute/terminal.stream/interaction.approval=unsupported`（诚实降级）。
- 守卫现状：`驱动未覆盖: (无)`；**剩余缺口 = web 表面**（13 个 provider 未注册 + 不接受 api-key 账号）→ 条件 ③；
  条件 ④（slash / terminal / 审批对齐）仍未做，因此现在**仍不可删**。

**⚠️ 安全前置：③ 不能先于 ④（审批桥）。** 证据：legacy 的 confirm/plan 走审批桥
（claude 注入 approval MCP config + `approvalRequestUrl`、grok 用 approval args、opencode 走 serve runner，
见 `lib/server/native-session-chat.js:334-343` 与 `webui-chat-routes.js:874-880`）；而本驱动走 headless 路径、
**没有权限回路** —— 直接放开 web 表面会让 13 个 provider 的 confirm/plan 会话失去权限提示（安全回归）。
因此驱动内已加 fail-closed 守卫：`approvalMode !== 'bypass'` 时抛
`native_session_approval_bridge_unavailable`（501），绝不静默降级为无权限提示直跑。
真机已验证：confirm 模式 → 501 明确拒绝；bypass 模式 → 正常跑通。

条件 1–5 中 1、2 已满足；3、4、5 未满足（3 被 4 阻塞）。

---

## 4.3 agy 链路打通 + 地区资格账号处理（2026-10-15 第五轮）

**agy 在 canonical 里由「三层失败」到全绿**（每层都是数据/描述符层修复，驱动无 provider 分支）：

1. `TMUX_RUN_PROVIDERS` 曾是写死的 `{claude,codex,opencode}` → agy 被排除后回退 node-pty，而
   `agy --print` 在 node-pty 下**挂住不退**（同 argv/env/投影在 tmux 里 14s 完成）。现在该集合由
   描述符的 `tmuxRun` 派生，agy 在自己的行里声明 `tmuxRun: true`。
2. 非交互分支此前不认 `streamRawStdout` → agy 的纯文本 stdout 被当 terminal-output 丢掉，时间线为空。
   现在与交互分支同语义（stdout 即正文）。
3. 事件桥补条目生命周期：首个 delta 前发 `timeline.item.started`、轮次收尾 `finalize()` 补
   `timeline.item.completed`（引擎不发 `result` 的 provider 也不会停在 streaming）。

**真机（本机 9527）**：agy `ok` 14s / `session.runtime.bound` / 时间线 1 条 assistant 消息
（`content="ok"`，含 ttftMs/durationMs）；回归 cline 18s、codebuddy 8s、grok 15s 全部 `items=1`。

**agy 账号可用性核查（7 个账号逐个真机跑 `--print`）**：6 个可用，1 个被地区资格拒用：

| 账号 | 结果 |
| --- | --- |
| 270577450@qq.com / horsebeanbean@ / madou1217@live.com / codebeanbean@ / maxuyao0820@ / madou1217@gmail.com | ok（13–18s） |
| **meadeodeo@gmail.com**（`acct_3ce26162844e68a9e25b`） | `Eligibility check failed: … not currently available in your location.`（3/3 稳定复现） |

该账号此前用量正常（累计 6.4 亿 token），现被上游按地区拒用 → 归到新的声明式规则
（`agy_region_not_eligible`）：
- 本轮失败带可读文案（`turn.failed` + eligibility 原文，12s 内失败，不再挂死）；
- 账号运行态被摘出调度池：`runtimeStatus=permission_denied`、`schedulableStatus=blocked_by_runtime_status`、
  `runtimeReason=agy_region_not_eligible`（routingBlock 语义：探测成功不会推翻，需人工恢复或地区状态改变）。
- 附带修复：canonical 驱动此前**没接**账号运行态端口（hub/state-service）→ 任何 native session 的
  失败判定都写不回账号。现在经 `getAccountRuntimePorts`（延迟求值）注入。

## 4.2 条件 ④ 第二批（2026-10-15 第四轮）：启动档案 + 准备管线 + agy 链路修复

**四个修复（都按「描述符/注册表 + 单一事实来源」，驱动层无 provider 分支）：**

1. `native-session-launch-profile.js`（新）—— 启动档案：执行模式/prompt 投递取自
   `native-session-chat-transport`，运行事实取自 `chat-runner-profile`；模式→形态、投递通道→是否 PTY
   都是表。驱动不再硬编码 `interactiveCli`/`prompt`/形态旗标。
2. `native-session-launch-preparation.js`（新）—— 启动准备管线：步骤由档案声明、实现由注册表按 id 提供
   （`session-store-links` / `session-index`），未注册/端口不可用记诊断（`chat_native_preparation`）。
   **补上了 CLI 路径有、canonical 缺的「账号投影会话链接对账」**（`pty-runtime-run.js:301` 同款）。
3. `session-store.js` —— 声明的 provider 本地别名（`agy: cli.log`）语义修正：允许落在宿主受管根**或投影自身**，
   并容忍**日志轮换导致的悬空目标**（realpath 优先、失败退回链接文本解析）。此前一个被轮换的日志别名
   会把整账号判 `provider_resource_reconcile_incomplete:cli.log`（canonical 与 legacy 同病）。
4. 默认模型解析：驱动在 turn/策略都没给模型时，用与 legacy **同一处**的 `resolveProviderDefaultModel`
   （server.js 注入端口）。缺它时 CLI 会停在模型选择上永不返回。

**验证**：`test/session-store.test.js` 等 70/70 通过（含既有 agy 别名测试）；chat-runtime-composition /
chat-harness-gateway / runtime-target 的 3 个失败在**无本次改动时同样失败**（其他会话 WIP，非回归）。

**agy 现状（未绿，但病因已收窄到「引擎完成判定」）**：修复后 agy 依次前进
`provider_resource_reconcile_incomplete` → 真实启动并流式输出 → 仍不结束。已逐项排除环境因素：
同一 argv（`agy --print <prompt> --dangerously-skip-permissions`）+ 同一投影 HOME，在 shell 里
10s 内 `ok`/exit 0，在 tmux 里（带/不带 skip flag）同样 `ok`/exit 0；进程 env 实测正确
（HOME=投影、PATH、LANG、TERM 齐备）。剩余差异只在**引擎的完成判定**：agy 属于
`pty-transcript` + `completeOnTranscriptUpdate=false`（等进程退出），而 tmux 包装的退出标记未被该模式识别。
下一步：修引擎的 pty-transcript 完成判定（数据驱动，不加 provider 分支）。


## 4.1 条件 ④ 进展（2026-10-15 第三轮）：审批按策略表工程化

**已完成（架构 + 真机验证）：**

1. `lib/server/chat-runtime/native-approval-transports.js` —— **审批传输策略表**：
   每行声明 `providers` / `modes` / `accountTypes` / `spawner` / `launch()` / 未接线原因；
   求值 = 表顺序首个谓词全命中的行。驱动只按解析结果派发（**无 provider 分支**），
   未声明或未接线一律 fail closed。执行器走 `createApprovalSpawnerRegistry`（id → 实现）。
   - `claude` → `claude-permission-prompt-tool`（`http-callback`，spawner `native-stream`）
   - `opencode` → `opencode-serve-permission`（`serve-permission`，spawner `opencode-serve`）
   - `grok` → 声明存在但 `terminal-prompt` 未接线（fail closed，原因 `native_session_terminal_approval_not_wired`）
2. `lib/server/chat-runtime/native-approval-surface.js` —— **传输无关审批面**：
   权限请求 → canonical `interaction.requested`（既有审批卡 UI 零改动）→ `approval.decide`
   → claim/finish（复用 `InteractionResolutionCoordinator`）→ 回填传输层；run 结束/通道断开自动 deny。
   MCP HTTP 回调与 legacy 共用同一个 loopback ingress，按 **run 身份归属**分流（不看 provider）。
3. 驱动接线：`native-session-chat` 新增 `approvalRunId`（canonical 用自己的 run 身份，legacy 行为不变）；
   `opencode-serve-runner` 支持注入 `approvalSurface`（未注入 = 原 legacy 审批桥，行为零变化）；
   `handlers['approval.decide']` 由审批面提供（与 codex 驱动同形状）。
4. `lib/server/opencode-serve-api-layouts.js` —— **serve API 布局表**：v1（无前缀/无鉴权）与
   v2（`/api/*` + Basic + `{data}` 信封）差异声明成数据。

**真机证据（本机 9527，opencode v2.0.29 / claude 2.1.300）：**

- 派发：`claude/confirm → native-stream + approvalMode/approvalRequestUrl/approvalRunId`；
  `opencode/confirm → opencode-serve + 审批面`；`opencode/bypass → native-stream`；
  `grok/confirm`、`gemini/confirm` → 501 + 声明原因。
- claude 真实进程 argv 含 `--permission-mode default --permission-prompt-tool mcp__aih__approve
  --mcp-config {AIH_APPROVAL_URL, AIH_RUN_ID=<canonical runId>}`。
- 审批往返（真 HTTP，与 MCP 工具同路径）：ingress POST → `interaction.requested` 落库
  （kind=approval、presentation+choices）→ `approval.decide` → 长挂响应返回
  `{behavior:'allow', updatedInput}` / `{behavior:'deny', message:'…「拒绝」'}`；
  事件序列 `interaction.requested → interaction.updated → interaction.resolved`，无残留挂起。

**新发现（阻塞 opencode confirm 的真因，非本次引入）：** 安装的 opencode 已是 **v2.0.29**，
`opencode serve` 把 API 整体搬到 `/api/*` + HTTP Basic（用户 `opencode`，密码启动时打印在日志），
事件体 `{id,type,data}`、响应统一 `{data}` 信封、prompt 体用 `text`（不是 v1 的 `parts[]`）。
legacy 的 serve client/runner 是 v1 布局 → 旧行为是**空转 25s「就绪超时」**（legacy confirm 同样受影响）。
现在改为布局探测：约 4s 内报 `opencode_serve_api_layout_unsupported`（含实际版本）。
**下一步**：给布局表的 v2 行补 adapter（路由表已实测确认：
`GET /api/info`（就绪）、`POST /api/session`、`POST /api/session/:id/prompt`、
`POST /api/session/:id/permission/:rid/reply`、`GET /api/event`），届时 opencode confirm 在
canonical 与 legacy 同时恢复。

- 条件 1–5 **全部未满足**（1、2 无实现；3 硬编码；4 缺 slash/terminal；5 不存在）。
- 因此：**legacy 保留**。它仍在承载 work 模式下 12+ provider 的项目会话，删除会直接打断这些会话。
- 已完成的替换部分：chat 模式全 provider（codex harness + aih 网关，含 aih-server 网关目标与同 provider 换账号重绑）。

## 5. 建议的推进顺序（每步独立可验证）

1. 条件 1（原生驱动适配层，复用现有引擎，不改行为）→ 条件 2（能力派生注册）。
2. 条件 3（web 同源注册表）+ 条件 5（守卫检查，先红后绿）。
3. 条件 4（slash/terminal 对齐；能补则补，补不了就在能力快照里显式标 `unsupported` 并让 UI 可见）。
4. 全绿后先做一次灰度（work 会话在 canonical 下真机跑各 provider 一轮），再删 legacy surface。

## 6. Current-main audit rerun (2026-10-29)

The current `main` checkout reran `node scripts/chat-legacy-readiness.js`. The
canonical server driver registry contains all 15 native-session providers, but
the Web canonical surface registers only `codex`; 13 providers still fall back
to the legacy surface. The canonical Web surface also rejects API-key accounts
that the legacy surface accepts. Confirm/plan approval transport is declared
only for Claude and OpenCode; ten providers fail closed as undeclared and Grok
is declared but not wired. The command therefore still exits with the conclusion
that legacy is required.

An attempted real Codex runtime smoke (`node scripts/chat-runtime-real-codex-smoke.js
--skip-interaction`) stopped before launching a session with
`codex_oauth_projection_not_found` on this host. It provides no live Chat
acceptance evidence; a fresh readable Codex projection and a rerun of the real
smoke are required before claiming browser/native Chat completion. The next
implementation gate remains the Web provider registry and approval capability
coverage, followed by a real Web and native stop/reconnect/duplicate-suppression
run.
