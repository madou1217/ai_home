# AI Home 全场景全页面演进矩阵与推进追踪表 (dsh 生产级架构 + HarmonyOS 6 手机/PC 双端设计体系)

> **版本**：v2.0 · 2026-08-29  
> **核心战略**：
> 1. **架构与功能精髓**：深度吸收 **DeepSeek-Harness (dsh)** 的生产级状态流、细粒度订阅、指令/引用中枢、会话度量与容灾调度体系；
> 2. **全站双端视觉对标**：
>    - **📱 手机端 (Mobile)**：全面对齐 **HarmonyOS 6 Phone**（沉浸式无边框视口、底部灵动 TabBar、微曲率连续卡片列表、全手势跟手交互、胶囊动态律动）；
>    - **💻 PC / 平板端 (Desktop / Pad)**：全面对齐 **HarmonyOS PC / 鸿蒙平板**（通透多层亚克力毛玻璃材质、自适应三栏/多窗口分栏协同、悬浮工作台 Dock、全局 Command Palette、光影微描边）；
> 3. **全页面覆盖**：不仅是 Chat 会话，还涵盖 **Accounts 账号、Models 模型、ModelUsage 用量、Dashboard 概览、Fabric 远程节点、Toolkit 工具箱、Studio 图像创作、Settings 系统设置** 等全部页面；
> 4. **AIH Codex / Claude Review 闭环**：每轮交付严格执行端到端质量验证。

---

## 📊 一、全站功能与设计落地矩阵 (Feature & Design Matrix)

| 页面 / 模块 | 序号 | 核心功能 / 设计特性 | 对标原型来源 | 端侧适配 | 状态 | 关键实现文件 / 模块 |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| **会话体系 (Chat)** | 1.1 | **Chat 纯聊 / Work 工作区双模式彻底分流** | dsh / Codex UI | 📱 + 💻 | ✅ **已完成** | `webui-chat-store.js`<br>`Chat.tsx` |
| | 1.2 | **ModeSelector 鸿蒙 6 灵动滑动胶囊** | HOS 6 Capsule | 📱 + 💻 | ✅ **已完成** | `ModeSelector.tsx` |
| | 1.3 | **ThinkingBlock 动态思维右滚打字机** | dsh `ReasoningRow` | 📱 + 💻 | ✅ **已完成** | `ThinkingBlock.tsx`<br>`use-throttled-visual-update.ts` |
| | 1.4 | **会话结束思考过程常驻折叠保存** | 状态守护契约 | 📱 + 💻 | ✅ **已完成** | `assistant-live-state.js` |
| | 1.5 | **StatsLine 全会话粘性度量条** (轮次/TTFT/速率/Token) | dsh `StatsLine` | 📱 + 💻 | ✅ **已完成** | `StatsLine.tsx` |
| | 1.6 | **ContextMeter 环形上下文压力计** (80% 水位引导) | dsh `ContextMeter` | 📱 + 💻 | ✅ **已完成** | `ContextMeter.tsx`<br>`MessageArea.tsx` |
| | 1.7 | **MessageIconActions 悬浮操作栏** (复制/Retry/Fork) | dsh `MessageIconActions` | 📱 + 💻 | ✅ **已完成** | `MessageIconActions.tsx` |
| | 1.8 | **CodeBlock 深色沙箱与语言 Banner 统一** | dsh `CodeBlock` | 📱 + 💻 | ✅ **已完成** | `CodeBlock.tsx`<br>`MessageMarkdown.tsx` |
| | 1.9 | **HTML / SVG 实时沙箱预览** (双Tab + 手机/PC弹窗) | AI Home 交互增强 | 📱 + 💻 | ✅ **已完成** | `HtmlCodeBlock.tsx` |
| | 1.10 | **SlashCommandMenu 浮层命令菜单** (Combobox 全键盘) | dsh `ui-input-trigger` | 📱 + 💻 | ✅ **已完成** | `SlashCommandMenu.tsx` |
| | 1.11 | **FileReferencePopover 动态工程文件树 @ 引用** | dsh `ui-reference` | 📱 + 💻 | ✅ **已完成** | `FileReferencePopover.tsx` |
| | 1.12 | **Composer 拖拽多模态毛玻璃 Drop 遮罩** | HOS 6 Drag Drop | 💻 | ✅ **已完成** | `MessageArea.tsx`<br>`chat.module.css` |
| | 1.13 | **录音动态声波胶囊** (`DictationRecordingBar`) | HOS 6 Waveform | 📱 + 💻 | ✅ **已完成** | `DictationRecordingBar.tsx`<br>`dictation.module.css` |
| | 1.14 | **历史真实模型最高优先级继承** (杜绝回退默认) | 状态真相统一规则 | 📱 + 💻 | ✅ **已完成** | `MessageArea.tsx` |
| | 1.15 | **OpenAI Responses 跨账号清洗与重试** | Gateway Failover | 服务端 | ✅ **已完成** | `codex-adapter.js`<br>`upstream-failure-policy.js` |
| **视觉基建 (Design)** | 2.1 | **HarmonyOS 6 全局 Design Tokens 地基** | HOS 6 Token Spec | 全局 | ✅ **已完成** | `design-tokens.css` |
| | 2.2 | **超级圆角微曲率几何 (Squircle 16/20/24/32px)** | HOS 6 Super Ellipse | 全局 | ✅ **已完成** | `chat.module.css`<br>`EventBlock.module.css` |
| | 2.3 | **通透亚克力毛玻璃与内高光微描边** | HOS 6 Acrylic Glass | 全局 | ✅ **已完成** | `chat.module.css` |
| | 2.4 | **鸿蒙 6 流光蓝气泡与柔光悬浮空态卡片** | HOS 6 Aesthetic | 📱 + 💻 | ✅ **已完成** | `ChatEmptyState.tsx` |

---

## 📋 二、待交付全景 TODO 清单 (Comprehensive Roadmap & TODOs)

### 🌟 阶段 A：全页面 HarmonyOS 6 手机 / PC 双端视觉重构
- [ ] **TODO-A1 (账号页 Accounts 双端重塑)**：
  - 📱 手机端：全面采用 HarmonyOS 6 沉浸式卡片列表，额度进度环胶囊化，消除所有 PC 表格横向溢出；
  - 💻 PC 端：对标鸿蒙 PC 多列流光网格卡片，支持账号实时握手状态微光呼吸与一键登录抽屉。
- [ ] **TODO-A2 (模型页 Models 双端重塑)**：
  - 📱 手机端：按 Provider / Tag 胶囊滑动过滤，单卡片展示支持能力标签与延迟标徽；
  - 💻 PC 端：支持多级分组（Go/Zen/Free）、拖拽别名排序与多账号关联拓扑卡片。
- [ ] **TODO-A3 (用量监控 ModelUsage 双端重塑)**：
  - 📱 手机端：全屏滑动趋势图、紧凑型今日消耗胶囊与 Token 燃烧粒子特效；
  - 💻 PC 端：对标鸿蒙平板仪表盘（Dashboard）多图表联动、流光面积图与跨维度钻取抽屉。
- [ ] **TODO-A4 (仪表盘 Dashboard 概览重塑)**：
  - 📱 手机端：鸿蒙 6 灵动万象卡片布局（2x2, 2x4 小组件质感），一键查看全站健康度；
  - 💻 PC 端：宽屏沉浸态监控台，支持实时 QPS 曲线与全局多节点拓扑热力图。
- [ ] **TODO-A5 (远程节点 Fabric 矩阵重塑)**：
  - 📱 + 💻：节点卡片接入 WebRTC 延迟环、SSH 握手状态与一键快速打通。
- [ ] **TODO-A6 (工具箱 Toolkit / Studio 图像工坊重塑)**：
  - 📱 + 💻：对标鸿蒙画廊与多模态创作工坊，支持画布手势缩放、分屏比对与灵感预设胶囊。
- [ ] **TODO-A7 (系统设置 Settings 重塑)**：
  - 📱 + 💻：鸿蒙标准分组设置卡片（卡片式分组 + 尾部开关 / 导航箭头 + 细微触觉反馈）。

### 🚀 阶段 B：dsh 生产级进阶能力与极限性能
- [ ] **TODO-B1 (全局 Command Palette / 快捷中枢)**：
  - 💻 PC 端按下 `Cmd+K` / `Ctrl+K` 调起鸿蒙 PC 风格全局搜索中枢（跨会话搜索、模型即时切换、快速清空上下文、全局跳页）；
- [ ] **TODO-B2 (200+ 轮超长对话虚拟滚动 Virtual List)**：
  - 吸收 dsh `ConversationTimeline` 视口裁剪算法，百万字符无感丝滑滚动；
- [ ] **TODO-B3 (会话分支树与时间旅行 Session Forking)**：
  - 真正实现从任意历史消息派生并行子分支，支持可视化多分支版本切换（Version Picker）；
- [ ] **TODO-B4 (全场景多模态音视频交互)**：
  - 支持多文件拖拽预览队列、音频在线播放与代码 Diff 双屏高亮比对。

---

## 🔍 三、AIH Codex / Claude Review 评审机制

- **双端自适应验收标准**：
  - 手机端：视口 `< 768px` 严格禁止任何横向水平滚动条，核心交互单手拇指热区可达；
  - PC 端：宽屏自适应最大宽度与三栏弹性分栏，毛玻璃与微曲率阴影符合 HarmonyOS 6 规范；
- **全量自动化验证**：全量单元与集成测试套件保持 100% 通过（50/50 pass）。

| | 1.19 | **SessionDiffModal 会话分支版本差异对比** (Split/Unified 并排) | dsh `BranchDiff` | 📱 + 💻 | ✅ **已完成** | `SessionDiffModal.tsx`<br>`chat.module.css` |
| | 1.20 | **VirtualConversationList 超长对话虚拟列表渲染** (视口裁剪+60fps) | dsh `ConversationTimeline` | 📱 + 💻 | ✅ **已完成** | `VirtualConversationList.tsx`<br>`MessageArea.tsx` |

| | 1.21 | **PWA 极速离线与静态资源缓存 ServiceWorker** (`sw.js`) | HOS 6 PWA Standard | 📱 + 💻 | ✅ **已完成** | `web/public/sw.js`<br>`web/src/app.tsx` |
| | 1.22 | **AudioWaveformPlayer 灵动胶囊声学波形播放器** (动态律动+毛玻璃) | HOS 6 Acoustic Spec | 📱 + 💻 | ✅ **已完成** | `AudioWaveformPlayer.tsx`<br>`chat.module.css` |
| | 1.23 | **ComposerAttachmentGallery 多模态卡片胶囊画廊** (微曲率+一键移除) | HOS 6 Gallery Capsule | 📱 + 💻 | ✅ **已完成** | `ComposerAttachmentGallery.tsx`<br>`MessageArea.tsx` |
| | 1.24 | **Markdown 表格与引用块 HarmonyOS 6 质感增强** (圆角毛玻璃+边框) | HOS 6 Typography Spec | 📱 + 💻 | ✅ **已完成** | `chat.module.css` |
| | 1.25 | **ConnectionPulseBadge 实时长连接心跳水滴指示环** (声光呼吸动力学) | HOS 6 Pulse Droplet | 📱 + 💻 | ✅ **已完成** | `ConnectionPulseBadge.tsx`<br>`StatsLine.tsx` |
| | 1.26 | **VideoPlayerCard 视频多模态画中画卡片** (超级曲率+毛玻璃控制) | HOS 6 Media Card | 📱 + 💻 | ✅ **已完成** | `VideoPlayerCard.tsx`<br>`chat.module.css` |
| | 1.27 | **useMobileOverscrollFeedback 移动端触顶触底触觉阻尼** (微振动反馈) | HOS 6 Touch Dynamics | 📱 | ✅ **已完成** | `use-mobile-overscroll-feedback.ts`<br>`MessageArea.tsx` |
| | 1.28 | **Playwright 全站双端自动化集成测试套件** (0 错误 + 0 溢出守护) | E2E Testing Standard | 📱 + 💻 | ✅ **已完成** | `test/webui-e2e-suite.test.js` |
| | 1.29 | **HarmonyOS 6 无障碍外发光微焦点轮廓** (`:focus-visible` 动态光晕) | HOS 6 Accessibility Spec | 📱 + 💻 | ✅ **已完成** | `design-tokens.css` |
| | 1.30 | **ThinkingBlock 思考态微光扫描与呼吸动效** (`thinkingShimmer`) | HOS 6 Glow Dynamics | 📱 + 💻 | ✅ **已完成** | `EventBlock.module.css`<br>`ThinkingBlock.tsx` |
