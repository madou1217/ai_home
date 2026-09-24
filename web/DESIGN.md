# AI Home Web — 设计规范（Design System）

> 视觉方向：**Cyber HUD（极客 / 赛博朋克控制台）**，2026-09 定稿，取代此前的 Calm Operator Console。
> 唯一 token 来源：[`src/styles/design-tokens.css`](src/styles/design-tokens.css)；HUD 材质层：[`src/styles/hud.css`](src/styles/hud.css)；antd 的 JS 镜像：[`src/theme/antd-theme.ts`](src/theme/antd-theme.ts)。
> 组件 **禁止** 写死颜色 / 字号 / 间距 / 圆角 / 阴影，一律引用 token。组件 CSS 中出现裸 `#hex` / `rgba()` 视为缺陷（品牌色、xterm / Monaco 调色板除外）。

## 0. 原则

1. **功能必须真实（零虚构）。** 界面上的每个字段、数值、按钮都来自真实代码与接口；HUD 只改变外观，不引入演示数据、虚构指标或不存在的功能。没有后端支撑的动作不做。
2. **HUD 语言：** Void Black 画布 + 赛博网格；切角面板 + 青色角标；Orbitron 展示字体 + JetBrains Mono 数据字体；关键数值发光；状态用 LED。
3. **颜色只表达语义。** Electric Cyan = 可交互 / 选中 / 焦点；Matrix Green = 健康；Amber = 冷却 / 警告；Rose = 离线 / 错误。Provider 品牌色只用在其图标上。
4. **可读性优先于氛围。** 正文次级色、长文阅读字体、`prefers-reduced-motion`、CRT / 音效可关闭，都是硬约束。
5. **不使用浏览器原生 `alert` / `confirm` / `prompt`。** 确认框用 `utils/confirm-action` 或 antd `Modal.confirm`（已通过 `holderRender` 注入 HUD 主题），提示用 antd `message` / `notification`。
6. **遵守 AGENTS.md「UI Visual Constraints」**：不用大块 `Alert` 作为页面内容；不用左侧粗彩色竖条（角标与顶部短指示条不属于此类）；账号操作保持语义图标。

## 1. 分层

```
Primitive → Semantic → Domain → HUD
--c-*       --color-*   --provider-* --event-*   --hud-*（切角 / 角标 / 网格 / 光效）
```

`--hos-*` 为历史命名，取值已并入语义层；新代码使用 `--color-*` / `--space-*` / `--hud-*`。

## 2. 色系

默认主题为深色 HUD（`config.ts` 的 `headScripts` 在首帧前按 `localStorage['aih.theme']` 写入 `data-theme`，缺省 `dark`）；浅色为「日光 HUD」。写入入口唯一：`services/theme-persistence.ts`。

| Token | 深色 HUD | 日光 HUD | 用途 |
|---|---|---|---|
| `--color-bg` | `#05080e` | `#eef3f7` | 画布（叠加 32px 网格） |
| `--color-surface` / `--hud-panel-bg` | `#0a101a` / `rgba(10,16,26,.85)` | `#ffffff` | 面板 |
| `--color-surface-raised` | `#0c1524` | `#f7fafc` | 浮层、弹窗 |
| `--color-surface-sunken` | `#03060b` | `#dce5ed` | 输入槽、代码块 |
| `--color-border` / `-strong` | `#15263d` / `#23405f` | `#cbd8e3` / `#aabdcd` | 发丝线 |
| `--color-heading` / `--color-text` | `#f2fbff` / `#e2f1f8` | `#07121f` / `#13233a` | 标题 / 正文 |
| `--color-muted` | `#7f9bb3` | `#4f6a83` | 次级正文（≥4.5:1） |
| `--color-faint` | `#5c7890` | `#6f879c` | 仅标签 / 元信息 |
| `--color-accent` | `#00f0ff` | `#0086a0` | Electric Cyan |
| `--color-success` | `#00ff66` | `#00874a` | Matrix Green |
| `--color-warning` | `#ffaa00` | `#b86e00` | Amber |
| `--color-danger` | `#ff0055` | `#c20042` | Rose |

> 规范原色 `#5c7890` 在面板上约 3.9:1，不满足正文对比度，因此只作 `--color-faint`（大写标签、元信息），次级正文上调为 `#7f9bb3`。

## 3. 字体

- `--font-body` / `--font-mono`：JetBrains Mono（中文回落系统黑体）——界面、数据、表格。
- `--font-display`：Orbitron——页面标题、面板标题、KPI 数值、品牌。
- `--font-prose`：系统无衬线——会话消息正文等长文阅读（`.hud-prose`）。
- 字体经 `@fontsource` 随包分发（`app.tsx` 引入），不依赖外网 CDN，桌面端离线可用。
- 字阶：正文 13、表格 13、标签 10–11（大写字距 `--tracking-caps`）、页面标题 20、KPI 20–24。

## 4. 几何与光效（`--hud-*` + `hud.css`）

- **切角面板**：`clip-path` 四角切 `--hud-chamfer`（10px），左上 / 右下 2px 青色角标（`--hud-tick`）。适用：`.hud-panel`、`.unified-section-card`、`.surface-card`、`.hos-kpi-strip`、弹窗。小卡用 `.hud-panel--sm`（6px，单角标）。
- **按钮**：5px 对角切角；主按钮 = 半透明青底 + 青框 + 青字 + 光晕，悬停实底青 + 黑字；默认按钮 = 抬升面 + 描边，悬停青框。
- **圆角**：基础 2–4px，轮廓由切角表达；圆形只留给 LED、头像、计数。
- **光效**：`--hud-glow-accent`（面板 / 按钮外发光）、`--hud-text-glow*`（数值与标题发光，仅深色主题生效）。
- **网格**：`--hud-grid-size` 32px，线色 `--hud-grid-line`。
- **通用类**：`.hud-display`、`.hud-glow*`、`.hud-label`、`.hud-led(--ok|--warn|--err|--info|--live)`、`.hud-track`。

## 5. 动效与反馈

- 时长 `--motion-fast 120ms` / `--motion-base 160ms` / `--motion-slow 240ms`，`--ease-standard`；LED 呼吸只用于真实的「运行中 / 在线」。
- **CRT 扫描线**：`components/hud/HudEffects` 渲染固定覆盖层，默认开启，可在顶栏与设置页关闭（`services/hud-preferences.ts`，键 `aih.hud`）。
- **Web Audio 音效**：`services/hud-sfx.ts` 用 `OscillatorNode` 合成（增益 0.035），通过事件委托接入：点击可交互元素 → 按键音；`message` / `notification` 出现 → 成功 / 警告音；弹窗打开 → 开启音。默认开启，可静音；首次用户手势后才创建 AudioContext。
- `prefers-reduced-motion` 下所有动效时长归零、LED 不呼吸。

## 6. 组件规则

| 组件 | 规则 |
|---|---|
| HUD 顶栏 | `components/hud/HudHeader`：品牌 `AI_HOME`；遥测全部来自 `/v0/webui/management/status`（网关状态、可调度 / 总账号、冷却、成功率、请求数、策略、运行时长），15s 轮询、页面隐藏时暂停；SFX / CRT / 主题开关。 |
| 导航 | `[NN] 中文名 CODE`，编号与代号见 `components/hud/hud-nav.ts`，只做展示，不改路由名。 |
| 页面头 | Orbitron 标题 + `// 副标题`；右侧操作次要在左、主按钮在右。 |
| 卡片 / 面板 | 切角 + 角标，悬停描边转青。 |
| KPI | 单个 HUD 条内多格，`hud-label` 标签 + `hud-display` 发光数值（颜色按真实语义）。 |
| 状态 | `hud-led` + 大写等宽文字。 |
| 表格 | 等宽数据，表头大写字距。 |
| 输入 | 凹槽底色，聚焦青框 + 辉光。 |
| 弹窗 / 确认 | 切角 + 青框 + Orbitron 青色标题；确认用 `confirmAction`。 |
| 提示 | 按类型着色图标 + 青色描边面板。 |
| 行内提示 | `components/ui/InlineNote`（取代大块 Alert）。 |
| 复制 | 只复制界面已展示的真实标识（accountRef、URL、路径、会话 ID），不展示任何密钥明文。 |

## 7. 外壳

- 桌面：ProLayout `mix`——通栏 HUD 顶栏（60px）+ 左侧编号导航（248px）+ 侧栏底部 Server 选择器（原行为）。
- 移动（≤767px）：隐藏顶栏，底部 HUD TabBar；CRT / 音效 / 主题开关在「设置 → 外观」。
- 会话页保持三栏与移动端 iOS 导航栈。

## 7.2 已知保留项

- 设置页两列网格的左列随右列行高下移（改为独立两列会改变阅读顺序）。
- 模型用量页顶部为加载状态预留 30px 状态槽（防跳动，有测试守卫）。
- 终端 / xterm、Monaco、分享卡导出图、HTML 预览窗口保持固定配色。

## 8. 断点

xs 480 · sm 640 · **md 768（移动 ↔ 桌面）** · lg 1024 · xl 1280（顶栏遥测完整显示 ≥1440）· 2xl 1560。

## 9. 层级

`--z-base 0` · `raised 10` · `sticky 100` · `drawer 1000` · `overlay 1100` · `modal 1200` · `popover 1300` · `toast 1400` · CRT 覆盖层 3000（`pointer-events: none`）。

## 10. 验收清单

1. `cd web && npm run build`、改动文件 eslint、`bun test web/src`、相关 node 测试通过。
2. 深色 HUD / 日光 HUD 桌面（1440×900）与移动（390×844）真实截图检查。
3. 界面数据全部来自真实接口；无演示数据、无虚构功能；无浏览器原生 alert / confirm。
4. CRT、音效、主题三个开关可用且持久化；`prefers-reduced-motion` 生效。
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
- [x] ~~2026-09 Calm Operator Console 重设计~~（已被 Cyber HUD 取代）：token 重定值（中性灰阶 + 单一强调色 + 墨色主按钮）、移除毛玻璃 / 光晕 / 弹性动效、统一字体栈并去掉远程字体、深色主题逐页修复、仪表盘与设置页大块提示改为行内提示、移动端强调色与桌面统一。
- [x] **2026-09 Cyber HUD 重设计**：深色 HUD 默认 + 日光 HUD、切角面板与角标、Orbitron / JetBrains Mono 本地字体、HUD 顶栏真实遥测、编号导航、CRT 扫描线与 Web Audio 音效开关、静态确认框 / 提示主题化、原生 window.confirm 清零。
