# AI Home Web — 设计规范（Design System）

> 唯一来源：[`src/styles/design-tokens.css`](src/styles/design-tokens.css)
> 任何组件 **禁止** 写死颜色 / 字号 / 间距 / 圆角 / 阴影，一律引用 token。

本规范用于约束整个控制台 UI，重点解决三件事：**视觉统一**、**会话里不同 provider / 不同事件的一致呈现**、**移动端规范化**。

---

## 1. 分层模型

```
Primitive  →  Semantic  →  Domain
原始刻度       语义别名      领域语义（provider / event）
--c-* --space-*  --color-*    --provider-*  --event-*
--text-* ...     --radius-*
```

- **新代码只用 Semantic / Domain 层**（`--color-text`、`--space-4`、`--provider-accent` 等）。
- Primitive 层（`--c-neutral-500`…）只在 token 文件内部组装语义，组件不直接引用。
- 旧的 `--app-*` 仅作兼容别名，**不要在新代码里使用**，迁移时替换成对应 `--color-*`。

---

## 2. 色系（Color）

### 角色色
| Token | 用途 |
|---|---|
| `--color-bg` / `--color-bg-elevated` | 页面底 / 抬升底 |
| `--color-surface` / `-raised` / `-muted` / `-soft` / `-sunken` | 卡片与分层表面 |
| `--color-border` / `-strong` / `-subtle` | 描边 |
| `--color-text` / `--color-heading` / `--color-muted` / `--color-faint` | 文本层级 |
| `--color-brand` / `-strong` / `-soft` | 品牌主色（近黑墨） |

### 状态色（前景 + `-soft` 底）
`--color-info` · `--color-success` · `--color-warning` · `--color-danger` · `--color-attention`

### Provider 强调色
| Provider | 强调色 | 弱底 |
|---|---|---|
| codex | `--provider-codex` (OpenAI 绿) | `--provider-codex-soft` |
| claude | `--provider-claude` (Anthropic 珊瑚) | `--provider-claude-soft` |
| gemini | `--provider-gemini` (Google 蓝) | `--provider-gemini-soft` |
| agy | `--provider-agy` (Antigravity 紫) | `--provider-agy-soft` |

> 会话容器通过 `data-provider="codex"` 设置 `--provider-accent` / `--provider-accent-soft`，
> 子组件统一引用这两个变量即可自动适配当前 provider，无需各自判断。

### 事件语义色
工具 `--event-tool`、思考 `--event-thinking`、计划 `--event-plan`、目标 `--event-goal`、
记忆 `--event-memory`、通知 `--event-notify`、提问 `--event-ask`，各自带 `-soft` 底色。

### 徽章实底盘（Status tints）
会话内徽章 / 标签 / 状态片用**实底**（非半透明）配色，每族三件套 `底 / 字 / 边`：

| 语义 | 底 `bg` | 字 `ink` | 边 `bd` |
| --- | --- | --- | --- |
| info | `--tint-info` | `--ink-info` | — |
| success | `--tint-success` | `--ink-success` | `--bd-success` |
| warning | `--tint-warning` | `--ink-warning` | — |
| danger | `--tint-danger` | `--ink-danger` | `--bd-danger` |
| neutral | `--tint-neutral` | `--ink-neutral` | — |

强调色 `--c-accent-blue`（链接 / 激活 / 主操作）、`--c-accent-green`（成功 / 确认）。
> 带透明度的描边 / 阴影 / 遮罩一律用 `color-mix(in srgb, var(--token) N%, transparent)`，
> **禁止**在组件 CSS 写裸 `#hex` / `rgba()`——所有原始值只存在于 `design-tokens.css`。

---

## 3. 字体与字号（Typography）

- 展示体 `--font-display`（Sora）· 正文 `--font-body`（Manrope）· 等宽 `--font-mono`（JetBrains Mono）
- 字号刻度（基准 13px，约 1.2 比例）：
  `--text-2xs 10` · `--text-xs 11` · `--text-sm 12` · `--text-base 13` · `--text-md 14` ·
  `--text-lg 16` · `--text-xl 18` · `--text-2xl 22` · `--text-3xl 28` · `--text-4xl 34`
- 行高 `--leading-tight/snug/normal/relaxed`，字重 `--weight-regular…extrabold`，字距 `--tracking-*`。

**约定**：正文 `--text-md`；事件块标题 `--text-base`/`--weight-semibold`；徽章与元信息 `--text-xs`/大写字距 `--tracking-caps`。

**移动端字号（≤768px）**：在 design-tokens.css 的 `@media (max-width:768px)` 内统一上调整个 `--text-*` 刻度（向 iOS Dynamic Type 对齐，body 提到 16px）。一处生效、所有引用 `--text-*` 的组件自动适配。**任何文本输入框移动端必须 ≥16px**，否则 iOS 聚焦会自动放大页面。

---

## 4. 间距（Spacing）— 4px 基准

`--space-1 2` · `2 4` · `3 6` · `4 8` · `5 10` · `6 12` · `7 14` · `8 16` · `10 20` ·
`12 24` · `14 28` · `16 32` · `20 40` · `24 48` · `32 64`

组件内边距、间隙、堆叠间距一律取自该刻度。

---

## 4.5 组件库主题（antd）= 设计 token 的 JS 镜像

antd 全局主题在 `App.tsx` 的 `ConfigProvider` 统一配置，值与 design-tokens 对齐，**禁止在单个组件覆盖**：

- **按钮颜色**：`colorPrimary = #171717`（品牌墨色）。主按钮=墨底白字、默认按钮=描边、危险=`colorError`。扁平化（`primaryShadow/defaultShadow = none`），按钮文字 `fontWeight 600`。
- **圆角标准**：输入框/按钮 `10`（--radius-md）、小元素 `8`、卡片/弹窗 `14~16`。**不再用过圆的 16 做按钮**。
- **控件高度**：`controlHeight = 36`，按钮/输入/选择统一，保证横向排列基线对齐。
- 状态色 `colorSuccess/Warning/Error/Info` 与 design-tokens 完全一致。

## 4.6 对齐（Alignment）

- 所有内边距、间隙取自 4px 间距尺度（§4），同一区域的元素左/基线对齐到同一栅格。
- 工具栏/表单行用统一 `controlHeight 36` 控件，避免高低参差。
- 事件块左强调条 3px + 头部 `padding-left = pad + 3px`，正文内层容器左内边距 ≥10px 清开强调条，保证文字左边界一致。
- 图标按钮统一 40×40 命中区（移动端 ≥40px）。

## 5. 圆角 / 阴影 / 动效

- 圆角：`--radius-xs 6` · `sm 8` · `md 10` · `lg 12` · `xl 16` · `2xl 20` · `pill`
- 阴影：`--elevation-1…4`（层级递进）、`--ring-focus` / `--ring-focus-info`（聚焦环）
- 动效时长：`--motion-instant 80` · `fast 120` · `base 180` · `slow 280` · `slower 420`
- 缓动：`--ease-standard`（默认）· `--ease-emphasized` · `--ease-in-out`
- 已内置 `prefers-reduced-motion`：用户开启后所有 motion 归零。

---

## 6. 层级（Z-index）

`--z-base 0` · `raised 10` · `sticky 100` · `drawer 1000` · `overlay 1100` ·
`modal 1200` · `popover 1300` · `toast 1400`

---

## 7. 断点（Breakpoints）

CSS `@media` 无法读取变量，统一以下标准常量（写在 design-tokens.css 顶部注释）：

| 名称 | 宽度 | 含义 |
|---|---|---|
| xs | 480px | 手机竖屏 |
| sm | 640px | 大手机 |
| **md** | **768px** | **移动 ↔ 桌面布局切换点** |
| lg | 1024px | 平板横屏 / 侧栏切换 |
| xl | 1280px | 桌面 |
| 2xl | 1560px | 内容宽度上限 |

移动优先：默认写桌面样式，`@media (max-width: 768px)` 内收敛为移动布局。

### 移动端会话导航（iOS 标准）

聊天页在 ≤768px **不使用抽屉**，改为原生 iOS 导航栈（`Chat.tsx` + `chat.module.css` 的 `.mobileStack`）：

- **列表页**（根视图）：大标题「会话」+ 项目/会话列表。
- **对话页**：点击会话从右侧 push 进入，列表页轻微视差后退；顶部导航条 = 返回(←会话) + provider 徽标 + 标题 + 新建。
- **返回**：点左上角返回，或从**左缘横向滑动**返回（iOS 手势）。
- 导航条毛玻璃 + `env(safe-area-inset-top)` 安全区适配；点击目标 ≥40px。

---

## 8. 事件块（Event Block）统一约定

会话里所有「非纯文本」事件——工具调用 / 思考 / 计划 / 目标 / 记忆引用 / 任务通知 / 用户提问——
使用同一套结构与几何，避免「每种事件各写一套、风格不一」：

```
┌─ header: [icon] 标题 ……………… [状态徽章] [展开/折叠] ─┐
│  body（可折叠）                                         │
└────────────────────────────────────────────────────────┘
```

- 容器圆角 `--event-radius`、描边 `--event-border`、内边距 `--event-pad-x/y`、头部间隙 `--event-header-gap`。
- 左侧强调条/图标取事件语义色（`--event-*`），整体仍受当前 `--provider-accent` 影响。
- 状态徽章统一映射：待开始 / 进行中 / 已完成 / 需处理 / 失败 / 已取消（见 `message-structure.ts` 的状态机）。

---

## 8.6 会话归一：Canonical ProviderBlock

不同 provider（codex / claude / gemini / agy）原生结构里同一语义的字段名各不相同
（thinking 是 `reasoning` / `thoughts` / `content[].type=thinking`；plan 是 `update_plan` / `TodoWrite` / `PLANNER_RESPONSE`…）。
渲染器**不应**认识这些私有名。分层契约（详见 `tmp/provider-native-session-structure-comparison.md`）：

```
后端 reader（字符串协议）→ parseMessageBlocks（中间 MessageBlock[]）
  → toProviderBlocks（归一）→ ProviderBlock[] → 渲染器按 kind 映射叶子组件
```

- **`provider-blocks.ts` 是唯一知道 provider 私有名的地方**：`toProviderBlocks()` 把中间块分类成
  canonical `ProviderBlock`（`text / reasoning / checklist / plan_text / question / answers /
  goal / memory_citation / task_event / shell / tool / tool_group / generic_tag`）。
- 渲染器（`MessageBubble` 的 `renderCanonicalBlock`）只 `switch (block.kind)`，每个 kind 一一对应叶子组件，
  不再出现 `TodoWrite` / `update_plan` / `proposed_plan` / `AskUserQuestion` 等私有名判断。
- **Stage 1（已落地）**：前端适配层——后端仍输出字符串协议，归一在前端完成。
- **Stage 2（待办）**：把归一迁到后端，每条消息直出 `ProviderBlock[]` JSON，删除前端字符串再解析。

---

## 8.5 交互 · 防抖 / 节流

统一工具 `src/utils/timing.ts`（`debounce` / `throttle`，均带 `cancel` / `flush`）：

- **节流（throttle）**：高频连续事件——消息区滚动（120ms）、`visualViewport` resize/scroll（60ms，移动键盘）。
- **防抖（debounce）**：输入驱动的重算——模型搜索过滤（220ms，输入即时回显、过滤延迟）。
- **防重复提交**：发送按钮以 `loading` + `canSend` 守卫，避免连点重复发送。
- 约定：组件卸载时调用 `.cancel()` 清理（见 Models 搜索用例）。

## 9. 迁移清单（渐进）

- [x] 抽离 design-tokens.css，App.css `:root` 收敛为唯一来源
- [x] provider 注册表统一（`provider-registry.ts`：名称/图标/强调色/标签色）
- [x] 会话容器注入 `data-provider` + `providerAccentStyle`，子组件统一引用 `--provider-accent`
- [x] EventBlock 共享原语 + StatusBadge（`EventBlock.tsx` / `EventBlock.module.css`）
- [x] 迁移事件块：Thinking / Memory / UserAnswers / CandidatePlan / TaskNotification / Plan / UserInputRequest / Goal
- [x] 工具块（ToolBlock / ToolGroup / Shell）**已迁移到 EventBlock**（统一外壳/折叠/强调条，新增 `barePadding` 适配代码与命令输出贴边）
- [x] `--chat-*` 变量对齐设计 token（聊天面与 EventBlock 统一）
- [x] EventBlock 小屏内边距收敛
- [x] 移动端会话导航改 iOS 导航栈（取代抽屉）+ 左缘滑动返回
- [x] 移动端字号刻度统一上调（≤768px）+ 输入框 ≥16px 防缩放
- [x] **硬编码色清零**：8 个组件/页面 CSS 共 299 处 `#hex` / `rgba()` 全部吸附到 token（灰阶 → neutral ramp，有色语义 → tint/ink/bd 盘，透明色 → `color-mix`）；脚本见 `web/scripts/migrate-colors.pl`
- [x] **死代码清理**：chat.module.css 移除 98 个已迁移到 EventBlock 的旧外壳 class（thinking/plan/goal/memory/confirmation/answer/tool/shell 等），文件 70.7KB → 53.2KB；选择器感知移除（逗号分支全死才删，保留 `:global(.ant-*)` 与动态 `taskDockBadge_*`）
- [x] TagBlock `thinking` 分支已委托 `ThinkingBlock`（无内联）
