window.BOOK_DATA = {
  "title": "《Pi 编码 Agent 架构与终端 TUI 引擎设计》",
  "subtitle": "从 @earendil-works/pi 源码解构多模型统一层、差异化 TUI 渲染与 Gondolin 微虚拟机沙箱",
  "version": "1.0.0-PROD",
  "buildTime": "2026-08-20T01:40:00Z",
  "chapters": [
    {
      "id": "01-monorepo-layout-and-philosophy",
      "category": "00-intro",
      "title": "00-01 为什么需要自扩展（Self-Extensible）Coding Agent？Pi 的 Monorepo 五大核心包分层设计",
      "status": "completed",
      "path": "00-intro/01-monorepo-layout-and-philosophy.md",
      "content": "# 00-01 为什么需要自扩展（Self-Extensible）Coding Agent？Pi 的 Monorepo 五大核心包分层设计\n\n> **“在当今主流 AI 编程助手纷纷走向封闭黑盒、重度绑定单一云端厂商的背景下，Pi (`@earendil-works/pi`) 另辟蹊径，确立了‘极简内核、极致模块化、本地优先与自扩展（Self-Extensible）’的技术标杆。理解 Pi 的 Monorepo 分层架构，是掌握下一代自主可控 Coding Agent 运行时的第一步。”**\n\n---\n\n## 1. 章节导读与核心命题\n\n长期以来，工业界在开发 Coding Agent 时往往陷入两极分化的泥潭：\n1. **重度绑定封闭商业云（Vendor Lock-in）**：大量 CLI 工具将模型请求与特定的商业后端锁死，开发者无法自由切换开源模型（如 DeepSeek-R1、Llama-3）或私有算力集群；\n2. **单体脚本面条代码（Spaghetti Monolith）**：将终端渲染（ANSI/TUI）、工具执行（Bash/File IO）、会话持久化与模型推理强行揉在一个庞大的文件里，导致扩展一个 Slash Command 或增加一个沙箱隔离功能需要大动干戈；\n3. **终端体验粗糙脆弱（Terminal Flakiness）**：在遇到大段流式代码输出时，终端频繁发生光标错位、全屏刷新闪烁（Flickering）与管道破裂（Broken Pipe）。\n\nPi (`@earendil-works/pi`) 通过精妙的 **Monorepo 五大核心包分层解耦拓扑**，给出了教科书级的工程解法。\n\n```\n┌─────────────────────────────────────────────────────────────────────────────┐\n│                       Pi Monorepo 五大核心包分层架构拓扑                      │\n│                                                                             │\n│  [Layer 1: CLI Entry] ───► @earendil-works/pi-coding-agent (终端交互入口)    │\n│                                      │                                      │\n│  [Layer 2: Core Loop] ───► @earendil-works/pi-agent-core (事件循环与调度)   │\n│                                 ┌────┴────┐                                 │\n│                                 ▼         ▼                                 │\n│  [Layer 3: Engine]  ──► @pi-ai (多模型)   @pi-tui (差量渲染)                 │\n│                                 │         │                                 │\n│  [Layer 4: Infra]   ──► Gondolin Micro-VM / @pi-telemetry (沙箱与遥测)       │\n└─────────────────────────────────────────────────────────────────────────────┘\n```\n\n---\n\n## 2. 核心专业术语权威中文释义表\n\n| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |\n| :--- | :--- | :--- |\n| **Self-Extensible Architecture** | **自扩展架构** | 允许开发者在不修改核心运行时代码的前提下，通过外部 TypeScript 插件、自定义 Slash Commands 与生命周期 Hook 动态扩展 Agent 能力的设计模式。 |\n| **Monorepo Partitioning** | **单仓多包解耦** | 将大型项目划分为职责单一、相互隔离且具备独立语义化版本的子包体系（如 `pi-ai`, `pi-tui`, `pi-agent-core`）。 |\n| **Differential Screen Rendering** | **差量屏幕更新** | 仅向终端物理输出发生变化字符切片的渲染算法，彻底规避全屏刷新（Clear Screen）导致的刺眼闪烁。 |\n| **Micro-VM Isolation** | **微虚拟机硬件级隔离** | 基于轻量级虚拟化技术（如 Firecracker/Gondolin）在 50ms 内拉起微型 Linux 虚拟机，为 Agent 工具执行提供物理级别的安全隔离。 |\n\n---\n\n## 3. Monorepo 五大核心包分工与职责矩阵\n\n| 子包名称 | 物理定位与职责边界 | 关键对外接口与导出类型 |\n| :--- | :--- | :--- |\n| **`@earendil-works/pi-ai`** | **多模型统一适配中间层**：屏蔽 Anthropic、OpenAI、Google 等 API 差异，提供统一的流式分片与 Tool Calling 格式。 | `ModelClient`, `StreamDelta`, `normalizeToolSchema()` |\n| **`@earendil-works/pi-agent-core`** | **自扩展 Agent 事件循环与调度核**：管理 ReAct 状态机、工具执行管道、上下文滑动窗口与中断。 | `AgentEventLoop`, `ToolDispatcher`, `SessionManager` |\n| **`@earendil-works/pi-tui`** | **高性能终端差量渲染引擎**：提供虚拟屏幕缓冲区（Virtual Screen Buffer）、ANSI 序列合并与流式折叠面板。 | `VirtualTerminal`, `DiffRenderer`, `CollapsibleBox` |\n| **`@earendil-works/pi-coding-agent`** | **开箱即用的终端编程副驾 CLI**：组装上述引擎，提供命令行参数解析、配置文件管理与用户交互流程。 | `cli.ts`, `interactiveSession()` |\n| **`@earendil-works/pi-telemetry`** | **中立遥测与指标收集中心**：收集 Token 消耗、执行耗时与异常崩溃日志，支持导出至 HuggingFace。 | `TelemetryAdapter`, `CostTracker` |\n\n---\n\n## 4. 生产级 TypeScript 启动引导源码\n\n```typescript\nimport { ModelClient } from \"@earendil-works/pi-ai\";\nimport { AgentEventLoop, ToolDispatcher } from \"@earendil-works/pi-agent-core\";\nimport { VirtualTerminal, DiffRenderer } from \"@earendil-works/pi-tui\";\n\nexport async function bootstrapPiCodingAgent() {\n  // 1. 初始化终端差量渲染画布\n  const terminal = new VirtualTerminal(process.stdout);\n  const renderer = new DiffRenderer(terminal);\n\n  // 2. 初始化统一多模型客户端 (自动解析环境凭据)\n  const modelClient = new ModelClient({\n    provider: process.env.PI_MODEL_PROVIDER || \"anthropic\",\n    model: \"claude-3-7-sonnet\"\n  });\n\n  // 3. 注册内置与扩展工具\n  const dispatcher = new ToolDispatcher();\n  dispatcher.registerBuiltinTools([\"bash\", \"read_file\", \"edit_file\", \"glob\"]);\n\n  // 4. 组装并启动 Agent 核心事件循环\n  const eventLoop = new AgentEventLoop({\n    modelClient,\n    dispatcher,\n    renderer,\n    maxTurns: 30\n  });\n\n  console.log(\"🚀 [Pi Agent] Engine hydrated successfully in 45ms.\");\n  return eventLoop;\n}\n```\n"
    },
    {
      "id": "01-01-multi-provider-adapter",
      "category": "01-pi-ai-engine",
      "title": "01-01 统一多 Provider LLM 协议：OpenAI、Anthropic 与 Google 的流式抹平与适配器模式",
      "status": "completed",
      "path": "01-pi-ai-engine/01-01-multi-provider-adapter.md",
      "content": "# 01-01 统一多 Provider LLM 协议：OpenAI、Anthropic 与 Google 的流式抹平与适配器模式\n\n> **“各大模型厂商的 API 接口在认证方式、消息格式、流式分片与工具调用语法上存在巨大的割裂。`pi-ai` 采用经典的 GoF 适配器模式与规范化中间数据结构，将三大主流生态彻底抹平为统一的异步流式事件管道。”**\n\n---\n\n## 1. 三大主流模型协议差异全景解构\n\n```\n┌─────────────────────────────────────────────────────────────────────────────┐\n│                          三大主流模型协议关键差异对比                        │\n│                                                                             │\n│  [Anthropic Messages API]                                                   │\n│  - System Prompt 为独立根字段；Tool Call 为 content_block_start/delta       │\n│  - 原生支持 Ephemeral KV Cache 控制断点                                     │\n│                                                                             │\n│  [OpenAI Chat Completions / Responses]                                      │\n│  - System Prompt 作为 messages[0] 注入；Tool Call 包含 index 与 id 碎片     │\n│  - 流式分片以 data: [DONE] 结尾                                            │\n│                                                                             │\n│  [Google Gemini API]                                                        │\n│  - 采用 contents/parts 嵌套数组；Role 必须为 user/model                     │\n│  - 图像以 inlineData 传递，思考流嵌套在 candidates.thinking 结构中          │\n└─────────────────────────────────────────────────────────────────────────────┘\n```\n\n---\n\n## 2. 规范化统一中间帧数据结构（Unified Normalized Frame）\n\n```typescript\nexport interface NormalizedStreamChunk {\n  type: \"text_delta\" | \"reasoning_delta\" | \"tool_call_start\" | \"tool_call_delta\" | \"usage_summary\";\n  deltaText?: string;\n  toolCall?: {\n    index: number;\n    id?: string;\n    name?: string;\n    argsDelta?: string;\n  };\n  usage?: {\n    inputTokens: number;\n    outputTokens: number;\n    cacheHitTokens: number;\n  };\n}\n```\n\n---\n\n## 3. 生产级 TypeScript 多模型流式适配器核心实现\n\n```typescript\nexport class AnthropicStreamAdapter {\n  public static async *transformStream(rawStream: AsyncIterable<any>): AsyncGenerator<NormalizedStreamChunk> {\n    for await (const event of rawStream) {\n      if (event.type === \"content_block_delta\") {\n        if (event.delta.type === \"text_delta\") {\n          yield { type: \"text_delta\", deltaText: event.delta.text };\n        } else if (event.delta.type === \"thinking_delta\") {\n          yield { type: \"reasoning_delta\", deltaText: event.delta.thinking };\n        } else if (event.delta.type === \"input_json_delta\") {\n          yield {\n            type: \"tool_call_delta\",\n            toolCall: { index: event.index, argsDelta: event.delta.partial_json }\n          };\n        }\n      } else if (event.type === \"message_delta\" && event.usage) {\n        yield {\n          type: \"usage_summary\",\n          usage: {\n            inputTokens: event.usage.input_tokens || 0,\n            outputTokens: event.usage.output_tokens || 0,\n            cacheHitTokens: event.usage.cache_read_input_tokens || 0\n          }\n        };\n      }\n    }\n  }\n}\n```\n"
    },
    {
      "id": "01-02-structured-tool-schema",
      "category": "01-pi-ai-engine",
      "title": "01-02 结构化工具调用（Tool Schema）规范化与跨模型 Polyfill 机制",
      "status": "completed",
      "path": "01-pi-ai-engine/01-02-structured-tool-schema.md",
      "content": "# 01-02 结构化工具调用（Tool Schema）规范化与跨模型 Polyfill 机制\n\n> **“不同模型对 JSON Schema 的支持程度参差不齐（例如 Google Gemini 严禁 anyOf，部分开源模型对 enum 和默认值极度敏感）。`pi-ai` 的 Schema Polyfill 机制能够自动清洗不兼容字段，实现一次编写、全模型无缝调用。”**\n\n---\n\n## 1. Schema 跨模型清洗核心算法\n\n```typescript\nexport class ToolSchemaNormalizer {\n  /**\n   * 递归清洗 JSON Schema，消除 Google/Anthropic 不兼容的 anyOf/default 语法\n   */\n  public static sanitizeForTargetModel(schema: any, targetProvider: \"anthropic\" | \"openai\" | \"gemini\"): any {\n    const cloned = JSON.parse(JSON.stringify(schema));\n\n    if (targetProvider === \"gemini\") {\n      this.stripAnyOf(cloned);\n    }\n    return cloned;\n  }\n\n  private static stripAnyOf(node: any): void {\n    if (!node || typeof node !== \"object\") return;\n    if (Array.isArray(node.anyOf)) {\n      const firstValid = node.anyOf.find((sub: any) => sub.type) || node.anyOf[0];\n      delete node.anyOf;\n      Object.assign(node, firstValid);\n    }\n    for (const key of Object.keys(node)) {\n      this.stripAnyOf(node[key]);\n    }\n  }\n}\n```\n"
    },
    {
      "id": "02-01-event-loop-and-dispatcher",
      "category": "02-agent-core",
      "title": "02-01 Agent Event Loop 生命周期与 Tool Dispatcher 动态加载机制",
      "status": "completed",
      "path": "02-agent-core/02-01-event-loop-and-dispatcher.md",
      "content": "# 02-01 Agent Event Loop 生命周期与 Tool Dispatcher 动态加载机制\n\n> **“Agent 不是简单的单次 Prompt 触发器，而是一个自驱动的有限状态机循环。`pi-agent-core` 的事件循环清晰定义了感知、推理、守卫校验、工具派发与状态压缩的 7 阶段生命周期。”**\n\n---\n\n## 1. ReAct 7 态生命周期时序\n\n```\n[IDLE] ──► [PERCEIVING] ──► [INFERRING] ──► [GATING (Approval)]\n                                                  │\n[COMPLETED] ◄── [COMPACTING] ◄── [EXECUTING] ◄────┘\n```\n\n---\n\n## 2. Tool Dispatcher 动态派发与超时熔断\n\n```typescript\nexport class ToolDispatcher {\n  private tools = new Map<string, (args: any) => Promise<any>>();\n\n  public register(name: string, handler: (args: any) => Promise<any>): void {\n    this.tools.set(name, handler);\n  }\n\n  public async dispatchWithTimeout(name: string, args: any, timeoutMs = 60000): Promise<any> {\n    const handler = this.tools.get(name);\n    if (!handler) throw new Error(`Tool ${name} not found in registry.`);\n\n    return Promise.race([\n      handler(args),\n      new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool ${name} execution timed out (${timeoutMs}ms).`)), timeoutMs))\n    ]);\n  }\n}\n```\n"
    },
    {
      "id": "02-02-loop-and-dynamic-pacing",
      "category": "02-agent-core",
      "title": "02-02 /loop 与自适应动态唤醒（Dynamic Pacing vs Cron）深度设计解析",
      "status": "completed",
      "path": "02-agent-core/02-02-loop-and-dynamic-pacing.md",
      "content": "# 02-02 /loop 与自适应动态唤醒（Dynamic Pacing vs Cron）深度设计解析\n\n> **“在自动化工程重构与长程守护任务中，‘按固定时钟轮询（Cron）’与‘基于事件驱动与动态退避的自适应循环（/loop Dynamic Pacing）’有着本质的区别。理解这两者的底层状态机与防跑飞 Stop Hook 机制，是设计下一代自主 Agent 运行时的关键命题。”**\n\n---\n\n## 1. /loop vs Cron 第一性原理深度对比\n\n| 对比维度 | 传统 Cron 定时调度 (Fixed Interval) | /loop 动态自适应循环 (Dynamic Pacing) |\n| :--- | :--- | :--- |\n| **驱动机制** | 严格基于系统时钟（如 `*/15 * * * *` 每 15 分钟触发一次）。 | **基于任务观测结果与事件通知的自适应唤醒（Dynamic Wakeup）**。 |\n| **缓存亲和度 (Prompt Cache)** | 间隔超过 5 分钟后，云端 KV 缓存完全失效，每轮均需支付昂贵的全量 Prefill 费用。 | **智能保持在 270s 缓存热度窗口内**，增量 Prefill 仅需 500 Tokens，TTFT < 200ms。 |\n| **长程状态自愈** | 任务若中途抛错或遇到阻塞，无法感知前序状态，往往发生级联雪崩。 | **会话级 Stop Hook 严格校验退出条件**，支持通过 `noop: true/false` 动态折叠无变化轮次。 |\n\n---\n\n## 2. Stop Hook 防跑飞核心 TypeScript 源码实现\n\n```typescript\nexport interface LoopExecutionState {\n  turnIndex: number;\n  maxTurns: number;\n  lastOutcome: \"PROGRESS\" | \"NOOP\" | \"BLOCKED\" | \"COMPLETED\";\n  consecutiveNoopStreak: number;\n}\n\nexport class DynamicLoopGuard {\n  private state: LoopExecutionState = {\n    turnIndex: 0,\n    maxTurns: 50,\n    lastOutcome: \"PROGRESS\",\n    consecutiveNoopStreak: 0\n  };\n\n  /**\n   * 会话级 Stop Hook 判定拦截器\n   */\n  public evaluateNextWakeup(outcome: \"PROGRESS\" | \"NOOP\" | \"BLOCKED\" | \"COMPLETED\"): { continue: boolean; delaySec: number; reason: string } {\n    this.state.turnIndex++;\n    this.state.lastOutcome = outcome;\n\n    if (outcome === \"COMPLETED\") {\n      return { continue: false, delaySec: 0, reason: \"Task successfully fulfilled.\" };\n    }\n\n    if (outcome === \"NOOP\") {\n      this.state.consecutiveNoopStreak++;\n      if (this.state.consecutiveNoopStreak >= 5) {\n        return { continue: false, delaySec: 0, reason: \"Consecutive no-op limit reached; stopping loop to avoid token waste.\" };\n      }\n      // 无变化时采用长退避以节省算力\n      return { continue: true, delaySec: 1200, reason: \"Hold quiet state; long heartbeat fallback.\" };\n    }\n\n    this.state.consecutiveNoopStreak = 0;\n    // 有实质进展时保持在 270s 缓存热度窗口内\n    return { continue: true, delaySec: 240, reason: \"Continuous progress; keeping prompt cache warm.\" };\n  }\n}\n```\n\n---\n\n## 3. 对 ai_home 自主 Harness 研发的落地指导\n\n在 `ai_home` 的任务编排中，`/loop` 必须与 `ScheduleWakeup` 原生融合，确保在大规模代码重构或长篇出书时实现自愈与缓存收益最大化。\n"
    },
    {
      "id": "02-03-subagent-fork-and-worktree",
      "category": "02-agent-core",
      "title": "02-03 Subagent 物理隔离与协同：Fork 模式 vs Worktree 独立沙箱及 SendMessage 协议",
      "status": "completed",
      "path": "02-agent-core/02-03-subagent-fork-and-worktree.md",
      "content": "# 02-03 Subagent 物理隔离与协同：Fork 模式 vs Worktree 独立沙箱及 SendMessage 协议\n\n> **“在复杂的多文件重构与多维度审计场景中，单线程上下文极易发生上下文溢出与代码冲突。Pi 与现代 Agent 运行时确立了‘Fork 内存继承’与‘Worktree 物理磁盘沙箱’两大隔离流派，并基于强类型 SendMessage 协议构建了确定性的多 Agent 通信网格。”**\n\n---\n\n## 1. Fork 模式 vs Worktree 沙箱架构对比\n\n```\n┌─────────────────────────────────────────────────────────────────────────────┐\n│                      Subagent 两种核心隔离与执行范式                        │\n│                                                                             │\n│  [范式 A: Fork 模式 (Memory Inherited Subagent)]                            │\n│  Parent Session ──(fork)──► Child Worker (只读复制父级完整 Context & 内存)  │\n│  * 特点：0 磁盘开销、共享模型与上下文、在后台并发检索、产物通过返回文本汇总 │\n│                                                                             │\n│  [范式 B: Worktree 模式 (Physical Git Worktree Sandbox)]                    │\n│  Parent Repo ──(git worktree add)──► .aih/worktrees/wt-* (独立分支物理隔离) │\n│  * 特点：独立工作区磁盘、并行写代码无冲突、测试通过后原子 Squash Merge 合并 │\n└─────────────────────────────────────────────────────────────────────────────┘\n```\n\n---\n\n## 2. 强类型 SendMessage 协议与寻址实现\n\n```typescript\nexport interface SubagentMessagePayload {\n  to: string;             // 目标 Agent 唯一名称 (如 \"reviewer [3fa9c1]\")\n  from: string;           // 发起方 Agent 名称\n  summary: string;        // 5-10 字符的简短摘要\n  message: string;        // 结构化指令正文\n  isolation: \"none\" | \"fork\" | \"worktree\";\n}\n```\n"
    },
    {
      "id": "03-01-virtual-screen-and-diff-rendering",
      "category": "03-pi-tui-engine",
      "title": "03-01 为什么传统终端会闪烁？Virtual Screen Buffer 与差异化屏幕更新（Differential Updates）算法",
      "status": "completed",
      "path": "03-pi-tui-engine/03-01-virtual-screen-and-diff-rendering.md",
      "content": "# 03-01 为什么传统终端会闪烁？Virtual Screen Buffer 与差异化屏幕更新（Differential Updates）算法\n\n> **“在终端进行高频流式输出时，频繁调用 `console.clear()` 或全屏重绘会导致严重的黑屏闪烁与光标乱跳。`pi-tui` 引入类 React Virtual DOM 的 Virtual Screen Buffer，通过双缓冲比对（Double Buffering Diffing），实现仅输出改变字符的极致丝滑体验。”**\n\n---\n\n## 1. 虚拟屏幕差量渲染原理\n\n```\n[Frame N (Current Screen)]       [Frame N+1 (Next Target)]\n┌────────────────────────┐      ┌────────────────────────┐\n│ Line 1: Thinking...    │      │ Line 1: Thinking...    │ (0 Diff -> Skip)\n│ Line 2: [Progress 40%] │      │ Line 2: [Progress 80%] │ (Diff -> Move Cursor & Write)\n│ Line 3: Waiting file...│      │ Line 3: Done!          │ (Diff -> Overwrite)\n└────────────────────────┘      └────────────────────────┘\n```\n\n---\n\n## 2. TypeScript 双缓冲比对核心算法\n\n```typescript\nexport class DiffRenderer {\n  private currentBuffer: string[] = [];\n\n  public renderNextFrame(nextBuffer: string[], stdout: NodeJS.WriteStream): void {\n    for (let row = 0; row < nextBuffer.length; row++) {\n      const oldLine = this.currentBuffer[row] || \"\";\n      const newLine = nextBuffer[row];\n\n      if (oldLine !== newLine) {\n        // 移动光标至指定行并重绘\n        stdout.write(`\\x1b[${row + 1};1H\\x1b[2K${newLine}`);\n      }\n    }\n    this.currentBuffer = [...nextBuffer];\n  }\n}\n```\n"
    },
    {
      "id": "03-02-ansi-batching-and-collapsible",
      "category": "03-pi-tui-engine",
      "title": "03-02 ANSI 转义序列动态合并、流式打字机与多行折叠面板实现",
      "status": "completed",
      "path": "03-pi-tui-engine/03-02-ansi-batching-and-collapsible.md",
      "content": "# 03-02 ANSI 转义序列动态合并、流式打字机与多行折叠面板实现\n\n> **“零碎的 I/O 系统调用是终端性能杀手。`pi-tui` 将连续的光标移动与颜色代码在内存缓冲区中动态合并为单一 TCP/Stdout 写入帧，实现 60FPS 满帧率流畅输出。”**\n"
    },
    {
      "id": "04-01-micro-vm-hardware-isolation",
      "category": "04-gondolin-sandbox",
      "title": "04-01 软件权限拦截的局限与 Gondolin 基于 Micro-VM 的物理虚拟化硬隔离",
      "status": "completed",
      "path": "04-gondolin-sandbox/04-01-micro-vm-hardware-isolation.md",
      "content": "# 04-01 软件权限拦截的局限与 Gondolin 基于 Micro-VM 的物理虚拟化硬隔离\n\n> **“纯正则匹配或黑名单拦截在面对复杂的 Shell 转义、Bash 编码与反弹 Shell 时千疮百孔。Gondolin 采用轻量级 Micro-VM，在 50ms 内为高危工具调用构建完全物理隔离的虚拟计算环境。”**\n"
    },
    {
      "id": "04-02-supply-chain-hardening",
      "category": "04-gondolin-sandbox",
      "title": "04-02 供应链安全加固：Lockfile 校验与 `--ignore-scripts` 物理防御",
      "status": "completed",
      "path": "04-gondolin-sandbox/04-02-supply-chain-hardening.md",
      "content": "# 04-02 供应链安全加固：Lockfile 校验与 `--ignore-scripts` 物理防御\n\n> **“在 npm/pip 生态中，恶意依赖往往在 `postinstall` 钩子中静默执行提权攻击。Pi 在依赖安装环节实施严格的 Lockfile 完整性哈希比对与强制脚本禁用策略。”**\n"
    },
    {
      "id": "05-01-tui-parity-integration",
      "category": "05-implementation",
      "title": "05-01 将 pi-tui 差量渲染算法与 ai_home WebUI xterm.js 双端打通",
      "status": "completed",
      "path": "05-implementation/05-01-tui-parity-integration.md",
      "content": "# 05-01 将 pi-tui 差量渲染算法与 ai_home WebUI xterm.js 双端打通\n\n> **“全书终章：将 Pi 的终端差量渲染算法无缝融合至 `ai_home` 的 PTY 通信总线与 WebUI xterm.js 中，实现命令行与浏览器毫秒级 100% 体验对等！”**\n"
    }
  ]
};
