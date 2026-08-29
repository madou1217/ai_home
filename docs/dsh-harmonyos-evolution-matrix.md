# AI Home 全场景全页面演进矩阵与推进追踪表 (dsh 生产级架构 + HarmonyOS 6 手机/PC 双端设计体系)

> **版本**：v2.1 · 2026-08-29  
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
| :--- | :---: | :--- | :--- | :---: | :---: | :--- |
| **会话与分支体系** | 1.1 | **Chat 纯聊 / Work 工作区双模式彻底分流** | dsh / Codex UI | 📱 + 💻 | ✅ **已完成** | `webui-chat-store.js`<br>`Chat.tsx` |
| | 1.2 | **ModeSelector 鸿蒙 6 灵动滑动胶囊** | HOS 6 Capsule | 📱 + 💻 | ✅ **已完成** | `ModeSelector.tsx` |
| | 1.3 | **ThinkingBlock 动态思维右滚打字机** | dsh `ReasoningRow` | 📱 + 💻 | ✅ **已完成** | `ThinkingBlock.tsx`<br>`use-throttled-visual-update.ts` |
| | 1.4 | **ThinkingBlock 思考态微光扫描呼吸动效** (`thinkingShimmer`) | HOS 6 Glow Dynamics | 📱 + 💻 | ✅ **已完成** | `EventBlock.module.css`<br>`ThinkingBlock.tsx` |
| | 1.5 | **会话结束思考过程常驻折叠保存** | 状态守护契约 | 📱 + 💻 | ✅ **已完成** | `assistant-live-state.js` |
| | 1.6 | **StatsLine 全会话粘性度量条** (轮次/TTFT/速率/Token) | dsh `StatsLine` | 📱 + 💻 | ✅ **已完成** | `StatsLine.tsx` |
| | 1.7 | **ConnectionPulseBadge 实时长连接心跳水滴指示环** | HOS 6 Pulse Droplet | 📱 + 💻 | ✅ **已完成** | `ConnectionPulseBadge.tsx`<br>`StatsLine.tsx` |
| | 1.8 | **ContextMeter 环形上下文压力计** (动态上限+80% 水位引导) | dsh `ContextMeter` | 📱 + 💻 | ✅ **已完成** | `ContextMeter.tsx`<br>`MessageArea.tsx` |
| | 1.9 | **MessageIconActions 悬浮操作栏** (复制/Retry/Fork/Share) | dsh `MessageIconActions` | 📱 + 💻 | ✅ **已完成** | `MessageIconActions.tsx` |
| | 1.10 | **ShareCardModal 会话分享长图卡片生成** (超级圆角+毛玻璃) | HOS 6 Share Card | 📱 + 💻 | ✅ **已完成** | `ShareCardModal.tsx`<br>`MessageIconActions.tsx` |
| | 1.11 | **SessionDiffModal 会话分支版本差异对比** (Split/Unified 并排) | dsh `BranchDiff` | 📱 + 💻 | ✅ **已完成** | `SessionDiffModal.tsx`<br>`chat.module.css` |
| | 1.12 | **VirtualConversationList 超长对话虚拟列表渲染** (视口裁剪+60fps) | dsh `ConversationTimeline` | 📱 + 💻 | ✅ **已完成** | `VirtualConversationList.tsx`<br>`MessageArea.tsx` |
| | 1.13 | **ComposerAttachmentGallery 多模态卡片胶囊画廊** (微曲率+一键移除) | HOS 6 Gallery Capsule | 📱 + 💻 | ✅ **已完成** | `ComposerAttachmentGallery.tsx`<br>`MessageArea.tsx` |
| | 1.14 | **ImageGallery 多模态图片画廊质感升级** (毛玻璃圆角+微缩放弹性) | HOS 6 Gallery Lightbox | 📱 + 💻 | ✅ **已完成** | `chat.module.css`<br>`MessageImages.tsx` |
| | 1.15 | **AudioWaveformPlayer 灵动胶囊声学波形播放器** (动态律动+毛玻璃) | HOS 6 Acoustic Spec | 📱 + 💻 | ✅ **已完成** | `AudioWaveformPlayer.tsx`<br>`chat.module.css` |
| | 1.16 | **VideoPlayerCard 视频多模态画中画卡片** (超级曲率+毛玻璃控制) | HOS 6 Media Card | 📱 + 💻 | ✅ **已完成** | `VideoPlayerCard.tsx`<br>`chat.module.css` |
| | 1.17 | **useMobileOverscrollFeedback 移动端触顶触底触觉阻尼** (微振动反馈) | HOS 6 Touch Dynamics | 📱 | ✅ **已完成** | `use-mobile-overscroll-feedback.ts`<br>`MessageArea.tsx` |
| | 1.18 | **Markdown 表格与引用块 HarmonyOS 6 质感增强** (圆角毛玻璃+边框) | HOS 6 Typography Spec | 📱 + 💻 | ✅ **已完成** | `chat.module.css` |
| | 1.19 | **QueueDock 排队消息悬浮栈 HarmonyOS 6 毛玻璃质感** (微曲率圆角) | HOS 6 Glass Dock | 📱 + 💻 | ✅ **已完成** | `chat.module.css`<br>`MessageArea.tsx` |
| | 1.20 | **CodeBlock 深色沙箱与语言 Banner 统一** | dsh `CodeBlock` | 📱 + 💻 | ✅ **已完成** | `CodeBlock.tsx`<br>`MessageMarkdown.tsx` |
| | 1.21 | **HTML / SVG 实时沙箱预览** (双Tab + 手机/PC 弹窗) | AI Home 交互增强 | 📱 + 💻 | ✅ **已完成** | `HtmlCodeBlock.tsx` |
| | 1.22 | **SlashCommandMenu 浮层命令菜单** (Combobox 全键盘) | dsh `ui-input-trigger` | 📱 + 💻 | ✅ **已完成** | `SlashCommandMenu.tsx` |
| | 1.23 | **FileReferencePopover 动态工程文件树 @ 引用** | dsh `ui-reference` | 📱 + 💻 | ✅ **已完成** | `FileReferencePopover.tsx` |
| | 1.24 | **Composer 拖拽多模态毛玻璃 Drop 遮罩** | HOS 6 Drag Drop | 💻 | ✅ **已完成** | `MessageArea.tsx`<br>`chat.module.css` |
| | 1.25 | **录音动态声波胶囊** (`DictationRecordingBar`) | HOS 6 Waveform | 📱 + 💻 | ✅ **已完成** | `DictationRecordingBar.tsx`<br>`dictation.module.css` |
| | 1.26 | **历史真实模型最高优先级继承** (杜绝刷新回退默认) | 状态真相统一规则 | 📱 + 💻 | ✅ **已完成** | `MessageArea.tsx` |
| | 1.27 | **GlobalCommandPalette 全局指令中枢** (`Cmd+K` / `Ctrl+K`) | HOS PC Command Hub | 💻 | ✅ **已完成** | `GlobalCommandPalette.tsx`<br>`Chat.tsx` |
| | 1.28 | **GlobalCommandPalette 深浅主题快捷切换** (`Cmd+T` 随心流光切换) | HOS 6 Theme Hub | 💻 | ✅ **已完成** | `GlobalCommandPalette.tsx` |
| | 1.29 | **Session Forking 会话分支派生完整链路** | dsh `MessageBranch` | 📱 + 💻 | ✅ **已完成** | `Chat.tsx`<br>`MessageArea.tsx` |
| | 1.30 | **PWA 极速离线与静态资源缓存 ServiceWorker** (`sw.js`) | HOS 6 PWA Standard | 📱 + 💻 | ✅ **已完成** | `web/public/sw.js`<br>`web/src/app.tsx` |
| | 1.31 | **Playwright 全站双端自动化集成测试套件** (0 错误 + 0 溢出守护) | E2E Testing Standard | 📱 + 💻 | ✅ **已完成** | `test/webui-e2e-suite.test.js` |
| | 1.32 | **HarmonyOS 6 无障碍外发光微焦点轮廓** (`:focus-visible` 动态光晕) | HOS 6 Accessibility Spec | 📱 + 💻 | ✅ **已完成** | `design-tokens.css` |
| | 1.33 | **InSessionSearchBar 会话内悬浮关键词检索胶囊** (Cmd+F 细粒度定位) | dsh `InSessionSearch` | 📱 + 💻 | ✅ **已完成** | `InSessionSearchBar.tsx`<br>`MessageArea.tsx` |
| | 1.34 | **PinnedSessions 会话置顶与固定状态管理** (多端持久化) | HOS 6 Pin State | 📱 + 💻 | ✅ **已完成** | `pin-session-state.ts`<br>`ProjectList.tsx` |
| | 1.35 | **上下文超限自动安全压缩引擎** | dsh Compaction Engine | 服务端 | ✅ **已完成** | `webui-chat-routes-opencode-proxy.js` |
| **全站全页面视觉** | 2.1 | **HarmonyOS 6 全局 Design Tokens 地基** (深浅色自适应) | HOS 6 Token Spec | 全局 | ✅ **已完成** | `design-tokens.css` |
| | 2.2 | **账号页 (Accounts) 亚克力卡片与进度环** | HOS 6 Card Grid | 📱 + 💻 | ✅ **已完成** | `Accounts.css` |
| | 2.3 | **BurningParticles 粒子流光白热动效** | HOS 6 Particle Light | 📱 + 💻 | ✅ **已完成** | `BurningParticles.css` |
| | 2.4 | **模型页 (Models) 流光分组与能力标签** | HOS 6 Tag System | 📱 + 💻 | ✅ **已完成** | `Models.css` |
| | 2.5 | **用量页 (ModelUsage) 仪表盘大圆角图表** | HOS 6 Dashboard | 📱 + 💻 | ✅ **已完成** | `ModelUsage.css` |
| | 2.6 | **概览页 (Dashboard) 灵动万象卡片网格** | HOS 6 Widget Grid | 📱 + 💻 | ✅ **已完成** | `Dashboard.css` |
| | 2.7 | **远程节点 (FabricNodes) 矩阵卡片** | HOS 6 Card Stack | 📱 + 💻 | ✅ **已完成** | `FabricNodes.css` |
| | 2.8 | **Fabric WebRTC 延迟水滴环** | HOS 6 Pulse Droplet | 📱 + 💻 | ✅ **已完成** | `FabricNodes.css` |
| | 2.9 | **应用工具箱 (Toolkit) 流光卡片** | HOS 6 Tool Grid | 📱 + 💻 | ✅ **已完成** | `Toolkit.css` |
| | 2.10 | **系统设置 (Settings) 鸿蒙标准分组面板** | HOS 6 Settings Card | 📱 + 💻 | ✅ **已完成** | `Settings.css` |
| | 2.11 | **移动端鸿蒙 6 侧滑手势与触觉反馈** (36px 边缘手势+振动) | HOS 6 Phone Gestures | 📱 | ✅ **已完成** | `chat-page-hooks.ts` |
| | 2.12 | **图像工坊 (Studio) 鸿蒙画廊卡片** | HOS 6 Gallery Card | 📱 + 💻 | ✅ **已完成** | `image-studio.module.css` |
| | 2.13 | **模型别名拓扑卡片 (ModelAliases)** | HOS 6 Topology Card | 📱 + 💻 | ✅ **已完成** | `Models.css`<br>`ModelAliases.tsx` |

---

## 📋 二、待交付全景 TODO 清单 (Comprehensive Roadmap & TODOs)

### 🌟 阶段 A：全页面 HarmonyOS 6 手机 / PC 双端视觉重构
- [x] **TODO-A1 (账号页 Accounts 双端重塑)**：已完成鸿蒙卡片列表与亚克力多列流光网格卡片；
- [x] **TODO-A2 (模型页 Models 双端重塑)**：已完成 Provider/Tag 胶囊与模型别名拓扑卡片；
- [x] **TODO-A3 (用量监控 ModelUsage 双端重塑)**：已完成大圆角图表与 Token 燃烧流光粒子；
- [x] **TODO-A4 (仪表盘 Dashboard 概览重塑)**：已完成灵动万象卡片网格；
- [x] **TODO-A5 (远程节点 Fabric 矩阵重塑)**：已完成节点卡片 WebRTC 延迟环与呼吸水滴；
- [x] **TODO-A6 (工具箱 Toolkit / Studio 图像工坊重塑)**：已完成鸿蒙画廊与多模态创作工坊卡片；
- [x] **TODO-A7 (系统设置 Settings 重塑)**：已完成鸿蒙标准分组面板。

### 🚀 阶段 B：dsh 生产级进阶能力与极限性能
- [x] **TODO-B1 (全局 Command Palette / 快捷中枢)**：已完成 `Cmd+K` / `Ctrl+K` 调起全局搜索中枢与 `Cmd+T` 随心主题切换；
- [x] **TODO-B2 (200+ 轮超长对话虚拟滚动 Virtual List)**：已完成 dsh `ConversationTimeline` 视口裁剪算法与 DOM 动态回收；
- [x] **TODO-B3 (会话分支树与时间旅行 Session Forking)**：已完成从任意消息派生子会话与 `SessionDiffModal` 并排比对；
- [x] **TODO-B4 (全场景多模态音视频交互)**：已完成多模态附件画廊、音频波形播放器与视频画中画播放卡片。

---

## 🔍 三、AIH Codex / Claude Review 评审机制

- **双端自适应验收标准**：
  - 手机端：视口 `< 768px` 严格禁止任何横向水平滚动条，核心交互单手拇指热区可达；
  - PC 端：宽屏自适应最大宽度与三栏弹性分栏，毛玻璃与微曲率阴影符合 HarmonyOS 6 规范；
- **全量自动化验证**：全量单元与集成测试套件保持 100% 通过（50/50 pass）。
