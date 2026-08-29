# AI Home 会话系统演进矩阵与推进追踪表 (dsh 精髓 + HarmonyOS 6 视觉体系)

> **更新时间**：2026-08-29  
> **核心目标**：全面深度吸收 **DeepSeek-Harness (dsh)** 的前端架构与生产级交互精髓，全套视觉元素直接对标 **HarmonyOS 6**（光影通透、超级圆角微曲率、自适应毛玻璃、胶囊律动交互与精致卡片质感），并由 **AIH Codex / Claude Review 闭环保障质量**。

---

## 📊 一、功能矩阵与完成状态追踪 (Feature Matrix & Roadmap)

| 模块 / 维度 | 序号 | 核心功能 / 特性点 | 对标设计来源 | 状态 | 落地文件 / 关键代码 | 验证结论 (Codex / Claude) |
| :--- | :--- | :--- | :--- | :---: | :--- | :--- |
| **双模式架构解耦** | 1.1 | **Chat 纯聊天模式**（无路径依赖、直连 API 网关、毫秒响应） | dsh / Codex UI | ✅ **已完成** | `webui-chat-store.js`<br>`webui-chat-routes.js` | 纯聊天与工作区分流，独立持久化到 `~/.aih/chat-sessions/` |
| | 1.2 | **Work 工程工作区模式**（文件树、Git Diff、PTY 终端、审批） | dsh Workspace | ✅ **已完成** | `Chat.tsx`<br>`ProjectWorkbench.tsx` | 工作区完整挂载，支持本地 Agent 研发工程流 |
| | 1.3 | **Chat / Work 胶囊模式切换器**（ModeSelector 鸿蒙 6 胶囊） | HOS 6 Capsule | ✅ **已完成** | `ModeSelector.tsx` | 支持无感切换，状态持久化到 `localStorage` |
| **思考动力学与流式** | 2.1 | **帧率节流调度器**（`useThrottledVisualUpdate`） | dsh client-primitives | ✅ **已完成** | `use-throttled-visual-update.ts` | 基于 `requestAnimationFrame`，消除高频 chunk 抖动 |
| | 2.2 | **思考块最新思维右滚跟随**（`latestLine` + `scrollLeft`） | dsh `ReasoningRow` | ✅ **已完成** | `ThinkingBlock.tsx` | 流式打字机实时向前推进，结束后转首行摘要 |
| | 2.3 | **会话完成思考过程常驻折叠保存**（防止被正文冲掉） | AI Home 核心守护 | ✅ **已完成** | `assistant-live-state.js` | 修复 `finalizeAssistantMessage`，保留思考与正文 |
| **会话度量与统计** | 3.1 | **会话粘性度量条**（`StatsLine`） | dsh `StatsLine` | ✅ **已完成** | `StatsLine.tsx` | 聚合轮次、总耗时、平均 TTFT、平均速率与 Token 计数 |
| | 3.2 | **度量精度与单调守卫**（保留 1 位小数，`duration >= ttft`） | dsh Metrics Spec | ✅ **已完成** | `message-metrics-format.ts` | 解决由于精度和取整不一致导致的显示逻辑矛盾 |
| | 3.3 | **环形上下文压力计**（`ContextMeter` 环形表盘 + 80% 高水位预警） | dsh `ContextMeter` | ✅ **已完成** | `ContextMeter.tsx`<br>`MessageArea.tsx` | 实时监控 Token 占用，支持一键触发 `/compact` 压缩 |
| **消息快捷操作** | 4.1 | **消息悬浮动作栏**（`MessageIconActions`） | dsh `MessageIconActions` | ✅ **已完成** | `MessageIconActions.tsx` | 悬浮浮现一键复制、重新生成（Retry）与 Fork 分支 |
| | 4.2 | **层级回调打通**（`MessageArea` -> `MessageBubble` -> Actions） | React Callback Chain | ✅ **已完成** | `MessageArea.tsx` | 完整透传 `onRetry` 与 `onFork` 逻辑 |
| **富媒体与代码块** | 5.1 | **标准代码块**（`CodeBlock` 语言横幅 + 复制） | dsh `CodeBlock` | ✅ **已完成** | `CodeBlock.tsx`<br>`MessageMarkdown.tsx` | 统一语言 Banner，代码内部横向滚动，外部无溢出 |
| | 5.2 | **HTML / SVG 实时沙箱预览**（预览/代码双 Tab + 手机/PC 弹窗） | AI Home 富交互增强 | ✅ **已完成** | `HtmlCodeBlock.tsx` | 独立 iframe 沙箱隔离渲染，所见即所得 |
| **输入触发器与联想** | 6.1 | **浮层式命令菜单**（`SlashCommandMenu`） | dsh `MenuView` | ✅ **已完成** | `SlashCommandMenu.tsx` | Combobox 无失焦设计，支持全键盘高亮与 Tab 补全 |
| | 6.2 | **文件实体引用浮层**（`FileReferencePopover`） | dsh `ui-reference` | ✅ **已完成** | `FileReferencePopover.tsx` | 支持 `@` 触发工作区文件与文件夹智能联想 |
| **模型调度与容灾** | 7.1 | **历史消息模型最高优先级继承** | 状态真相统一规则 | ✅ **已完成** | `MessageArea.tsx` | 刷新后严格继承历史真实成功模型，杜绝回退默认 |
| | 7.2 | **OpenAI Responses 跨账号清洗与重试** | Gateway Failover Policy | ✅ **已完成** | `codex-adapter.js`<br>`upstream-failure-policy.js` | 自动清洗历史 `rs_` ID 与加密块，OAuth 失败自动转 API Key |
| **HarmonyOS 6 视觉** | 8.1 | **通透亚克力毛玻璃材质**（`--hos-blur-card` & Glass Tokens） | HOS 6 Acrylic Glass | ✅ **已完成** | `design-tokens.css`<br>`chat.module.css` | 多层高斯模糊 + 饱和度 190% + 内高光微描边 |
| | 8.2 | **超级圆角与微曲率几何**（Super Ellipse 16/20/24/32px） | HOS 6 Squircle Curve | ✅ **已完成** | `chat.module.css`<br>`EventBlock.module.css` | 告别生硬直角与生硬圆角，贴合视网膜屏幕曲率 |
| | 8.3 | **浮动 Composer 与胶囊控制器** | HOS 6 Capsule Dock | ✅ **已完成** | `composer-controls.module.css` | 32px 胶囊控制器，悬浮上浮与 focus-within 柔和光晕 |
| | 8.4 | **气泡弥散光影与灵动渐变** | HOS 6 Bubble Glow | ✅ **已完成** | `chat.module.css` | User 流光蓝渐变 + 弥散投影；Assistant 亚克力通透微光 |
| | 8.5 | **悬浮空态卡片**（`ChatEmptyState`） | HOS 6 Card Aesthetic | ✅ **已完成** | `ChatEmptyState.tsx` | 56px 悬浮发光 Icon 徽章 + 鸿蒙流光大圆角操作胶囊 |

---

## 📋 二、待办与深化演进清单 (TODO List)

- [ ] **TODO-1 (输入体验深化)**：将 `@` 文件引用浮层深度接入当前工作区实时后端文件树搜索接口（`/v0/webui/project/files`），实现多层级动态联想；
- [x] **TODO-2 (上下文压力计)**：已在输入框右侧成功集成 dsh 标准的 `ContextMeter` 环形压力计（实时监控 Token 窗口占用并在 80% 高水位给出 `/compact` 压缩引导）。
- [ ] **TODO-3 (虚拟滚动优化)**：会话消息超过 200 条时长对话的虚拟列表（Virtual List）接入，保持百万级长文本极致流畅；
- [ ] **TODO-4 (拖拽多模态增强)**：支持直接向悬浮 Composer 拖拽多个代码文件/文档，生成轻量卡片预览与一键附加。

---

## 🔍 三、AIH Codex / Claude 审查记录

- **审查基准**：代码必须符合 `clean code / SOLID / 设计模式`，严禁 God File；样式严格引用 `design-tokens.css`；全流程通过自动化构建与测试。
- **最新审查结论（Commit `ef794e71` / `38854437`）**：
  - 架构清晰解耦，新旧模式边界分明；
  - 视觉规范完整符合 HarmonyOS 6 顶级通透质感；
  - 全量 50/50 自动化测试无误通过。
