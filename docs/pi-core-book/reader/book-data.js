window.BOOK_DATA = {
  "title": "《Pi 编码 Agent 架构与终端 TUI 引擎设计》",
  "subtitle": "从 @earendil-works/pi 源码解构多模型统一层、差异化 TUI 渲染与 Gondolin 微虚拟机沙箱",
  "version": "1.0.0-PROD",
  "buildTime": "2026-08-19T17:10:28.207Z",
  "themeStyle": "tui-hacker",
  "coverImage": "/docs/pi-core-book/assets/images/cover-pi-core-book.jpg",
  "chapters": [
    {
      "id": "01-monorepo-layout-and-philosophy",
      "category": "00. 架构概览与设计哲学 (Architecture & Monorepo Layout)",
      "title": "00-01 为什么需要自扩展（Self-Extensible）Coding Agent？Pi 的 Monorepo 五大核心包分层设计",
      "status": "completed",
      "path": "00-intro/01-monorepo-layout-and-philosophy.md",
      "content": "# 00-01 为什么需要自扩展（Self-Extensible）Coding Agent？Pi 的 Monorepo 五大核心包分层设计\n\n> **“Pi 的核心哲学在于‘极小内核，无限扩展’。通过将底层 LLM 适配、事件循环、终端渲染、安全沙箱与遥测体系严格拆解为 5 大解耦模块，开发者可以如同搭积木般将其组装为属于自己的终端副驾。”**\n"
    },
    {
      "id": "01-01-multi-provider-adapter",
      "category": "01. 🌐 第一篇：多模型统一层与抽象中枢 (`pi-ai`)",
      "title": "01-01 统一多 Provider LLM 协议：OpenAI、Anthropic 与 Google 的流式抹平与适配器模式",
      "status": "completed",
      "path": "01-pi-ai-engine/01-01-multi-provider-adapter.md",
      "content": "# 01-01 统一多 Provider LLM 协议：OpenAI、Anthropic 与 Google 的流式抹平与适配器模式\n"
    },
    {
      "id": "01-02-structured-tool-schema",
      "category": "01. 🌐 第一篇：多模型统一层与抽象中枢 (`pi-ai`)",
      "title": "01-02 结构化工具调用（Tool Schema）规范化与跨模型 Polyfill 机制",
      "status": "completed",
      "path": "01-pi-ai-engine/01-02-structured-tool-schema.md",
      "content": "# 01-02 结构化工具调用（Tool Schema）规范化与跨模型 Polyfill 机制\n"
    },
    {
      "id": "02-01-event-loop-and-dispatcher",
      "category": "02. ⚡ 第二篇：自扩展 Agent 事件循环与调度核 (`pi-agent-core`)",
      "title": "02-01 Agent Event Loop 生命周期与 Tool Dispatcher 动态加载机制",
      "status": "completed",
      "path": "02-agent-core/02-01-event-loop-and-dispatcher.md",
      "content": "# 02-01 Agent Event Loop 生命周期与 Tool Dispatcher 动态加载机制\n"
    },
    {
      "id": "02-02-loop-and-dynamic-pacing",
      "category": "02. ⚡ 第二篇：自扩展 Agent 事件循环与调度核 (`pi-agent-core`)",
      "title": "02-02 /loop 与自适应动态唤醒（Dynamic Pacing vs Cron）深度设计解析",
      "status": "completed",
      "path": "02-agent-core/02-02-loop-and-dynamic-pacing.md",
      "content": "# 02-02 /loop 与自适应动态唤醒（Dynamic Pacing vs Cron）深度设计解析\n\n> **“在自动化工程重构与长程守护任务中，‘按固定时钟轮询（Cron）’与‘基于事件驱动与动态退避的自适应循环（/loop Dynamic Pacing）’有着本质的区别。理解这两者的底层状态机与防跑飞 Stop Hook 机制，是设计下一代自主 Agent 运行时的关键命题。”**\n\n---\n\n## 1. /loop vs Cron 第一性原理深度对比\n\n| 对比维度 | 传统 Cron 定时调度 (Fixed Interval) | /loop 动态自适应循环 (Dynamic Pacing) |\n| :--- | :--- | :--- |\n| **驱动机制** | 严格基于系统时钟（如 `*/15 * * * *` 每 15 分钟触发一次）。 | **基于任务观测结果与事件通知的自适应唤醒（Dynamic Wakeup）**。 |\n| **缓存亲和度 (Prompt Cache)** | 间隔超过 5 分钟后，云端 KV 缓存完全失效，每轮均需支付昂贵的全量 Prefill 费用。 | **智能保持在 270s 缓存热度窗口内**，增量 Prefill 仅需 500 Tokens，TTFT < 200ms。 |\n| **长程状态自愈** | 任务若中途抛错或遇到阻塞，无法感知前序状态，往往发生级联雪崩。 | **会话级 Stop Hook 严格校验退出条件**，支持通过 `noop: true/false` 动态折叠无变化轮次。 |\n\n---\n\n## 2. Stop Hook 防跑飞核心 TypeScript 源码实现\n\n```typescript\nexport interface LoopExecutionState {\n  turnIndex: number;\n  maxTurns: number;\n  lastOutcome: \"PROGRESS\" | \"NOOP\" | \"BLOCKED\" | \"COMPLETED\";\n  consecutiveNoopStreak: number;\n}\n\nexport class DynamicLoopGuard {\n  private state: LoopExecutionState = {\n    turnIndex: 0,\n    maxTurns: 50,\n    lastOutcome: \"PROGRESS\",\n    consecutiveNoopStreak: 0\n  };\n\n  /**\n   * 会话级 Stop Hook 判定拦截器\n   */\n  public evaluateNextWakeup(outcome: \"PROGRESS\" | \"NOOP\" | \"BLOCKED\" | \"COMPLETED\"): { continue: boolean; delaySec: number; reason: string } {\n    this.state.turnIndex++;\n    this.state.lastOutcome = outcome;\n\n    if (outcome === \"COMPLETED\") {\n      return { continue: false, delaySec: 0, reason: \"Task successfully fulfilled.\" };\n    }\n\n    if (outcome === \"NOOP\") {\n      this.state.consecutiveNoopStreak++;\n      if (this.state.consecutiveNoopStreak >= 5) {\n        return { continue: false, delaySec: 0, reason: \"Consecutive no-op limit reached; stopping loop to avoid token waste.\" };\n      }\n      // 无变化时采用长退避以节省算力\n      return { continue: true, delaySec: 1200, reason: \"Hold quiet state; long heartbeat fallback.\" };\n    }\n\n    this.state.consecutiveNoopStreak = 0;\n    // 有实质进展时保持在 270s 缓存热度窗口内\n    return { continue: true, delaySec: 240, reason: \"Continuous progress; keeping prompt cache warm.\" };\n  }\n}\n```\n\n---\n\n## 3. 对 ai_home 自主 Harness 研发的落地指导\n\n在 `ai_home` 的任务编排中，`/loop` 必须与 `ScheduleWakeup` 原生融合，确保在大规模代码重构或长篇出书时实现自愈与缓存收益最大化。\n"
    },
    {
      "id": "02-03-subagent-fork-and-worktree",
      "category": "02. ⚡ 第二篇：自扩展 Agent 事件循环与调度核 (`pi-agent-core`)",
      "title": "02-03 Subagent 物理隔离与协同：Fork 模式 vs Worktree 独立沙箱及 SendMessage 协议",
      "status": "completed",
      "path": "02-agent-core/02-03-subagent-fork-and-worktree.md",
      "content": "# 02-03 Subagent 物理隔离与协同：Fork 模式 vs Worktree 独立沙箱及 SendMessage 协议\n\n> **“在复杂的多文件重构与多维度审计场景中，单线程上下文极易发生上下文溢出与代码冲突。Pi 与现代 Agent 运行时确立了‘Fork 内存继承’与‘Worktree 物理磁盘沙箱’两大隔离流派，并基于强类型 SendMessage 协议构建了确定性的多 Agent 通信网格。”**\n\n---\n\n## 1. Fork 模式 vs Worktree 沙箱架构对比\n\n```\n┌─────────────────────────────────────────────────────────────────────────────┐\n│                      Subagent 两种核心隔离与执行范式                        │\n│                                                                             │\n│  [范式 A: Fork 模式 (Memory Inherited Subagent)]                            │\n│  Parent Session ──(fork)──► Child Worker (只读复制父级完整 Context & 内存)  │\n│  * 特点：0 磁盘开销、共享模型与上下文、在后台并发检索、产物通过返回文本汇总 │\n│                                                                             │\n│  [范式 B: Worktree 模式 (Physical Git Worktree Sandbox)]                    │\n│  Parent Repo ──(git worktree add)──► .aih/worktrees/wt-* (独立分支物理隔离) │\n│  * 特点：独立工作区磁盘、并行写代码无冲突、测试通过后原子 Squash Merge 合并 │\n└─────────────────────────────────────────────────────────────────────────────┘\n```\n\n---\n\n## 2. 强类型 SendMessage 协议与寻址实现\n\n```typescript\nexport interface SubagentMessagePayload {\n  to: string;             // 目标 Agent 唯一名称 (如 \"reviewer [3fa9c1]\")\n  from: string;           // 发起方 Agent 名称\n  summary: string;        // 5-10 字符的简短摘要\n  message: string;        // 结构化指令正文\n  isolation: \"none\" | \"fork\" | \"worktree\";\n}\n```\n"
    },
    {
      "id": "03-01-virtual-screen-and-diff-rendering",
      "category": "03. 🖥️ 第三篇：终端 TUI 差量渲染引擎 (`pi-tui`)",
      "title": "03-01 为什么传统终端会闪烁？Virtual Screen Buffer 与差异化屏幕更新（Differential Updates）算法",
      "status": "completed",
      "path": "03-pi-tui-engine/03-01-virtual-screen-and-diff-rendering.md",
      "content": "# 03-01 为什么传统终端会闪烁？Virtual Screen Buffer 与差异化屏幕更新（Differential Updates）算法\n"
    },
    {
      "id": "03-02-ansi-batching-and-collapsible",
      "category": "03. 🖥️ 第三篇：终端 TUI 差量渲染引擎 (`pi-tui`)",
      "title": "03-02 ANSI 转义序列动态合并、流式打字机与多行折叠面板实现",
      "status": "completed",
      "path": "03-pi-tui-engine/03-02-ansi-batching-and-collapsible.md",
      "content": "# 03-02 ANSI 转义序列动态合并、流式打字机与多行折叠面板实现\n"
    },
    {
      "id": "04-01-micro-vm-hardware-isolation",
      "category": "04. 🛡️ 第四篇：Gondolin 微虚拟机（Micro-VM）与物理沙箱",
      "title": "04-01 软件权限拦截的局限与 Gondolin 基于 Micro-VM 的物理虚拟化硬隔离",
      "status": "completed",
      "path": "04-gondolin-sandbox/04-01-micro-vm-hardware-isolation.md",
      "content": "# 04-01 软件权限拦截的局限与 Gondolin 基于 Micro-VM 的物理虚拟化硬隔离\n"
    },
    {
      "id": "04-02-supply-chain-hardening",
      "category": "04. 🛡️ 第四篇：Gondolin 微虚拟机（Micro-VM）与物理沙箱",
      "title": "04-02 供应链安全加固：Lockfile 校验与 `--ignore-scripts` 物理防御",
      "status": "completed",
      "path": "04-gondolin-sandbox/04-02-supply-chain-hardening.md",
      "content": "# 04-02 供应链安全加固：Lockfile 校验与 `--ignore-scripts` 物理防御\n"
    },
    {
      "id": "05-01-tui-parity-integration",
      "category": "05. 🚀 第五篇：自主落地研发与生产级演进 (ai_home Integration)",
      "title": "05-01 将 pi-tui 差量渲染算法与 ai_home WebUI xterm.js 双端打通",
      "status": "completed",
      "path": "05-implementation/05-01-tui-parity-integration.md",
      "content": "# 05-01 将 pi-tui 差量渲染算法与 ai_home WebUI xterm.js 双端打通\n"
    }
  ]
};
