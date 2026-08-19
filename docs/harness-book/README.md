# 《现代 AI Agent 运行时与 Harness 架构设计》
> **从五大主流工业级实现（Claude Code / OpenAI Codex / OpenCode / DeepSeek Harness / Pi Agent）深度源码解构到自主研发落地**

---

## 📖 书籍定位与愿景
本书旨在通过对当前工业界最顶尖的五大 AI 编程、长程推理与个人交互 Agent Harness 系统进行源码级、协议级和架构级的深度剖析，系统性地沉淀出一套完整的 **生产级 AI Agent 运行时与 Harness 架构设计规范**，并直接指导 `ai_home` 项目自主研发下一代高性能、多模型协同的 Agent Harness 运行时。

---


---

## 🚀 网页版 AI 沉浸式伴读阅读器 (Web & AI Interactive Reader)

本书已全量内置了一套基于现代化 Web 前端的 **沉浸式 AI 伴读阅读器**：
- **物理入口**：`docs/harness-book/reader/index.html`（支持浏览器直接双击打开，或通过 `aih` 本地服务访问）
- **核心特性**：
  1. **全景章节树与快速检索**：左侧内置 21 个小节完整的层级导航，支持实时模糊搜索；
  2. **Mermaid 状态机与代码原生高亮**：文章内所有 FSM 状态转换图、协议 JSON 载荷与 TypeScript/Go 源码全部原生渲染；
  3. **划词即问 (Highlight & Ask AI)**：阅读正文中遇到任何晦涩概念，直接鼠标划词即可一键唤起 AI 深度解析；
  4. **双接入模式 (AI Copilot)**：
     - **aih-server 极速直连**：默认自动连通本地 `http://127.0.0.1:9527` 统一网关，免配置 Key 即可享受最顶尖 Claude Opus / GPT-5.5 / DeepSeek 伴读解答；
     - **自定义 BYOK (Bring Your Own Key)**：支持随时在右上角设置中自定义接入任何兼容 OpenAI / Claude / DeepSeek 的 API 端点与 Key。

---

## 🗺️ 全景交互目录与章节进度

### 00. 前言与核心命题 (Introduction)
- [x] [00-01 为什么单纯封装 API 远远不够？Agent 运行时的核心壁垒与本质](00-intro/01-why-we-need-own-harness.md)

---

### 01. 📘 第一篇：Claude Code 架构深度解构 (Claude Code Dissection)
- [x] [01-01 ReAct 核心事件循环与状态机生命周期](01-claude-code/01-01-agent-react-loop.md)
- [x] [01-02 工具系统（Tools Protocol）、动态注入与执行沙箱](01-claude-code/01-02-tools-and-sandbox.md)
- [x] [01-03 上下文滑动窗口、自动压缩（Auto-Compaction）与 Token 预算](01-claude-code/01-03-context-compaction.md)
- [x] [01-04 多 Agent 协同编排：Fork 机制、Workflow 与并发隔离](01-claude-code/01-04-subagent-orchestration.md)
- [x] [01-05 双层自记忆系统（MEMORY.md + 语义 Frontmatter）与召回机制](01-claude-code/01-05-auto-memory-system.md)
- [x] [01-06 权限状态机（4 种模式）、Approval 审批流与安全策略拦截](01-claude-code/01-06-permission-state-machine.md)
- [x] [01-07 动态 Skills 系统、Slash Commands 与热插拔契约](01-claude-code/01-07-skills-and-slash-commands.md)

---

### 02. 📗 第二篇：OpenAI Codex CLI / App Server 解构 (OpenAI Codex Dissection)
- [x] [02-01 Stdio JSON-RPC App Server 架构与全双工事件总线](02-openai-codex/02-01-app-server-architecture.md)
- [x] [02-02 Responses API 协议契约、流式解包与工具调用桥接](02-openai-codex/02-02-responses-wire-protocol.md)
- [x] [02-03 线程持久化、JSONL 事件追溯与会话断点续传（Resume）](02-openai-codex/02-03-session-index-and-sqlite.md)
- [x] [02-04 多账号凭据投影、原生 auth.json 与环境隔离模型](02-openai-codex/02-04-managed-launch-and-isolation.md)

---

### 03. 📙 第三篇：OpenCode 架构深度解构 (OpenCode Dissection)
- [x] [03-01 插件化架构与双向 Hook 事件拦截流水线](03-opencode/03-01-plugin-and-hook-pipeline.md)
- [x] [03-02 SQLite 实体关系（opencode.db 会话/消息/用量归属模型）](03-opencode/03-02-sqlite-database-schema.md)
- [x] [03-03 Zen / Go 双端点路由设计与多 Provider 抽象层](03-opencode/03-03-dual-endpoint-routing.md)

---

### 04. 📕 第四篇：DeepSeek / 推理大模型 Harness 解构 (DeepSeek & Reasoning Harness)
- [x] [04-01 思考过程（`<think>` / `reasoning_content`）与正文流解耦及预算控制](04-deepseek-harness/04-01-thinking-stream-isolation.md)
- [x] [04-02 长推理 Trajectory 的自我修正、反思与工具交互循环](04-deepseek-harness/04-02-reasoning-trajectory-eval.md)
- [x] [04-03 极长推理上下文的剪枝策略与 KV Cache 亲和度优化](04-deepseek-harness/04-03-prompt-compression-budget.md)

---

### 05. 🔮 第五篇：Pi Agent 架构深度解构 (Pi Agent Dissection)
- [x] [05-01 极低延迟（Low-Latency）流式事件管道与双向即时打断机制](05-pi-agent/05-01-low-latency-streaming-and-interruption.md)
- [x] [05-02 动态 Persona 状态机、多模态情感对齐与对话心跳维持](05-pi-agent/05-02-persona-state-machine-and-heartbeat.md)
- [x] [05-03 层次化动态记忆图谱（Hierarchical Memory Graph）与用户画像建模](05-pi-agent/05-03-hierarchical-memory-graph.md)

---

### 06. 🚀 第六篇：自主 Agent Harness 架构蓝图与落地研发 (Self-Harness Blueprint)
- [x] [06-01 ai_home 下一代 Agent 运行时架构拓扑与分层原则](06-self-harness-design/06-01-ai-home-agent-architecture.md)
- [x] [06-02 跨 Provider 归一的统一事件循环状态机](06-self-harness-design/06-02-universal-event-loop.md)
- [x] [06-03 高性能插件化工具系统与跨 Agent 数据管道](06-self-harness-design/06-03-extensible-tool-framework.md)
- [x] [06-04 混合持久化记忆、上下文压缩与 Prompt Cache 亲和调度](06-self-harness-design/06-04-hybrid-memory-and-cache.md)
- [x] [06-05 PTY 终端与 WebUI 双端完全等价通信桥设计](06-self-harness-design/06-05-pty-and-webui-dual-parity.md)

---

## 🛠️ 撰写规范与验收标准
1. **极致深度**：杜绝泛泛而谈或纯概念拼凑，必须深入数据结构、消息协议、状态转换图、源码调用栈和边界异常；
2. **图文并茂**：关键流程必须配有清晰的 ASCII/Mermaid 时序图与状态跃迁图；
3. **学以致用**：每个解构小节末尾必须设立专门章节：**【对 ai_home 自主 Harness 研发的落地指导与架构设计】**；
4. **渐进交付**：每次触发只完成一个小节的高质量输出，并同步更新本 README 对应链接与状态。
