# AIH Web Design System（单一真相源）

本目录下所有页面必须遵守以下规则。任何新页面、重构、补丁都不得绕过。

## 组件契约

### 页面脚手架：`PageScaffold`（`src/components/ui/PageScaffold.tsx`）
- 唯一的 `PageContainer` 包装：**禁止直接使用 `PageContainer`**。
- 必填：`title`。
- 可选：`subTitle`（一句话说明）、`extra`（右上角 action）、`headerContent`（紧凑 Descriptions 健康条）、`children`。
- 列表上方**禁止堆叠平铺的 `Statistic` 卡片**；统计/健康信息一律收敛进 `headerContent` 的 Descriptions 条。
- 页面 padding 固定 **24px**（见 `src/styles/unified.css`），**禁止各页自定义 padding**。

### 卡片：`SectionCard`（`src/components/ui/SectionCard.tsx`）
- 唯一的 `ProCard` 包装：**禁止直接使用 `ProCard`**。
- 默认 `bordered`、`headerBordered`，padding **16px**，圆角 12px。
- `extra` 只放右上角；与 `PageScaffold.extra` 的“右侧 action”语义保持一致。
- 需要并排成组时用 `gutter`，禁止散点 `ProCard colSpan` 拼接 stat 条。

### 列表：`ListTable`（`src/components/ui/ListTable.tsx`）
- 唯一的列表渲染：**禁止直接使用 `ProTable` / `Table`**。
- FIXED 默认（组件内写死，不允许各页再覆盖）：
  - `search = false`
  - `options = false`
  - `pagination = { pageSize: 12, showSizeChanger: true, showQuickJumper: true }`
  - 行 hover 走 `unified.css` 的统一浅色
  - 空态统一 `Empty.PRESENTED_IMAGE_SIMPLE` + 文案 **“暂无数据”**

### 样式令牌：`src/styles/unified.css`
- 定义 `--unified-page-padding`(24)、`--unified-card-padding`(16)、`--unified-card-border-radius`(12)、`--unified-pagination-margin`(12)、`--unified-section-gap`(16)。
- 应用目标：`.ant-pro-page-container-content`、`.ant-pro-card`、`.ant-pagination`、`.unified-empty`。
- **禁止**任何 CSS 覆盖 `ant-table` 单元格背景与 `ant-layout` 的 `min-height`。

### Tab / 工具栏
- 列表上方需要切换时统一用 `toolbar.menu type="tab"`（ProTable toolbar 内建 tab 模式），禁止各页自写 `Tabs` 套在表格外面后再叠 `SectionCard`。

## 反模式（一律拒绝评审/合入）
- 直接 `<PageContainer>` / `<ProCard>` / `<ProTable>` / `<Table>`。
- 列表上方平铺 `Statistic` 卡片（应进 `headerContent` Descriptions 条）。
- 各页自写 `padding` / `margin` 做布局（应走令牌）。
- 自定义行 hover、自定义空态文案/图。
- `Tabs` 包裹表格做切换（应走 `toolbar.menu type="tab"`）。
- 任何覆盖 `ant-table td background` 或 `ant-layout min-height` 的样式。

## 迁移顺序（迁一页、测一页）
Accounts → Models → ModelUsage → ModelAliases → Settings/SshHostsPanel → FabricNodes → FabricServerSetup → FabricWebrtcLab → Dashboard → Chat。
## 页面改造进度

> 状态：✅ 已改造（统一脚手架）/ 🟡 部分改造（缺统一外壳或未挂路由）/ 🔁 复用子组件（无独立脚手架）/ ⬜ 未改造。
> 依据：`config/routes.ts` 路由挂载 + 各页 `PageScaffold / PageHero / SectionCard / ListTable` 引用情况。

| 页面 | 路由 / 文件 | 状态 | 说明 |
| --- | --- | --- | --- |
| 仪表盘 | `/dashboard` · `Dashboard.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard` + `ListTable`，已引 `unified.css`。 |
| 账号池管理 | `/accounts` · `Accounts.tsx` | ✅ 已改造 | `PageScaffold` + `ListTable`，外层 24px 内距走令牌。 |
| 模型目录 | `/models` · `Models.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard`，工具栏用 `AppButton`/`DataToolbar`。 |
| 模型用量 | `/usage` · `ModelUsage.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard` + `ListTable`。 |
| 模型别名 | (`ModelAliases.tsx`，未挂独立路由) | 🟡 部分改造 | 仅用 `SectionCard` + `ListTable`，缺 `PageScaffold` 外壳，且 `routes.ts` 无入口（当前由 `Settings` 别名 tab 承载）。 |
| SSH 开发机 | `/fabric/ssh-hosts` · `FabricSshHosts.tsx` | 🔁 复用子组件 | 该页直接渲染 `<Settings section="ssh-hosts" />`，无独立脚手架；改造状态随 `Settings`。 |
| 节点健康 | `/fabric/nodes` · `FabricNodes.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard` + `ListTable`。 |
| 服务端设置 | `/server-setup` · `FabricServerSetup.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard` + `ListTable`（隐藏入口页）。 |
| WebRTC 实验室 | `/fabric/webrtc-lab` · `FabricWebrtcLab.tsx` | ✅ 已改造 | `PageScaffold` + `SectionCard`。 |

### 注释
- `Settings.tsx` 当前走 `PageHero` 而非 `PageScaffold`（"服务端设置" tab 页），与 `SSH 开发机` 共享同一外壳，故两者未单列 `PageScaffold` 已改造标记。
- `ModelAliases` 模型别名逻辑已迁到 `SectionCard` + `ListTable`，但作为独立路由页缺失，仍记为 🟡。
- 构建：`cd web && npm run build` 通过，`webpack compiled successfully`，退出码 0。
