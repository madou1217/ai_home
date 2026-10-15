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

- 条件 1–5 **全部未满足**（1、2 无实现；3 硬编码；4 缺 slash/terminal；5 不存在）。
- 因此：**legacy 保留**。它仍在承载 work 模式下 12+ provider 的项目会话，删除会直接打断这些会话。
- 已完成的替换部分：chat 模式全 provider（codex harness + aih 网关，含 aih-server 网关目标与同 provider 换账号重绑）。

## 5. 建议的推进顺序（每步独立可验证）

1. 条件 1（原生驱动适配层，复用现有引擎，不改行为）→ 条件 2（能力派生注册）。
2. 条件 3（web 同源注册表）+ 条件 5（守卫检查，先红后绿）。
3. 条件 4（slash/terminal 对齐；能补则补，补不了就在能力快照里显式标 `unsupported` 并让 UI 可见）。
4. 全绿后先做一次灰度（work 会话在 canonical 下真机跑各 provider 一轮），再删 legacy surface。
