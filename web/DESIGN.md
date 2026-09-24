# AI Home Web — 设计规范（Design System）

> 视觉方向：**Calm Operator Console（冷静的运维控制台）**。2026-09 重设计定稿，取代此前的「HarmonyOS 6 毛玻璃」语言。
> 唯一 token 来源：[`src/styles/design-tokens.css`](src/styles/design-tokens.css)；antd 的 JS 镜像：[`src/theme/antd-theme.ts`](src/theme/antd-theme.ts)。
> 任何组件 **禁止** 写死颜色 / 字号 / 间距 / 圆角 / 阴影，一律引用 token。组件 CSS 中出现裸 `#hex` / `rgba()` 视为缺陷。

## 0. 设计原则

1. **数据是主角，界面退后。** 表面平整、1px 发丝线分层、不用毛玻璃 / 光晕 / 渐变按钮 / 弹性回弹。
2. **颜色只表达语义。** 中性灰阶承担结构；一个克制的强调色（Accent）表达「可交互 / 已选中 / 焦点」；状态色表达健康度；**Provider 品牌色是唯一的装饰色**，只用在图标、状态点与细进度条上。
3. **主操作用墨色（Ink）。** 主按钮是墨底（浅色主题近黑、深色主题近白），不与强调色竞争。一个区域最多一个主按钮。
4. **密度适中、对齐严格。** 控件 32px、4px 间距栅格、数字等宽（`tabular-nums`），适合长时间盯多账号 / 多 Provider。
5. **深浅主题同时设计。** 所有表面都来自语义 token，深色不是「反色补丁」。
6. **遵守 AGENTS.md「UI Visual Constraints」**：不使用大块 `Alert` 作为页面内容；不使用左侧彩色竖条；账号操作保持语义图标。

## 1. 分层模型

```
Primitive  →  Semantic  →  Domain
原始刻度       语义别名      领域语义（provider / event）
--c-*          --color-*     --provider-*  --event-*
--space-*      --hos-*（历史命名，值已并入本规范；新代码优先用 --color-* / --space-*）
```

- 新代码只用 Semantic / Domain 层（`--color-text`、`--space-4`、`--provider-accent` …）。
- `--hos-*` 是历史命名，保留名字以免大面积改引用，但**取值已按本规范重定**：玻璃材质 token 退化为不透明表面，模糊 token 为 `none`，弹性曲线等于标准曲线。

## 2. 色系（Color）

### 2.1 中性与结构（浅色 / 深色）

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--color-bg` | `#f7f7f8` | `#0f0f11` | 画布（页面底） |
| `--color-surface` | `#ffffff` | `#17171a` | 卡片、表格、侧栏 |
| `--color-surface-raised` | `#fcfcfc` | `#1e1e22` | 抬升面、悬浮层 |
| `--color-surface-muted` | `#f1f1f3` | `#1b1b1f` | 次级表面、表头、轨道 |
| `--color-surface-sunken` | `#eaeaed` | `#0b0b0d` | 下沉区（代码、输入槽） |
| `--color-border` | `#e3e3e7` | `#2b2b31` | 默认描边 / 分隔线 |
| `--color-border-strong` | `#d1d1d6` | `#3b3b42` | 悬停描边、强分隔 |
| `--color-heading` | `#18181b` | `#fafafa` | 标题 |
| `--color-text` | `#27272a` | `#e4e4e7` | 正文 |
| `--color-muted-strong` | `#52525b` | `#d4d4d8` | 次要正文、表头 |
| `--color-muted` | `#71717a` | `#a1a1aa` | 说明文字（≥4.5:1） |
| `--color-faint` | `#8a8a93` | `#8b8b94` | 仅限元信息/占位，不承载必要信息 |
| `--color-disabled` | `#d1d1d6` | `#5b5b63` | 禁用 |

### 2.2 交互色

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--color-ink` / `--color-on-ink` | `#18181b` / `#fff` | `#f4f4f5` / `#18181b` | 主按钮、移动端主操作 |
| `--color-accent` | `#2f5bd3` | `#7b9cff` | 链接、选中、Tab 指示、焦点环 |
| `--color-accent-soft` | accent 8% | accent 14% | 选中行 / 选中菜单弱底 |
| `--color-brand*` | = accent | = accent | 历史别名，等同 accent |

### 2.3 状态色（前景 + `-soft` 底）

`--color-success #15803d / #5cc389` · `--color-warning #b45309 / #e0a94a` · `--color-danger #c2322b / #f07068` · `--color-info = accent`。
徽章实底盘 `--tint-* / --ink-* / --bd-*` 保留（见 token 文件），深色自动翻转为「半透明色相底 + 浅色字」。

### 2.4 Provider 与事件

- Provider 强调色 `--provider-<id>` / `-soft` 不变；会话容器用 `data-provider` 注入 `--provider-accent`。**Claude 珊瑚色只代表 Claude，不再作为移动端全局强调色。**
- 事件语义色 `--event-*` 只用于事件块图标与状态徽章。

## 3. 字体（Typography）

- 字体族：`--font-body` = `Inter, "HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`；`--font-display` 与正文同族（不再用 Sora/Manrope/Plus Jakarta 三套混用）；`--font-mono` = `"JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`。
- **不从 Google Fonts 远程加载字体**：桌面端（Tauri）与内网环境离线可用，系统字体兜底。
- 字阶（桌面）：display 28 · h1 20（页面标题）· h2 16（卡片标题）· h3 14（小节）· body 14 · body-sm 13（表格、表单辅助）· caption 12 · micro 11。
- 字重：标题 600、标签 500、正文 400；`--weight-bold` 收敛为 600，不使用 800 超粗。
- 数字：KPI、表格数值、计数一律 `font-variant-numeric: tabular-nums`。
- 移动端（≤768px）整体上调一档，正文 15、输入框 ≥16px（防 iOS 缩放）。

## 4. 间距 · 圆角 · 阴影

- 间距：4px 基准 `--space-*` 刻度不变（`--space-4 8` · `--space-6 12` · `--space-8 16` · `--space-12 24`）。
- 页面内距：桌面 24px、移动 16px；区块间距 16px；卡片内距 16px。
- 圆角：`--hos-radius-2xs 4`（标签）· `xs 6`（按钮、输入、菜单项）· `sm 8`（下拉、小卡）· `md/lg 10`（卡片）· `xl 12`（弹窗）· `2xl 14` · `pill`（仅状态点 / 头像 / 计数胶囊）。
- 阴影：卡片**无阴影**，靠 1px 描边分层；浮层（下拉 / Popover）`--elevation-3`；弹窗 `--elevation-4`；深色下阴影加深并保留描边。
- 材质：不使用 `backdrop-filter` 毛玻璃。自定义壁纸仍可用，但只作为画布的淡化背景（被 90% 的画布色覆盖），不穿透卡片。

## 5. 动效

- 时长：`--motion-fast 120ms`（悬停 / 按压 / 颜色）· `--motion-base 160ms`（展开、下拉）· `--motion-slow 240ms`（抽屉、页面级）。
- 缓动：`--ease-standard cubic-bezier(0.2, 0, 0, 1)`；不使用超调（overshoot）弹簧；按钮不做位移 / 缩放。
- 状态点「运行中」可以缓慢呼吸（1.6s），其他元素不做循环动画。`prefers-reduced-motion` 下全部归零。

## 6. 组件规则

| 组件 | 规则 |
|---|---|
| 页面头 `PageScaffold` | 标题 h1 20/600 + 同行副标题 13 muted；右侧操作：次要按钮在左、唯一主按钮在最右。移动端副标题换行、操作为 40px 图标按钮。 |
| 卡片 `SectionCard` | surface 底、1px 描边、圆角 10、无阴影；头部 48px + 底部发丝线；内距 16。 |
| 按钮 | 高 32（sm 24 / lg 40），圆角 6，字重 500；全局关闭 antd 双汉字自动插空格（`AntdThemeProvider` 的 `button.autoInsertSpace=false`）。主按钮 = Ink；默认 = surface + 描边；文字按钮悬停出现 overlay 底；危险 = danger 字色。无渐变、无投影、无位移。 |
| 输入 / 选择 | 高 32，圆角 6，1px 描边；悬停 border-strong；聚焦 accent 描边 + 3px accent 20% 光环。带前后缀的输入只有外框一层描边。 |
| 表格 `ListTable` | 表头 surface-muted、12–13px muted-strong 500；行发丝线；悬停 overlay；数值列右对齐、等宽数字。 |
| Tabs / Segmented | Tabs：accent 下划线指示；Segmented：muted 轨道 + surface 选中块 + elevation-1，圆角 6。 |
| 标签 Tag | 圆角 4，tint 底无描边，12px。 |
| 弹窗 / 抽屉 / 下拉 | 不透明 raised 表面 + 描边；弹窗圆角 12；抽屉贴边侧无圆角；遮罩 40%（深色 60%）。焦点环只画在可交互控件上，不画在对话框容器上。 |
| KPI 条 | `components/ui/kpi-strip.css`（`.hos-kpi-strip`）或 `ServiceWidgetGrid`：一个容器内多个单元格，发丝线分隔；标签 12 muted、数值 20/600 等宽、说明 12 muted；状态用 6px 点 + 文字。 |
| 行内提示 | `components/ui/InlineNote`：取代大块 Alert，图标 + 13px 文字，只有图标带状态色；不超过两行。 |
| 空态 | antd `PRESENTED_IMAGE_SIMPLE` + 13px muted 文案。 |
| 焦点 | 所有可交互元素 `:focus-visible` 显示 2px accent 光环（`--ring-focus`）。 |

## 7. 应用外壳（Shell）

- 桌面侧栏 232px，surface 底 + 右侧发丝线；菜单项高 36、圆角 6；选中 = surface-muted 底 + heading 字 + 500 字重；分组箭头 muted。
- 侧栏底部是 Server 选择器（保留原行为）。
- 移动端：隐藏 ProLayout 顶栏，底部 TabBar（surface 底 + 顶部发丝线，选中项 = accent），页面画布连续铺满整屏。

## 7.1 页面级约定（本轮重设计）

- **仪表盘**：四个指标卡合并为一条 KPI 条；原彩色「健康 Hero」改为中性状态行（状态点 + 文案 + 健康条 + 计数胶囊），不再整块着色；冷却提示改为行内提示；Provider 卡片保持网格，扁平化。
- **账号管理**：统计条 + 列表卡片沿用结构，去除亮白描边、深色主题可读。
- **设置 / Server / SSH / 工具 / 模型 / 用量 / 生图**：保持信息架构，只替换材质、颜色、圆角和提示样式。
- **AI 会话**：保留三栏与移动端 iOS 导航栈，只替换材质与强调色。
- 所有页面：业务行为、路由、数据、文案语义不变。

## 7.2 已知保留项（本轮不改）

- 设置页「基础设置」为两列网格，左列卡片随右列高卡片的行高下移；改为独立两列会改变阅读顺序，留作后续结构优化。
- 模型用量页顶部为加载/错误状态预留 30px 状态槽（防止布局跳动，有测试守卫），空闲时表现为一段留白。
- 终端 / xterm、Monaco 编辑器、分享卡导出图、HTML 预览窗口保持固定配色（无法读取 CSS 变量或需恒定深色）。
- 分享卡导出页脚文案「HarmonyOS 6.1」属于产品文案，未改动。

## 8. 断点（Breakpoints）

| 名称 | 宽度 | 含义 |
|---|---|---|
| xs | 480px | 手机竖屏 |
| sm | 640px | 大手机 |
| **md** | **768px** | **移动 ↔ 桌面布局切换点** |
| lg | 1024px | 平板横屏 |
| xl | 1280px | 桌面（Provider 网格 4 列起点） |
| 2xl | 1560px | 宽屏 |

### 移动端会话导航（iOS 标准）

聊天页在 ≤768px **不使用抽屉**，使用原生 iOS 导航栈（`Chat.tsx` + `.mobileStack`）：列表页大标题「会话」→ 点击会话从右侧 push 进入对话页 → 左上角返回或左缘滑动返回；导航条不透明 surface + 底部发丝线，适配 `env(safe-area-inset-top)`；点击目标 ≥40px。

## 9. 层级（Z-index）

`--z-base 0` · `raised 10` · `sticky 100` · `drawer 1000` · `overlay 1100` · `modal 1200` · `popover 1300` · `toast 1400`

## 10. 验收清单（每次 UI 改动都要过）

1. `cd web && npm run build`、改动文件 eslint、相关单测通过。
2. 浅色 / 深色桌面（1440×900）与移动（390×844）真实渲染截图检查：无浅色块残留在深色页、标题可见。
3. 无大块 Alert、无左侧彩色竖条、无毛玻璃、无渐变按钮 / 光晕投影。
4. 桌面与移动只有一个强调色；Claude 珊瑚色只出现在 Claude 标识上。
5. 业务行为不变：路由、按钮动作、轮询 / SSE、弹窗流程。

## 11. 事件块（Event Block）统一约定

会话里所有「非纯文本」事件——工具调用 / 思考 / 计划 / 目标 / 记忆引用 / 任务通知 / 用户提问——
使用同一套结构与几何，避免「每种事件各写一套、风格不一」：

```
┌─ header: [icon] 标题 ……………… [状态徽章] [展开/折叠] ─┐
│  body（可折叠）                                         │
└────────────────────────────────────────────────────────┘
```

- 容器圆角 `--event-radius`、描边 `--event-border`、内边距 `--event-pad-x/y`、头部间隙 `--event-header-gap`。
- 事件语义色（`--event-*`）只作用于图标与状态徽章；**不使用左侧强调条**（AGENTS.md「UI Visual Constraints」）。
- 状态徽章统一映射：待开始 / 进行中 / 已完成 / 需处理 / 失败 / 已取消（见 `message-structure.ts` 的状态机）。

---

## 11.1 会话归一：Canonical ProviderBlock

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

## 11.2 交互 · 防抖 / 节流

统一工具 `src/utils/timing.ts`（`debounce` / `throttle`，均带 `cancel` / `flush`）：

- **节流（throttle）**：高频连续事件——消息区滚动（120ms）、`visualViewport` resize/scroll（60ms，移动键盘）。
- **防抖（debounce）**：输入驱动的重算——模型搜索过滤（220ms，输入即时回显、过滤延迟）。
- **防重复提交**：发送按钮以 `loading` + `canSend` 守卫，避免连点重复发送。
- 约定：组件卸载时调用 `.cancel()` 清理（见 Models 搜索用例）。

## 12. 迁移清单（渐进）

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
- [x] **2026-09 Calm Operator Console 重设计**：token 重定值（中性灰阶 + 单一强调色 + 墨色主按钮）、移除毛玻璃 / 光晕 / 弹性动效、统一字体栈并去掉远程字体、深色主题逐页修复、仪表盘与设置页大块提示改为行内提示、移动端强调色与桌面统一。
