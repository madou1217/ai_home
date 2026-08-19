# 《Pi 编码 Agent 架构与终端 TUI 引擎设计》
> **从 @earendil-works/pi 源码解构多模型统一层、差异化 TUI 渲染与 Gondolin 微虚拟机沙箱**

---

## 📖 书籍定位与愿景
本书以开源自扩展编码助手 **Pi (`@earendil-works/pi`)** 为解剖麻雀的蓝本，针对传统 Agent 框架“绑定特定厂商 API、终端 UI 闪烁卡顿、工具执行缺乏物理隔离”三大痛点，以 **1000% 钻透源码** 的深度，全景剖析其在 **统一多模型中间层（`pi-ai`）、自扩展事件循环（`pi-agent-core`）、差量屏幕更新 TUI 引擎（`pi-tui`）、Gondolin 微虚拟机（Micro-VM）安全沙箱与 Subagent 隔离通信机制** 的底层实现。

---

## 🗺️ 全景交互目录与章节进度

### 00. 架构概览与设计哲学 (Architecture & Monorepo Layout)
- [x] [00-01 为什么需要自扩展（Self-Extensible）Coding Agent？Pi 的 Monorepo 五大核心包分层设计](00-intro/01-monorepo-layout-and-philosophy.md)

---

### 01. 🌐 第一篇：多模型统一层与抽象中枢 (`pi-ai`)
- [x] [01-01 统一多 Provider LLM 协议：OpenAI、Anthropic 与 Google 的流式抹平与适配器模式](01-pi-ai-engine/01-01-multi-provider-adapter.md)
- [x] [01-02 结构化工具调用（Tool Schema）规范化与跨模型 Polyfill 机制](01-pi-ai-engine/01-02-structured-tool-schema.md)

---

### 02. ⚡ 第二篇：自扩展 Agent 事件循环与调度核 (`pi-agent-core`)
- [x] [02-01 Agent Event Loop 生命周期与 Tool Dispatcher 动态加载机制](02-agent-core/02-01-event-loop-and-dispatcher.md)
- [x] [02-02 /loop 与自适应动态唤醒（Dynamic Pacing vs Cron）深度设计解析](02-agent-core/02-02-loop-and-dynamic-pacing.md)
- [x] [02-03 Subagent 物理隔离与协同：Fork 模式 vs Worktree 独立沙箱及 SendMessage 协议](02-agent-core/02-03-subagent-fork-and-worktree.md)

---

### 03. 🖥️ 第三篇：终端 TUI 差量渲染引擎 (`pi-tui`)
- [x] [03-01 为什么传统终端会闪烁？Virtual Screen Buffer 与差异化屏幕更新（Differential Updates）算法](03-pi-tui-engine/03-01-virtual-screen-and-diff-rendering.md)
- [x] [03-02 ANSI 转义序列动态合并、流式打字机与多行折叠面板实现](03-pi-tui-engine/03-02-ansi-batching-and-collapsible.md)

---

### 04. 🛡️ 第四篇：Gondolin 微虚拟机（Micro-VM）与物理沙箱
- [x] [04-01 软件权限拦截的局限与 Gondolin 基于 Micro-VM 的物理虚拟化硬隔离](04-gondolin-sandbox/04-01-micro-vm-hardware-isolation.md)
- [x] [04-02 供应链安全加固：Lockfile 校验与 `--ignore-scripts` 物理防御](04-gondolin-sandbox/04-02-supply-chain-hardening.md)

---

### 05. 🚀 第五篇：自主落地研发与生产级演进 (ai_home Integration)
- [x] [05-01 将 pi-tui 差量渲染算法与 ai_home WebUI xterm.js 双端打通](05-implementation/05-01-tui-parity-integration.md)
