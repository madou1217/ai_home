# AIH Web Design System（组件契约）

> 视觉方向与 token 的唯一来源是 [`web/DESIGN.md`](./DESIGN.md)（Cyber HUD）。本文只约束组件用法。

适用于 `src/pages` 下的标准管理列表 / 详情页（Dashboard、Accounts、Models、ModelUsage、ServerSetup 等）。会话工作区（Chat / QuickChat）与沉浸式页（StudioImage / Translation / Clipboard）自带布局，不走 `PageScaffold`；Settings 页本身用 `PageScaffold`，其各个 tab 内容不再单独套。上述页面仍需遵守 InlineNote、原生弹窗与硬编码色禁令。

## 组件契约

### 页面脚手架：`PageScaffold`（`src/components/ui/PageScaffold.tsx`）
- 唯一的 `PageContainer` 包装：**禁止直接使用 `PageContainer`**。
- 必填：`title`。
- 可选：`subTitle`（一句话说明）、`extra`（右上角 action）、`headerContent`（紧凑 Descriptions 健康条）、`children`。
- 列表上方**禁止堆叠平铺的 `Statistic` 卡片**。轻量摘要放进 `headerContent` 的 Descriptions 条；多格指标概览用下面的 `.hos-kpi-strip`，两者不要同时出现在同一列表上方。
- 页面 padding 固定：桌面 **24px** / 移动 **16px**（见 `src/styles/unified.css`），**禁止各页自定义 padding**。

### 卡片：`SectionCard`（`src/components/ui/SectionCard.tsx`）
- 唯一的 `ProCard` 包装：**禁止直接使用 `ProCard`**。
- 默认 `bordered`、`headerBordered`，padding **16px**；HUD 切角面板 + 左上 / 右下青色角标（`styles/hud.css`），标题 Orbitron 青色。
- `extra` 只放右上角；与 `PageScaffold.extra` 的“右侧 action”语义保持一致。
- 需要并排成组时用 `gutter`，禁止散点 `ProCard colSpan` 拼接 stat 条。

### 列表：`ListTable`（`src/components/ui/ListTable.tsx`）
- 唯一的列表渲染：**禁止直接使用 `ProTable` / `Table`**。
- FIXED 默认（组件内写死，不允许各页再覆盖）：
  - `search = false`
  - `options = false`
  - `pagination = { pageSize: 12, showSizeChanger: true, showQuickJumper: true }`
  - 行 hover 走 `--color-overlay-subtle`（深 / 浅主题各自 3% 叠加），不自定义行底色
  - 空态统一 `Empty.PRESENTED_IMAGE_SIMPLE` + 文案 **“暂无数据”**

### 其它公共件
- `AppButton`（`src/components/ui/AppButton.tsx`）：提交类操作默认 720ms 防连点，展开 / 收起 / 切换必须传 `disableDebounce`。
- `DataToolbar`（`src/components/ui/DataToolbar.tsx`）：列表工具栏容器。
- `Reveal`（`src/components/ui/Reveal.tsx`）：可打断的展开 / 收起（`grid-template-rows` 0fr↔1fr）。

### 布局封装令牌：`src/styles/unified.css`
- 定义 `--unified-page-padding`(24px；≤767px 由 `.unified-page-wrapper` 覆写为 16px)、`--unified-card-padding`(16px)、`--unified-card-border-radius`(0，轮廓由切角表达)、`--unified-pagination-margin`(16px)、`--unified-section-gap`(16px)。
- 这些是布局封装量，视觉 token 仍以 `src/styles/design-tokens.css` 为唯一来源。
- 应用目标：`.ant-pro-page-container-content`、`.ant-pro-card`、`.ant-pagination`、`.unified-empty`。
- **禁止**任何 CSS 覆盖 `ant-table` 单元格背景与 `ant-layout` 的 `min-height`。

### Tab / 工具栏
- 列表上方需要切换时统一用 `toolbar.menu type="tab"`（ProTable toolbar 内建 tab 模式），禁止各页自写 `Tabs` 套在表格外面后再叠 `SectionCard`。

### 行内提示：`InlineNote`（`src/components/ui/InlineNote.tsx`）
- 取代作为页面内容的 antd `Alert` 整块提示（AGENTS.md「UI Visual Constraints」）。
- 结构：状态图标 + 13px 文字，可选描述与操作；**只有图标带状态色**，不做整块彩底。
- 语义：`warning` / `error` 使用 `role="alert"`，其余 `role="note"`。

### KPI 条：`kpi-strip.css`（`src/components/ui/kpi-strip.css`）
- 给 `StatisticCard.Group` 加 `.hos-kpi-strip`：单个描边容器 + 1px 发丝线分隔；数值用 `hud-display`（等宽、tabular-nums，字号 20–24），标签用 `hud-label`（10px、大写、字距 `--tracking-caps`）。字号以 `DESIGN.md` §3 为准，此处不重复。
- 仪表盘 `ServiceWidgetGrid`、账号页统计条遵循同一外观。

## 反模式（一律拒绝评审/合入）
- 页面级列表直接 `<PageContainer>` / `<ProCard>` / `<ProTable>` / `<Table>`。例外：弹窗、抽屉、面板内**无分页的只读小表**可用 antd `Table`（`pagination={false}`）；一旦需要分页或搜索就改用 `ListTable`。
- 列表上方平铺 `Statistic` 卡片（应进 `headerContent` Descriptions 条或 KPI 条）。
- 页面内容里的整块 `Alert`（应改用 `InlineNote`）；左侧粗彩色竖条；浏览器原生 `alert` / `confirm` / `prompt`（应改用 `utils/confirm-action`；antd `Modal.confirm` 允许，优先 `confirmAction`）；界面上的演示 / 虚构数据。
- 各页自写 `padding` / `margin` 做布局（应走令牌）。
- 自定义行 hover、自定义空态文案/图。
- `Tabs` 包裹表格做切换（应走 `toolbar.menu type="tab"`）。
- 任何覆盖 `ant-table td background` 或 `ant-layout min-height` 的样式。

## 迁移顺序（迁一页、测一页）
Accounts → Models → ModelUsage → ModelAliases → Settings/SshHostsPanel → ServerSetup → Dashboard → Chat。
## 页面改造进度

> 状态：✅ 已改造（统一脚手架）/ 🟡 部分改造（缺统一外壳或未挂路由）/ 🔁 复用子组件（无独立脚手架）/ ⬜ 未改造。
> 依据：`config/routes.ts` 路由挂载 + 各页 `PageScaffold / SectionCard / ListTable` 引用情况。

| 页面 | 路由 / 文件 | 状态 | 说明 |
| --- | --- | --- | --- |
| 仪表盘 | `/dashboard` · `Dashboard.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard` + `ListTable`，已引 `unified.css`。 |
| 账号池管理 | `/accounts` · `Accounts.tsx` | ✅ 已改造 | `PageScaffold` + `ListTable`，外层 24px 内距走令牌。 |
| 模型目录 | `/models` · `Models.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard`，工具栏用 `AppButton`/`DataToolbar`。 |
| 模型用量 | `/usage` · `ModelUsage.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard` + `ListTable`。 |
| 模型别名 | (`ModelAliases.tsx`，未挂独立路由) | 🟡 部分改造 | 仅用 `SectionCard` + `ListTable`，缺 `PageScaffold` 外壳，且 `routes.ts` 无入口（当前由 `Settings` 别名 tab 承载）。 |
| Server 管理 | `/servers` · `Servers.tsx` | 🔁 复用子组件 | 该页渲染 `<Settings section="control-planes" />`。 |
| SSH 开发机 | `/ssh-hosts` · `SshHosts.tsx` | 🔁 复用子组件 | 该页渲染 `<Settings section="ssh-hosts" />`。 |
| 服务端设置 | `/server-setup` · `ServerSetup.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard` + `ListTable`（隐藏入口页）。 |
| 设置 | `/settings` · `Settings.tsx` | ✅ 已改造 | `PageScaffold` + 8 个 tab；`/servers`、`/ssh-hosts` 复用其 section。 |
| 会话 | `/chat` · `Chat.tsx` | 🔁 专用布局 | 三栏工作区（`ChatWorkspaceLayout`）+ iOS 导航栈，自带布局，不走 `PageScaffold`。 |

### 注释
- `Settings.tsx` 使用 `PageScaffold` 承载 8 个 tab（basic / capture / service / aliases / upstream-errors / failure-semantics / api-keys / concurrency）；`/servers` 与 `/ssh-hosts` 复用其中的 `control-planes` / `ssh-hosts` section，因此两者记为 🔁 复用子组件。原 `PageHero` 组件已移除。
- `ClientKeys` / `ConcurrencyLimits` / `FailureSemantics` / `UpstreamErrorMappings` 四个页面目前未挂路由（`config/routes.ts` 无入口），迁移前先决定删除或补路由。
- `ModelAliases` 模型别名逻辑已迁到 `SectionCard` + `ListTable`，但作为独立路由页缺失，仍记为 🟡。
