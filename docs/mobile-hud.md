# AI Home — Mobile HUD

On viewports narrower than 768px the WebUI runs as its own mobile interface. It is not a responsive version of the desktop layout. `web/src/mobile/MobileApp.tsx` resolves the current route through `mobile-routes.ts` and renders a dedicated mobile page from `web/src/mobile/pages/` inside the mobile HUD shell. The desktop page is never mounted.

**Rule 0 — no invented features.** Every mobile page takes its data from the same `services/api.ts` calls and hooks as the desktop page. Much of that logic has been moved out of the desktop pages into shared hooks under `features/*` and `components/control-plane/*`. The registry may only list real routes from `config/routes.ts`, and every real page must have a mobile page; `mobile-routes.test.ts` checks both.

## Shell and primitives
- **Top bar (`shell/MobileHudTopBar`):** `SYS // CODE` + title, a gateway LED and schedulable/total accounts (from the real `/management/status`), and SFX/CRT toggles, which share the `aih.hud` store with desktop. Hit targets are 44px, and the bar respects the safe area.
- **Bottom nav (`shell/MobileHudNav`):** thumb-zone tabs 仪表盘 · 账号 · 会话 · 用量 · 更多. The 更多 sheet holds 模型目录 · 开发工具 · 灵感工坊 · Server · SSH · 设置 and the NIGHT/DAY theme switch.
- **Immersive mode:** when `body[data-mobile-immersive]` is set (the chat conversation), the top bar and nav are hidden.
- **Primitives (`web/src/mobile/ui`):**
  - `MobilePage` / `MobileToolbar`
  - `HudSection`
  - `HudCard` — cut corners with scaled ticks
  - `TelemetryTile` / `TelemetryGrid` — large mono numbers, LEDs, slim tracks
  - `MonoList` + `SwipeRow` — swipe-left actions that stay keyboard-focusable
  - `DetailSheet` — tap-to-expand bottom drawer
  - `KeyValue`
  - `HudChips`
  - `HudField`
  - `HudIconButton` (44×44)
  - `EmptySignal`
- **Global overrides (`styles/mobile-hud.css`, applied under `html[data-mobile-hud]`):**
  - toasts slide up above the nav
  - modals are polygonal and bottom-anchored (never native alerts)
  - inputs are at least 16px (no iOS zoom), controls at least 44px
  - the CRT overlay uses OLED-friendly black scanlines

## Pages
## /dashboard — 仪表盘 (`MobileDashboard`)

**Mobile page summary.** The live gateway dashboard for phones. It runs on the shared hook `useGatewayDashboard` (`features/dashboard/use-gateway-dashboard.ts`), which is taken unchanged from `pages/Dashboard.tsx`; the desktop page now uses it too. Data comes from:

- `managementAPI.watch` (SSE snapshots). After 2.5s, or on error, it falls back to `managementAPI.status()` / `metrics()` / `accounts()`.
- `managementAPI.requestSnapshot` for refresh (with a 2s fallback)
- `managementAPI.clearCooldown`
- `accountsAPI.list` for the healthy-account count (`countHealthyAccounts`)

Actions: 清空冷却, 刷新, copy error details, and open the session or project behind an error (`/chat?projectPath&sessionId`).

**Component tree**
```
MobileDashboard
└─ MobilePage
   ├─ MobileToolbar  start: LED + LIVE/SYNC/POLL (real watch state) + health label
   │                 end: HudIconButton 清空冷却 (confirmAction) · HudIconButton 刷新 (primary)
   ├─ MobileBoot "SYNC" (first load) | inline error "加载管理面板失败：…" + 重试
   ├─ TelemetryGrid
   │  ├─ 请求成功率 (wide: successRate / totalRequests / timeoutRate)
   │  ├─ 健康账号 healthy/total + track · 冷却摘除 (cooldownAccounts)
   │  ├─ 总请求吞吐 (metrics) · 并发运行中 (Σ queue.running)
   │  └─ 运行时间 (uptimeSec, ticking) · 调度策略 (strategy / providerMode)
   ├─ HudSection Provider 运行状态 › MonoList › SwipeRow (tap) per provider
   │  └─ 显示/收起未接入账号的 Provider (N)
   ├─ HudSection 最近错误 › MonoList › SwipeRow [复制 | 会话] (tap)
   ├─ HudSection 热点路由 › HudCard › route rows + track
   ├─ HudCard 服务运行参数 (tap)
   ├─ ProviderStatusSheet (DetailSheet + KeyValue, live)
   ├─ RecentErrorSheet (DetailSheet + KeyValue; footer 复制错误详情 · 打开会话/打开项目)
   └─ DetailSheet 服务运行参数 (buildRuntimeParams)
```

**Source:**
- `web/src/mobile/pages/MobileDashboard.tsx` (+ `.module.css`)
- `web/src/mobile/pages/dashboard/{ProviderStatusSheet,RecentErrorSheet}.tsx`
- `web/src/mobile/pages/dashboard/dashboard-tones.ts`
- shared: `web/src/features/dashboard/{use-gateway-dashboard,dashboard-presentation}.ts`

**Mobile UX notes (based on real code)**
- **Thumb zone:** actions are 44px toolbar buttons, and 刷新 is the only primary one. Rows are at least 60px, and sheet footer buttons are at least 44px.
- **Tap to expand, providers:** the provider sheet shows available accounts with a track, queue running/queued, max concurrency, requests, ✓ and ✗ counts, and runtime-status counts from `getRuntimeStatusMeta`. It updates live while open.
- **Tap to expand, errors:** the error sheet shows the full error text, time, account, source→target chain, requested→effective model alias, project, session and route. The `/v1/chat/completions` route is hidden, as on desktop. The sheet content is frozen when it opens, so a new snapshot can't reorder it underneath the user.
- **Swipe actions on error rows:** 复制 and 会话. The same actions are in the sheet footer.
- **Confirmation on 清空冷却:** mobile only. The desktop page has no confirmation. On mobile, the danger confirmation guards against accidental taps; the API call and toasts are identical.
- **No provider filter link:** the page does not link to a provider-filtered `/accounts`, because the Accounts route only deep-links with `?provider&accountRef`.
- **Layout choices:** providers with zero accounts fold behind an expander, and the desktop hero and KPI widgets are merged into the tiles.
## /accounts — 账号管理: providers, accounts and credentials (`MobileAccounts`)

**Mobile page summary.** Providers, accounts and credentials are one real domain in this codebase, so they share one page. Data sources are the same as desktop:

- `useAccountsSnapshot` (`accountsAPI.list` + `watch`)
- `useModelCatalog`
- `useTokenDropEvents`
- `useAccountAppEntries` (`accountsAPI.listAppEntries` polling)
- `useAccountActivity` (`managementAPI.metrics`)

Every action goes through the shared `useAccountActions`, which holds the handlers moved out of `Accounts.tsx`. The actions are:

- add (OAuth / API key), auth progress, reauth, edit credentials
- import, export
- enable switch, default account, Codex App account
- refresh usage, delete
- open Desktop / CLI (install flow + terminal picker)
- Kimi QR login, Codex reset credits, quota reset history, egress settings
- model refresh and model management

**Component tree**
```
MobilePage
├─ MobileToolbar: [刷新] … [导出] [导入] [添加账号 (primary)]
├─ TelemetryGrid: 正常可用 h/t (track) · 账号状态 · 待处理问题 · 耗尽/停用
├─ HudCard IMPORT (only while an import job runs)
├─ HudSection PROV: HudChips provider families (real counts) · HudChips status filter
├─ HudSection POOL › MonoList › SwipeRow › AccountRowContent
│     (activity icon, masked label, provider·plan·默认·APP·DESKTOP, status LED, remaining % + track)
│     swipe: 终端 / 编辑 | 重新登录 / 删除 · MobileBoot · EmptySignal
├─ AccountDetailSheet: status + reasons + 调度 Switch · KeyValue identity (+copy) … · QUOTA · TOKENS · MODELS · OPS; footer = swipe actions
├─ ExportAccountsSheet (the real export actions)
├─ AccountFlowModals (shared business modals: add / auth progress / edit / import / CLI picker / Kimi / reset credits / history)
└─ AccountEgressModal
```

**Source:**
- `web/src/mobile/pages/MobileAccounts.tsx` (+ `.module.css`)
- `web/src/mobile/pages/accounts/{AccountRowContent,AccountDetailSheet,ExportAccountsSheet}.tsx`
- `web/src/mobile/pages/accounts/account-tones.ts`
- shared: `web/src/features/accounts/{use-account-actions,use-account-app-entries,use-account-activity,account-view-model}.ts`
- shared: `web/src/features/accounts/AccountFlowModals.tsx`

**Mobile UX notes (based on real code)**
- **Swipe actions:**
  - 终端 appears only when the host reports CLI support, and it's blocked when the account isn't configured.
  - Next comes 编辑 for API-key accounts, or the real reauth label for OAuth accounts (重新登录 / 继续授权 / 重新授权).
  - Last is 删除.
  - The sheet footer repeats the same set.
- **Reauth-required accounts:** only 重新登录 is offered, and the switch and model actions are disabled, as on desktop.
- **Identifiers:** masked exactly as desktop (`getAccountPrimaryLabel` / `getAccountSecondaryLabel`). Copy appears only where `canCopyAccountEmail` allows it.
- **Modals over the sheet:** any action that opens a modal closes the sheet first.
- **Deep link:** `?provider=&accountRef=` selects the family, scrolls to the row and opens its sheet.
- **Omitted:** the card/list view toggle, table sorting, and the CLI double-click shortcut.

## /accounts/:provider/:accountRef/models — 账号模型 (`MobileAccountModels`)

**Mobile page summary.** Per-account model management through `useAccountModels`:

- `modelsAPI.listOpenAICompatible({ accountRef })`
- `watchOpenAICompatibleRefresh`, filtered to this account's probe jobs
- `refreshOpenAICompatible`
- `updateModel` (enable/disable, default)
- `createManualModel`

The messages and guards match desktop.

**Component tree**
```
MobilePage
├─ MobileToolbar: [返回账号] … [添加模型] [刷新模型 (primary)]
├─ HudCard account header (ProviderIcon, title, 缓存/实时 LED, 更新时间)
├─ TelemetryGrid: 账号模型 · 启用模型 · 手动补充 · 刷新状态 (live LED)
├─ job error | HudCard PROBE (HTTP code, message, 提交上游 issue, 复制原始错误)
├─ HudSection MODELS: search · OpenCode group chips (opencode only) · status chips
│  └─ MonoList › SwipeRow (swipe: 设默认 / 复制; inline enable Switch)
├─ AccountModelSheet (KeyValue; footer 启用/停用 · 设为默认 · 复制 ID)
└─ AccountManualModelSheet (account fixed; 模型 ID, 备注, 默认启用)
```

**Source:**
- `web/src/mobile/pages/MobileAccountModels.tsx`
- `web/src/mobile/pages/accounts/{AccountModelSheet,AccountManualModelSheet}.tsx`
- shared: `web/src/features/models/{account-models,use-account-models}.ts`

**Mobile UX notes (based on real code)**
- **Inline switch:** it doesn't trigger a swipe or open the sheet.
- **Guards (same as desktop):** set-default only works on an enabled, non-default model ("请先启用模型", "每个账号保留一个默认模型…").
- **Invalid route params:** an EmptySignal with a back button.
- **Omitted:** pagination.

**Desktop fixes that came out of the refactor**
- Folder/file import on desktop now works. Before, the hidden file inputs were never rendered.
- A `?provider=qodercn` deep link now maps to the provider family instead of crashing the stats lookup.
## /chat — AI 会话 (`MobileChat`)

**Mobile page summary.** A two-screen page: a session list, and a full-screen conversation that hides the shell's top bar and bottom nav. The page state and handlers that used to live inside desktop `Chat.tsx` are now in the shared hook `useChatPageState` (`pages/chat-page-state.tsx`), and desktop and mobile both use it:

- **Catalogues and restore:** project catalogue, session directory and restore, chat-session restore, deep link.
- **Pickers and dialogs:** account catalogue, model and approval-mode pickers, project dialogs.
- **Handlers:** create, select, remove and mode-switch.

The list uses the same calls and messages as desktop:

- `sessionsAPI.getChatSessions`
- `deleteChatSession`
- `archiveSession`
- `removeProject`
- `getArchivedSessions`
- `unarchiveSession`
- the session-lifecycle capabilities
- the existing pin storage and its cross-tab sync event

**Component tree**
```
MobileChat
├─ ChatSessionList (hidden while a conversation is open)
│  └─ MobilePage
│     ├─ HudChips  CHAT · 纯聊天 / WORK · 工作区
│     ├─ MobileToolbar  counts (running = green) · [WORK] 已归档 · 打开项目 · 刷新
│     ├─ [WORK, directory sync failed] inline warning + 重试
│     ├─ HudSection
│     │  ├─ CHAT: MonoList › SwipeRow per chat session   (swipe: 置顶/取消置顶 · 删除)
│     │  └─ WORK: MonoList › SwipeRow per project        (swipe: 移除; tap = expand)
│     │       └─ SwipeRow per session (swipe: 归档 when available) · 展开更多/收起
│     │  (MobileBoot loading · EmptySignal empty · inline error + retry)
│     └─ sticky thumb dock: primary 发起新对话 / 新建工作区会话
├─ ChatConversationScreen (fixed full screen, immersive, edge-swipe back)
│  ├─ header: back · mono title · LED + provider icon/label + model · search · more
│  ├─ ChatConversationContent (shared with desktop, mobile=true)
│  │  └─ ChatRuntimeBoundary › CanonicalChatRuntime (safe-area frame) | LegacyChatRuntime | ChatEmptyState
│  │     (WORK: wrapped in ProjectWorkbench — files / terminal / review tabs)
│  └─ DetailSheet SESSION: KeyValue (state, mode, provider, model, account, project, updated, session ID, archive reason)
│       + 置顶/取消置顶 · 删除对话 (chat) | 原生归档 (work); footer primary 新建会话
├─ ArchivedSessionsSheet (DetailSheet ARCHIVE: MonoList › SwipeRow + inline 还原; footer 刷新)
└─ existing OpenProjectDialog + DirectoryPickerDialog
```

**Source:**
- `web/src/mobile/pages/MobileChat.tsx`
- `web/src/mobile/pages/chat/{ChatSessionList,ChatConversationScreen,ArchivedSessionsSheet}.tsx`
- `web/src/mobile/pages/chat/use-mobile-chat-sessions.ts`
- `web/src/mobile/pages/chat/mobile-chat.module.css`
- shared: `web/src/pages/chat-page-state.tsx`

**Mobile UX notes (based on real code)**
- **Primary action:** "new session" is the list's only primary button. It sits in the thumb dock above the nav and is disabled in WORK mode until a project is picked, as on desktop, with a hint line. Every target is at least 44px.
- **Actions without swiping:**
  - Delete, pin and archive are repeated in the conversation's detail sheet.
  - Restore is an inline button on each archived row.
  - Remove project is swipe only, because project rows have no sheet.
- **Guards (same as desktop):**
  - Destructive actions use `confirmAction` with the desktop wording (归档此会话？ / 删除该对话？ / 移除此项目？ / 还原此会话？).
  - Archive is disabled while a session is running or when the provider can't archive; the sheet shows the reason.
  - Deleting the open chat session starts a new one.
  - The account-missing and account-load-failed messages are unchanged.
- **Conversation screen:** it uses the existing immersive-mode hook. It stays mounted, hidden and inert, when you go back, so a running session is never interrupted. Edge-swipe back uses the existing `useMobileChatNavigation`, and the deep link opens the conversation directly.
- **Omitted:** the command palette and shortcut modal are keyboard-only, and the shell covers their navigation. The desktop session-preview fetch is not used; rows show `session.model` or the provider label.
## /usage — 模型用量 (`MobileUsage`)

**Mobile page summary.** Model usage statistics for phones. It runs on the new hook `useModelUsageDashboard` (`features/model-usage/use-model-usage-dashboard.ts`), which has the same state machine and calls as desktop ModelUsage. Data comes from:

- `modelUsageAPI.startDashboardQuery` / `watchDashboardQueries` / `cancelDashboardQuery`. These load progressively and keep the last snapshot while filters change.
- `modelUsageAPI.scan` + `watchScan`, with a quiet refresh when a scan finishes
- `modelUsageAPI.breakdown`, reusing the snapshot's end time
- `modelUsageAPI.requests` (loaded on demand, latest 80)
- `accountsAPI.list` for account names

Shared pure helpers live in `model-usage-query.ts`.

**Component tree**
```
MobileUsage
├─ MobilePage
│  ├─ MobileToolbar  start: LED SYNC/ERR/SCAN/READY + progress (已汇总 x/y) or range
│  │                 end: 刷新 · 扫描 (primary)
│  ├─ HudChips range (1 小时/今天/近 7 天/一个月/自定义)
│  │   └─ [自定义] 2× HudField + native datetime-local (开始/结束, guarded)
│  ├─ HudChips provider (全部 + every real provider, with icons)
│  ├─ HudField 模型 › antd Select (showSearch)
│  └─ body (dims and pauses taps while refreshing, like desktop)
│     ├─ [error, no snapshot] inline error + 重试
│     ├─ TelemetryGrid 总 Tokens · Input · Output · Cache · 缓存率 (track) · 估算成本
│     ├─ HudSection 时间趋势 › UsageTrendStrip (Tokens/成本/缓存率 chips + bar strip, scrub/arrow-key readout)
│     ├─ HudSection 用量排行 › HudChips 按模型/按会话
│     │   └─ MonoList › SwipeRow (tap → breakdown; session rows swipe 复制 ID) | Spin | EmptySignal (+扫描)
│     └─ UsageRequestDetails › HudSection 请求明细
│         ├─ not loaded: HudCard + 加载最近 80 条
│         └─ loaded: 刷新明细 · HudChips 用量明细/错误请求 · MonoList › SwipeRow (tap) · DetailSheet KeyValue
└─ UsageBreakdownSheet (DetailSheet: session id/cwd, summary, HudChips 账号分量/模型分量, rows; footer 复制会话 ID)
```

**Source:**
- `web/src/mobile/pages/MobileUsage.tsx` (+ `.module.css`)
- `web/src/mobile/pages/usage/{UsageTrendStrip,UsageBreakdownSheet,UsageRequestDetails}.tsx`
- shared: `web/src/features/model-usage/{use-model-usage-dashboard,model-usage-query}.ts`

**Mobile UX notes (based on real code)**
- **Filters:** they sit above the data as horizontal chips. The model filter is the only Select.
- **Custom range:** it uses the phone's native `datetime-local` picker, because antd's RangePicker is about 560px wide. It applies the same guards as desktop's `disabledDate`: the start can't be after the end, and the end can't be after today. It calls the same `handleRangeChange`.
- **Trend:** a slim CSS bar strip drawn from the same `trend` slots (`buildTrendSlots`) with the same three views. The desktop ECharts components carry desktop headings and controls, so they're not reused, and no chart library loads on mobile.
- **Tap to expand:** model and session rows open the breakdown sheet. Request rows open every field in `REQUEST_DETAIL_COLUMN_CONTRACTS`, with tokens split into one row per part.
- **Guards (same as desktop):** breakdown is ignored while loading; request details load only on demand.
- **Omitted:** the model-mix chart. The sorted, tappable by-model list covers the same data.
## /models — 模型目录 (`MobileModels`)

**Mobile page summary.** The global model catalog. Data comes from `useModelCatalogPage`:

- `modelsAPI.listOpenAICompatible`
- `watchOpenAICompatibleRefresh`
- `createManualModel`

Aggregation, filtering and counts come from the shared `features/models/model-catalog.ts`, which desktop `Models.tsx` now also uses. Actions:

- 刷新模型 (re-reads the cache, like desktop in global scope)
- 添加模型
- copy model ID
- filter by provider, account, status and search text
- the probe-error link and copy

**Component tree**
```
MobilePage (toolbar: LED 缓存/实时 · 更新时间 | 添加模型 | 刷新模型)
├─ TelemetryGrid: 账号模型 · 可见模型 · 手动补充 (wide)
├─ HudCard PROBE (only on probe error): HTTP code, message, [提交上游 issue][原始错误]
├─ HudCard REFRESH (only when a job exists): LED + KeyValue 探测范围/可见模型/探测账号 + error
├─ HudSection 模型目录
│  ├─ 端点 · search Input · HudChips providers (counts) · Select account · HudChips 全部/启用/停用/手动
│  ├─ MonoList › SwipeRow (ProviderIcon, label/id, providers, LED VIS/HID, enabled/total, M{manual}; swipe 复制 ID)
│  └─ 加载更多 (steps of 40) | EmptySignal (暂无数据 + 添加模型 | LINK ERROR + 重试)
├─ ModelRowSheet (KeyValue of every desktop row field + account list → /accounts/:provider/:accountRef/models; footer 复制模型 ID)
└─ ManualModelSheet (provider grouped select (no-account providers disabled), 账号, 模型 ID, 备注, 默认启用; footer 取消 / 添加)
```

**Source:**
- `web/src/mobile/pages/MobileModels.tsx` (+ `.module.css`)
- `web/src/mobile/pages/models/{ModelRowSheet,ManualModelSheet}.tsx`
- shared: `web/src/features/models/{model-catalog,use-model-catalog-page}.ts`

**Mobile UX notes (based on real code)**
- **Row actions:** global catalog rows only offer copy ID, as on desktop. Enable/disable only exists on the per-account route, which each account in the sheet links to.
- **Toasts (same text as desktop):** 模型缓存已重新读取, 模型目录已刷新, 模型已添加, 没有可添加模型的账号, 请选择有效账号.
- **Paging:** incremental "加载更多" replaces the desktop pagination (14 per page).
- **URL filters:** `?provider=` and `?accountRef=` are honoured.
## /toolkit — 开发工具 (`MobileToolkit`)

**Mobile page summary.**
- **Navigation:** chips for the three real tabs (应用与集成 / 运行环境 / 网络), with a second chip row for each tab's real sub-panels. Defaults are the desktop ones.
- **Loading:** one panel is mounted at a time, as on desktop, so only its data loads.
- **Actions:** every panel makes the same `toolkitAPI` / `proxyPoolAPI` calls through shared hooks under `components/toolkit/use-*` and `proxy-pool/use-*`, which the desktop panels now use too. Actions also keep desktop's `Modal.confirm` + `AppActionConfirmContent` plan confirmations and task-queue tracking.

**Component tree**
```
MobilePage
├─ HudChips (sections) + HudChips (panels)
├─ AppsPanel: toolbar, TelemetryGrid, category chips, MonoList › SwipeRow (打开/安装/更新/卸载),
│            DetailSheet (KeyValue, 启用即时刷新, footer actions), account launcher sheet, KimiDesktopLoginModal
├─ TerminalsPanel: SwipeRow (唤起/安装/更新/卸载) + DetailSheet
├─ CliUpgradePanel: read-only tiles + list + DetailSheet
├─ ToolsPanel (session runtimes / network access): tiles + SwipeRow lifecycle + DetailSheet
├─ EnvironmentPanel: node/python chips, runtime tiles, SwipeRow lifecycle, DetailSheet, install-guide link
├─ MirrorsPanel: npm/pip chips, current config tile, SwipeRow (测速/写入), DetailSheet (KeyValue + GuidedCommand)
├─ ProxyPoolPanel: core status, network takeover, KPI tiles, action grid, filters,
│                  SwipeRow (实测/独立端口/删除) + DetailSheet, the existing proxy modals
└─ DiagnosticsPanel: observation tiles (tap → sheet), apply-source card, Git/npm manual cards, endpoint probe
```

**Source:**
- `web/src/mobile/pages/MobileToolkit.tsx` (+ `.module.css`)
- `web/src/mobile/pages/toolkit/*`

**Mobile UX notes (based on real code)**
- **Swipe actions:** offered only when the item's real state allows them. The same actions sit in each detail sheet footer.
- **Node delete:** uses `confirmAction` with the desktop Popconfirm text.
- **Proxy modals:** the existing ones are reused, with layout rules scoped to `html[data-mobile-hud]`.
- **Omitted:** the Monaco config editors, which aren't usable on touch. The managed-tool sheet says config editing is on desktop.

## /toolkit/install-guide — 安装指南 (`MobileInstallGuide`)

**Mobile page summary.** Uses the same `toolkitAPI.getEnvironmentGuide(platform)` load and task mapping as desktop. Two step chips (01 目标系统 and 02 工具链) sit above a tool list. Tapping a tool opens a sheet with the command generator.

**Component tree:** `MobilePage (返回开发工具, 重新读取) › HudChips ×2 › HudSection › MonoList › SwipeRow › DetailSheet › GuidedCommand`

**Source:**
- `web/src/mobile/pages/MobileInstallGuide.tsx`
- `web/src/mobile/pages/toolkit/GuidedCommand.tsx`
- shared: `components/toolkit/{guided-command,use-command-copy}.ts`

**Mobile UX notes:** the task select, parameter fields, mono command block and copy all use the same template, missing-parameter and copy logic as desktop. Copy stays disabled until every parameter is filled.

## /studio/image — 灵感工坊 (`MobileStudio`)

**Mobile page summary.** The page starts on a session list. Opening a session (`?session=`) switches to an immersive session view with its own header and safe areas. The view contains:
- the canvas and output picker
- the prompt and revised prompt
- canvas actions: 复用参数 / 复制提示词 / 下载原图 / 继续编辑
- a single-column revision gallery
- the prompt box and send button, pinned in the thumb zone

The 制作参数 sheet holds:
- the model list, with unavailable models disabled and their reason from `formatImageStudioModelAvailability`
- mode chips
- reference images and mask
- prompt templates
- capability-gated parameters

The page makes the same `imageStudioAPI` calls, with the same validation, messages and 6s polling.

**Component tree:**
- List: `MobilePage (ModelsReadout, 刷新, 新会话) › HudSection › MonoList › SwipeRow`
- View: `header › StudioCanvas + StudioRevisionGallery › StudioComposer (+ params DetailSheet) + DetailSheet (重命名 / 删除)`

**Source:**
- `web/src/mobile/pages/MobileStudio.tsx` (+ `.module.css`)
- `web/src/mobile/pages/studio/*`

**Mobile UX notes:**
- **Differences from desktop:** the page does not auto-create a session, and after a delete it returns to the list.
- **Omitted:** 在新窗口打开, because a new window makes no sense on a phone.
- **Logic copy:** `use-mobile-image-studio.ts` holds a separate copy of desktop's logic, because a contract test pins the desktop handlers inside `ImageStudioWorkspace.tsx`.
## /fabric/servers — Server 管理 (`MobileServers`)

**Mobile page summary.** Manages the saved AIH Servers (grouped by stableServerId) and the default Server. It uses the same services as the desktop Server section, through `useControlPlaneServers()`:

- **Loading and sync:** `listControlPlaneProfiles`, `buildServerRouteRows`, `summarizeControlPlaneProfiles`, `serverProfilesAPI.listEndpointHints`
- **Connect:** `connectControlPlaneProfile`, then `refreshControlPlaneDeviceState` and `selectActiveControlPlaneProfileSecure`
- **Maintenance:** `refreshControlPlaneProfileStates`, `removeControlPlaneProfileSecure`, `discoverServersOnLan` / `refreshNativeLanRoutes`

Actions: 添加 Server, 授权, 同步, 同步全部, 同步当前, 设为默认, 移除, 打开 (opens the server-scoped dashboard in a new tab), and 发现局域网 Server (native desktop runtime only).

**Component tree**
```
MobilePage (lead = desktop scope copy)
├─ MobileToolbar: count · [发现局域网 Server (native)] [同步全部] [添加 Server (primary)]
├─ HudCard DEFAULT「默认 Server」: LED · name · endpoint (mono) + COPY · lastError · [同步当前]
├─ TelemetryGrid: 服务器 · 可调度账号 · 会话 (wide)
├─ HudSection NODES › MonoList › SwipeRow (icon · name / endpoint / metrics · status + 默认)
│     swipe: 设为默认 / 同步 / 移除 (pending: 授权 / 移除) | EmptySignal + 添加 Server
├─ DetailSheet SERVER: KeyValue (状态, 授权, Management Key, 数据, Server ID, server=, 错误), 地址 + COPY,
│     routes (kind, endpoint, health, RTT), [打开][移除]; footer [同步][设为默认] | [移除][授权]
└─ DetailSheet ADD/AUTHORIZE: Server URL (+ endpoint-hint buttons / warnings) · 显示名称 · Management Key; footer 探测并保存 / 授权并连接
```

**Source:**
- `web/src/mobile/pages/MobileServers.tsx` (+ `.module.css`)
- shared: `web/src/components/control-plane/{use-control-plane-servers,server-list-presentation}.ts`

**Mobile UX notes (based on real code)**
- **Thumb zone:** the primary action is on the right of the toolbar, and each sheet's actions are in its footer. Every target is at least 44px.
- **Tap to expand:** routes, IDs, metrics and errors appear only in the detail sheet.
- **Swipe actions:** the same actions as the sheet footer. 设为默认 is disabled on the current default Server.
- **Guards (same as desktop):**
  - Desktop toasts and error texts.
  - 同步全部 is disabled when there is nothing to sync.
  - A Server without a key raises `missing_management_key`.
  - Profiles are marked degraded or offline on failure.
- **Mobile only:** 移除 asks for confirmation (`confirmAction`). On desktop it sits behind a dropdown, so a swipe needs its own second step.
- **Omitted:** the default-Server Select (per-row 设为默认 covers it) and `PublicServerEntryCard` (native-desktop FRP configuration).
## /fabric/ssh-hosts — SSH 开发机 (`MobileSshHosts`)

**Mobile page summary.** Manages SSH connections and project workspaces through `useSshHosts()` and `useSshDirectoryBrowser()`. It makes the same `sshHostsAPI` calls as the desktop `SshHostsPanel`:

- `listConnections` / `listWorkspaces`
- `create` / `update` / `deleteConnection`
- `create` / `update` / `deleteWorkspace`
- `testConnection` (diagnostics)
- `browseSshDirectory`

**Component tree**
```
MobilePage
├─ MobileToolbar: [刷新] [添加连接] [创建工作空间 (primary, disabled without connections)]
├─ HudChips: 远程连接 (n) / 项目工作空间 (n)
├─ HudSection SSH › MonoList › SwipeRow (label · user@host:port · auth + test-status LED)
│     swipe: 测试 / 编辑 / 删除 | EmptySignal + 添加连接
├─ HudSection WS › [filter hint + 清除筛选] › MonoList › SwipeRow (label · remoteRoot · connection LED / 连接已删除)
│     swipe: 编辑 / 移除 | EmptySignal + 创建工作空间
├─ DetailSheet SSH LINK: KeyValue (目标, 认证方式, 私钥路径) · SshDiagnostics · [查看工作区][创建工作区][删除]; footer [编辑][测试连接]
├─ DetailSheet WORKSPACE: KeyValue (远端路径, 关联连接, 目标); footer [移除][编辑]
├─ DetailSheet NEW/EDIT LINK: label, host, port, user, 认证方式 (2×2 radio), identityFile / privateKey / password
├─ DetailSheet NEW/EDIT WS: connection Select, label, remoteRoot (read-only) + [选择目录]
└─ SshDirectorySheet BROWSE: breadcrumbs, ".. 返回上级", directory rows, 当前选定路径; footer [取消][确认选择该路径]
```

**Source:**
- `web/src/mobile/pages/MobileSshHosts.tsx` (+ `.module.css`)
- `web/src/mobile/pages/fabric/{SshDiagnostics,SshDirectorySheet,FabricFormItem}.tsx`
- shared: `web/src/features/ssh-hosts/{ssh-hosts-model,use-ssh-hosts}.ts`

**Mobile UX notes (based on real code)**
- **Form rules (same as desktop, from one shared module):** validation, messages, secret masking (`******`) and defaults (port 22, agent auth).
- **Test connection:** as on desktop, testing opens diagnostics, which on mobile is the connection sheet. The row then shows the real result (REACHABLE, AUTH-REQUIRED, UNREACHABLE or TESTING) as an LED plus text.
- **Directory browser:** a phone has no double-click, so tapping a folder opens it and selects it. The empty-folder text says so: "没有子目录。可返回上级目录，或直接确认当前路径。"
- **Confirmations:** deletes use `confirmAction` with the desktop Popconfirm wording.
- **Refresh:** re-runs the same two list calls the desktop makes on load.
## /settings — 设置 (`MobileSettings`)

**Mobile page summary.** The same two sections as desktop: 基础设置 and 模型别名 (`?tab=aliases` opens aliases directly). Data sources:

- `configAPI.get` / `update` / `getServer` / `updateServer`
- `managementAPI.restart` / `watch`, through the shared `useManagementRestart`
- `rotateManagementKey`, through the shared `saveServerConfig`
- the control-plane selection services (the same ones `ControlPlaneProfileSelect` uses)
- `DynamicWallpaperEngine`, `useHudPreferences` and `applyThemeMode`, through the shared `useAppearanceSettings`
- `modelAliasesAPI.getAll` / `create` / `update` / `delete` / `toggle` and `modelsAPI.listCatalog`, through the shared `useModelAliases`

**Component tree**
```
MobilePage
├─ HudChips [基础设置 | 模型别名]
├─ BasicSettingsPanel (always mounted, so unsaved input survives switching)
│  ├─ HudSection AIH Server › HudCard CURRENT (LED + state, endpoint; tap → ServerPickerSheet | /fabric/servers) | HudCard 添加 Server
│  ├─ HudSection 开发工具与应用管理 › SettingRow 进入工具箱 → /toolkit
│  ├─ HudSection 外观个性化 › 选择图片 · 恢复默认 (custom only) · HUD 显示: CRT / SFX / 主题 switches
│  ├─ HudSection 账号调度 › Form (3× InputNumber, shared rules) + [重置 | 保存额度设置]
│  ├─ HudSection 服务配置 › note + Form (开放/本机, host, port, API Key, Management Key) + [一键重启服务 (confirm) | 保存服务配置]
│  └─ ServerPickerSheet (DetailSheet: profiles; footer 配置服务器)
└─ AliasesPanel
   ├─ MobileToolbar [重新读取缓存 | 添加别名]
   ├─ HudSection 模型别名 › MonoList › SwipeRow (alias → target, LED ON/OFF, P{priority}; swipe 编辑 / 启用·禁用 / 删除)
   ├─ DetailSheet (KeyValue 别名/目标模型/优先级/请求范围/目标供应商/备注/状态; footer 删除 / 启停 / 编辑)
   └─ AliasFormSheet (same fields, rules and help text as the desktop form; footer 取消 / 保存)
```

**Source:**
- `web/src/mobile/pages/MobileSettings.tsx` (+ `.module.css`)
- `web/src/mobile/pages/settings/{BasicSettingsPanel,AliasesPanel,AliasFormSheet,ServerPickerSheet,SettingRow}.tsx`
- `web/src/mobile/pages/settings/use-settings-servers.ts`
- shared: `web/src/features/settings/*`, `web/src/features/model-aliases/*`

**Mobile UX notes (based on real code)**
- **Layout:** setting rows are at least 56px, with the control on the right. Each form group's save action is at the bottom of its own card.
- **Guards (same as desktop):**
  - the same validation rules
  - "请先选择 Server" when a Management Key is entered without a Server
  - the 70s restart fallback timer
  - the alias delete confirm (Popconfirm on desktop → `confirmAction`)
  - the Go-preview guard hides the server switcher
  - server switching needs 2 or more profiles
- **Mobile only:** 一键重启服务 asks for confirmation first. Desktop has none; the guard stops a mis-tap from dropping the connection, and the API call is the same.
- **Server switcher:** a DetailSheet list instead of the desktop footer dropdown.
- **Out of scope:** `PublicServerEntryCard` renders only in the `/fabric/servers` section on desktop, so it isn't part of `/settings`.
## /server-setup — 连接 Server (`MobileServerSetup`)

**Mobile page summary.** The first-run gate. The shell hides the bottom nav on this route. It uses `useServerSetupProfiles()`, which the desktop `FabricServerSetup` now uses too:

- `syncSharedControlPlaneProfiles`
- `connectControlPlaneProfile`, `refreshControlPlaneDeviceState`, `selectActiveControlPlaneProfileSecure`
- `removeControlPlaneProfileSecure`
- `resolveRequiredServerSetupDialog` / `resolveServerSetupFormDefaults`

When a connection is required, the page is a full HUD boot screen with:

- the brand
- `SYS // SETUP` and the real dialog mode
- the intro text
- the same three fields, with the same validation and hints
- the submit button 连接并进入工作台

After the first successful save it goes to `/dashboard` (replace). Once servers exist, it shows the ready-Server counts and the saved-Server list instead.

**Component tree**
```
(setup required)
div.boot (grid background)
├─ brand: logo + AI_HOME / ACCOUNTS · GATEWAY
├─ LED · SYS // SETUP · INITIAL
├─ intro (initial mode)
├─ HudCard LINK「Server 凭据」› Server 网关地址 / 显示名称 / Management Key
└─ sticky full-width primary: 连接并进入工作台 | 授权并连接 | 探测并保存

(servers exist)
MobilePage
├─ MobileToolbar: [添加 Server] [进入工作台 (primary; only when the current Server is ready)]
├─ TelemetryGrid: 就绪 Server · 已保存配置
├─ HudSection SERVERS › MonoList › SwipeRow (name · endpoint · "N 可调度账号 · N 会话" · ready/degraded/offline + 当前)
│     swipe: 设为当前 / 同步 | 授权 / 移除; link 打开高级 Server 设置 → /fabric/servers
├─ DetailSheet SERVER: KeyValue + [移除]; footer [同步|授权][设为当前]
└─ DetailSheet SYS // SETUP · MODE: same form; footer submit
```

**Source:**
- `web/src/mobile/pages/MobileServerSetup.tsx` (+ `.module.css`)
- shared: `web/src/components/control-plane/use-server-setup-profiles.ts`

**Mobile UX notes (based on real code)**
- **Gate logic:** same as desktop (`effectiveDialog` / `setupModalRequired`). The endpoint field is disabled in authorize mode.
- **Form reset:** the form is rebuilt when its defaults change, matching the desktop resetting its fields each time the dialog opens.
- **Confirmation:** 移除 asks for confirmation.
- **Title:** the desktop page title is not repeated, because the top bar shows it.
