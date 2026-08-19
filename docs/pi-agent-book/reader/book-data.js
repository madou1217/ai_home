window.BOOK_DATA = {
  "title": "《Agent Pi：全双工实时流式架构与拟人情感引擎设计》",
  "subtitle": "Inflection Pi 拟人化流式管道、Barge-in 即时打断、动态 Persona 状态机与 HMG 记忆图谱",
  "version": "1.0.0-PROD",
  "buildTime": "2026-08-19T15:51:33.561Z",
  "coverImage": "/docs/pi-agent-book/assets/images/cover-pi-agent-book.jpg",
  "chapters": [
    {
      "id": "01-philosophy-of-pi-agent",
      "category": "00. 前言与设计哲学 (Introduction & Philosophy)",
      "title": "00-01 从“冷冰冰的问答工具”到“全双工长情伴侣”：Agent Pi 的拟人化设计哲学",
      "status": "completed",
      "path": "00-intro/01-philosophy-of-pi-agent.md",
      "content": "# 00-01 从“冷冰冰的问答工具”到“全双工长情伴侣”：Agent Pi 的拟人化设计哲学\n\n> **“在绝大多数大语言模型被设计为‘等候指令、一次性输出、冰冷交付’的生产力工具时，Inflection Pi (Agent Pi) 另辟蹊径，开创了‘全双工流式倾听、毫秒即时响应、动态情绪共鸣与长期生命周期陪伴’的拟人化交互范式。理解 Pi 的哲学，是理解下一代人机共生界面的关键起点。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/00-01-pi-philosophy.jpg\" alt=\"从问答工具到长情伴侣：Agent Pi 拟人交互设计哲学\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 从问答工具到长情伴侣：Agent Pi 拟人交互设计哲学 (Philosophy of Agent Pi)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 章节导读与核心命题\n\n过去几年中，生成式 AI 的主流发展方向始终被“生产力工具（Utility & Productivity）”所统治：\n- **典型代表**：ChatGPT、Claude、GitHub Copilot、Cursor；\n- **交互模式**：严格的**单向回合制请求/响应（Turn-based Request-Response）**。用户输入 Prompt ➔ 服务端等待排队 ➔ 大模型全量生成 ➔ 客户端被动接收。\n\n这种模式在编写代码、总结长文档和分析报表时极为高效，但在**个人日常陪伴、情感倾听、头脑风暴与口语化沟通**场景下，暴露出了三个根本性缺陷：\n1. **迟钝感（High Latency & Blocking）**：用户说话时模型无法打断，模型说话时用户必须干等，缺乏人类真实对话中毫秒级的肢体与声音微反馈；\n2. **冰冷感（Emotional Flatness）**：无论用户处于喜悦、焦虑还是悲伤，模型始终维持千篇一律的客观中立与说教语调；\n3. **失忆感（Amnesia & Statelessness）**：会话关闭即失忆，无法像一位真正认识你数年的挚友一样，自然串联起你在数周前随口提及的情感琐事与人生规划。\n\n**Inflection Pi** 的横空出世，彻底打破了这一桎梏。\n\n```\n┌─────────────────────────────────────────────────────────────────────────────┐\n│                          传统问答 Agent vs Agent Pi 交互范式对比            │\n│                                                                             │\n│  [传统问答 Agent] (Turn-Based Cold Utility)                                │\n│  User ───────(发送 Prompt)───────► Model (排队推理 2~5s) ──(一次性交付)──► │\n│  * 纯文本说教 / 冰冷中立 / 单向等待 / 静态上下文窗口                        │\n│                                                                             │\n│  [Agent Pi 伴侣] (Full-Duplex Warm Companion)                               │\n│  User ◄═════(全双工毫秒流 / Barge-in 打断 / 情感共振)═════► Agent Pi        │\n│  * 毫秒低延迟 (TTFT < 120ms) / 动态 Persona 状态机 / 层次化动态记忆图谱     │\n└─────────────────────────────────────────────────────────────────────────────┘\n```\n\n---\n\n## 2. 核心专业术语与概念精确释义\n\n| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |\n| :--- | :--- | :--- |\n| **Full-Duplex Interaction** | **全双工交互** | 客户端与服务端在同一物理信道上同时进行双向并发数据传输，允许双方在任何时刻同时发声与倾听。 |\n| **Barge-in / Interruption** | **即时打断 / 插入** | 用户在 Agent 正在流式输出内容时突发插入声音或文字，Harness 需在 50ms 内完成流式排空并原子重置状态机。 |\n| **Persona State Machine** | **动态人设状态机** | 基于情感张量（VAD 模型）动态调整 Agent 语调、同理心深度与表达修辞的有限状态机。 |\n| **Hierarchical Memory Graph (HMG)** | **层次化动态记忆图谱** | 将记忆解耦为永恒核心画像（Core）、关系实体网络（Semantic）与情境事件流（Episodic）的三层存储模型。 |\n| **Prosody & Pacing Control** | **韵律与节奏控制** | 在流式生成过程中智能注入拟人化微停顿（Hesitation）、语气助词与标点符号，模拟真实人类思维节奏。 |\n\n---\n\n## 3. Agent Pi 五大底层架构支柱\n\n```\n                       ┌──────────────────────────────────────────────┐\n                       │           Agent Pi 全双工拟人化架构中枢       │\n                       └──────────────────────┬───────────────────────┘\n                                              │\n        ┌───────────────────────┬─────────────┴─────────┬───────────────────────┐\n        ▼                       ▼                       ▼                       ▼\n  【全双工极低延迟管道】   【Barge-in 即时打断】   【动态 Persona 状态机】   【层次化记忆图谱 HMG】\n  - TTFT < 120ms 优化     - 50ms 级流式排空      - VAD 情感张量量化        - Core/Semantic/Episodic\n  - WebSocket 二进制帧    - 原子取消 Token 消费   - 语气词与微停顿注入      - 艾宾浩斯记忆强化衰减\n```\n\n---\n\n## 4. 对 ai_home 拟人伴读与创作工坊的落地指导与架构设计\n\n在 `ai_home` 项目中落地 Pi Agent 的设计哲学与技术架构时，必须重点实现以下三大模块：\n1. **全双工流式伴读通道**：在电子书阅读器与 Web 控制台中，支持免阻塞实时 AI 伴读；\n2. **多模式灵感创作工坊**：将知识书架、AI 生图与全双工对话有机融为一体；\n3. **长期用户画像与认知记忆**：使 Harness 能够记住用户的阅读进度、写作风格与知识偏好。\n"
    },
    {
      "id": "01-01-websocket-wire-protocol",
      "category": "01. ⚡ 第一篇：全双工极低延迟流式管道与打断机制 (Full-Duplex Streaming & Barge-in)",
      "title": "01-01 全双工 WebSocket 帧协议设计与 TTFT < 120ms 极致优化",
      "status": "completed",
      "path": "01-streaming-pipeline/01-01-websocket-wire-protocol.md",
      "content": "# 01-01 全双工 WebSocket 帧协议设计与 TTFT < 120ms 极致优化\n\n> **“在实时拟人对话场景下，网络延迟每增加 100ms，用户的‘机器感’就会呈指数级攀升。Agent Pi 的通信底层抛弃了传统的 HTTP 一问一答机制，构建在自定义的二进制/JSON-RPC 混合 WebSocket 全双工流式帧协议之上，结合上游算力预热与零拷贝分发，实现了首字时间（TTFT）稳定压入 120ms 以内的工业级奇迹。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/01-01-pi-websocket-wire.jpg\" alt=\"全双工 WebSocket 协议与毫秒级流式分片管道\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 全双工 WebSocket 协议与毫秒级流式分片管道 (Full-Duplex Wire Protocol)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 章节导读与核心命题\n\n为什么传统的 HTTP SSE（Server-Sent Events）在个人拟人化 Agent 场景下捉襟见肘？\n1. **单向信道限制**：SSE 只支持服务端向客户端单向推送，客户端要上报任何打断、击键或语音事件，必须另起独立的 HTTP POST 请求，带来额外的 TCP/TLS 握手与请求头开销；\n2. **连接状态脱节**：HTTP 请求的多路复用难以实现双向时钟与时序的完全一致，当服务端正在拼命推流时，无法感知客户端是否早已关闭扬声器。\n\n本节系统解构 Agent Pi 专用的全双工 WebSocket Wire 协议标准、帧类型定义、基于 Radix Tree 的前缀缓存预热机制以及实现 TTFT < 120ms 的核心工程落地。\n\n---\n\n## 2. 核心专业术语与概念精确释义\n\n| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |\n| :--- | :--- | :--- |\n| **Full-Duplex WebSocket** | **全双工 WebSocket** | 基于单个持久 TCP 连接建立的双向实时信道，支持客户端与服务端以极低开销并发发送二进制/文本帧。 |\n| **TTFT (Time To First Token)** | **首字输出延迟** | 从用户完成语音/文字输入并松开按键，到客户端屏幕或扬声器接收并渲染出第一个 Token 的物理时间间隔。 |\n| **Audio-Text Demuxing** | **音文解复用分片** | 将上游模型产出的文本 Token 流与流式 TTS 引擎产出的 PCM/Opus 音频切片在同一时序轴上进行微秒级对齐。 |\n| **Pre-warm Speculative Prefill** | **前置推测预热** | 当感知到用户输入停顿或语音 VAD 触发时，提前在上游大模型节点加载静态前缀与记忆图谱，消除冷启动时间。 |\n\n---\n\n## 3. 全双工通信帧协议定义（Wire Protocol Schema）\n\n```json\n{\n  \"type\": \"agent_stream_frame\",\n  \"sessionId\": \"pi_sess_982341\",\n  \"turnId\": 14,\n  \"seq\": 108,\n  \"timestamp\": 1787154200120,\n  \"payload\": {\n    \"kind\": \"delta_token\",\n    \"text\": \"其实\",\n    \"prosody\": {\n      \"pauseMs\": 60,\n      \"pitch\": \"warm_soft\"\n    },\n    \"vadState\": {\n      \"valence\": 0.72,\n      \"arousal\": 0.45,\n      \"dominance\": 0.50\n    }\n  }\n}\n```\n\n---\n\n## 4. TypeScript 全双工流式分发器生产级源码\n\n```typescript\nexport interface PiStreamFrame {\n  type: \"token_delta\" | \"audio_chunk\" | \"interruption_ack\" | \"heartbeat\";\n  sessionId: string;\n  seq: number;\n  data: any;\n}\n\nexport class PiStreamingDispatcher {\n  private seqCounter = 0;\n\n  constructor(private ws: WebSocket) {}\n\n  public emitTokenDelta(sessionId: string, text: string, vad: any): void {\n    const frame: PiStreamFrame = {\n      type: \"token_delta\",\n      sessionId,\n      seq: ++this.seqCounter,\n      data: { text, vad, time: Date.now() }\n    };\n    this.ws.send(JSON.stringify(frame));\n  }\n}\n```\n\n---\n\n## 5. 对 ai_home 自主 Harness 研发的落地指导与架构设计\n\n在 `ai_home` 项目落地低延迟全双工通信时，必须：\n1. 在 `lib/runtime/` 中统一升级 WebSocket 路由，支持双向长连接帧解析；\n2. 在 WebUI 伴读面板中建立专用的流式缓冲队列，保证文字打字机动效与音视频同理心共鸣毫无卡顿。\n"
    },
    {
      "id": "01-02-barge-in-and-drain",
      "category": "01. ⚡ 第一篇：全双工极低延迟流式管道与打断机制 (Full-Duplex Streaming & Barge-in)",
      "title": "01-02 毫秒级双向打断（Barge-in）、流式排空与原子状态重置",
      "status": "completed",
      "path": "01-streaming-pipeline/01-02-barge-in-and-drain.md",
      "content": "# 01-02 毫秒级双向打断（Barge-in）、流式排空与原子状态重置\n\n> **“在真实的人类交谈中，‘倾听并适时被打断’是智能与情商的最高体现。一个无法被打断、喋喋不休背诵答案的 Agent 永远只是冷冰冰的机器。Agent Pi 的 Barge-in 架构能够在用户开口发声或键入字符的 50ms 内，瞬间截断上游大模型生成流、排空客户端播放缓冲，并在原子级别重置状态机。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/01-02-pi-barge-in.jpg\" alt=\"毫秒级即时打断与原子流式排空引擎 (Barge-in & Stream Drain Engine)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 毫秒级即时打断与原子流式排空引擎 (Barge-in & Stream Drain Engine)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 章节导读与核心命题\n\n传统 Agent 在处理用户打断时面临的三大难题：\n1. **算力与 Token 浪费**：客户端虽然按下了停止键，但服务端与上游云端仍在大力生成后续几千个 Token，产生巨大的财务浪费；\n2. **幽灵消息（Ghost Frames）**：打断指令到达前，网络管道中积压的几十个数据包依然会继续推给客户端，造成界面跳动与语音重叠；\n3. **上下文时序错乱**：被截断的上半句话是否应该存入历史？存多少？下一轮对话如何自然承接被用户打断的思路？\n\n本节系统剖析 Agent Pi 的 **Barge-in 信号原子传播链、AbortController 上游取消流与截断历史清洗算法**。\n\n---\n\n## 2. 核心专业术语与概念精确释义\n\n| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |\n| :--- | :--- | :--- |\n| **Barge-in** | **即时打断 / 插入** | 用户在 Agent 输出过程中随时切入输入，系统立即暂停输出并切换为全神贯注倾听模式。 |\n| **Pipeline Drain** | **管道排空** | 瞬间丢弃 TCP / WebSocket 发送队列中尚未被客户端播放的无效数据帧。 |\n| **Atomic Abort Propagation** | **原子取消传播** | 通过 HTTP/2 RST_STREAM 或底层 TCP FIN 信号在 10ms 内通知上游大模型停止计算。 |\n| **Truncated Turn Archival** | **截断轮次归档** | 精确记录用户打断时 Agent 实际说出的字符切片，并在历史中打上 `[Interrupted by User]` 标记。 |\n\n---\n\n## 3. Barge-in 时序交互图\n\n```mermaid\nsequenceDiagram\n    autonumber\n    actor User as 用户 (说话 / 敲键盘)\n    participant Client as 客户端 (Web / App)\n    participant Gateway as Pi Harness Gateway\n    participant Upstream as 大模型推理集群\n\n    Gateway->>Upstream: 发起流式推理\n    Upstream-->>Gateway: 流式推送 Token: \"今天的天气非常适合出门...\"\n    Gateway-->>Client: 实时渲染音频与文字\n\n    Note over User: 用户突发插话：\"等一下，我先说个事！\"\n    User->>Client: VAD 语音激活 / 按下 ESC\n    Client->>Client: 立即静音，清空本地播放队列 (0ms)\n    Client->>Gateway: 发送二进制 BARGE_IN_SIGNAL 帧 (15ms)\n    \n    Gateway->>Upstream: 触发 AbortController.abort() (5ms)\n    Upstream-->>Gateway: 立即终止推理，返回实际消耗 Tokens\n    Gateway->>Gateway: 截断当前 Assistant 消息为实际已说出文本\n    Gateway-->>Client: 返回 ACK_DRAINED 确认帧\n    \n    User->>Client: 提交新问题: \"帮我查下明天的航班\"\n    Client->>Gateway: 进入新一轮推理 (无任何旧数据残留)\n```\n\n---\n\n## 4. 对 ai_home 自主 Harness 研发的落地指导与架构设计\n\n在 `ai_home` 中，必须为所有流式推理请求绑定原生的 `AbortController`，并在 WebUI 侧边栏与底部终端中实现全局 `Esc` / 快捷按键打断，确保无论模型生成多长文本，均能一键毫秒级刹车并清爽恢复等待状态。\n"
    },
    {
      "id": "01-03-multimodal-demuxer",
      "category": "01. ⚡ 第一篇：全双工极低延迟流式管道与打断机制 (Full-Duplex Streaming & Barge-in)",
      "title": "01-03 文本/音频多模态时间戳对齐与增量流式解包器（Stream Demuxer）",
      "status": "completed",
      "path": "01-streaming-pipeline/01-03-multimodal-demuxer.md",
      "content": "# 01-03 文本/音频多模态时间戳对齐与增量流式解包器（Stream Demuxer）\n\n> **“在全双工语音与多模态交互中，文字与声音的割裂是造成卡顿感的核心根源。Agent Pi 的增量流式解包器（Stream Demuxer）在字节流入口处实施毫秒级音文分离、时间戳标记与动态重同步，让用户无论是在看文字滚动还是在听自然语音，都能享受到丝滑一致的双模态体验。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/01-03-pi-demuxer.jpg\" alt=\"多模态流式解包与音文毫秒级时间戳对齐 (Stream Demuxer)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 多模态流式解包与音文毫秒级时间戳对齐 (Stream Demuxer)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 核心专业术语与概念精确释义\n\n| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |\n| :--- | :--- | :--- |\n| **Stream Demuxer** | **流式解复用器** | 将上游混合多模态数据包实时解包为纯文本事件、控制指令与音频二进制流的核心管道。 |\n| **Timestamp Alignment** | **时间戳对齐** | 确保屏幕文字高亮与耳机声音播放进度完全同步至同一毫秒基准。 |\n| **Jitter Buffer** | **抗抖动自适应缓冲区** | 抵御公网网络抖动，动态平滑音频流分片，防止声音断续与爆音。 |\n\n---\n\n## 2. 对 ai_home 的落地指导\n\n在 `ai_home` 的 WebUI 中，阅读器与 AI 会话均采用该 Demuxer 设计思想，实现代码块、公式与正文流式分片的零撕裂渲染。\n"
    },
    {
      "id": "02-01-persona-state-machine",
      "category": "02. 🎭 第二篇：动态 Persona 情感状态机与拟人化表达 (Dynamic Persona & Emotion FSM)",
      "title": "02-01 动态 Persona 有限状态机：情绪共鸣、同理心与语调自适应跃迁",
      "status": "completed",
      "path": "02-persona-engine/02-01-persona-state-machine.md",
      "content": "# 02-01 动态 Persona 有限状态机：情绪共鸣、同理心与语调自适应跃迁\n\n> **“一个优秀的 Agent 不应只有冷酷的逻辑正确，更需要具备洞察人类情绪微妙起伏并自适应调整交流姿态的‘心智模型（Theory of Mind）’。Agent Pi 独创的动态 Persona 有限状态机（Persona FSM），将人类对话中的情绪共鸣、抚慰、鼓励与理性分析抽象为可数学化度量的状态转移矩阵。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/02-01-pi-persona-fsm.jpg\" alt=\"动态 Persona 情感有限状态机与自适应语调跃迁 (Persona Emotion FSM)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 动态 Persona 情感有限状态机与自适应语调跃迁 (Persona Emotion FSM)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 核心状态转移拓扑\n\n```\n     ┌─────────────────────────────────────────────────────────────┐\n     │                Agent Pi 动态 Persona 核心状态机              │\n     └──────────────────────────────┬──────────────────────────────┘\n                                    │\n           ┌────────────────────────┼────────────────────────┐\n           ▼                        ▼                        ▼\n     【LISTENING】            【EMPATHIZING】           【ADVISING】\n     (深度倾听/不打扰)        (情绪确认/同理共鸣)       (建设性提议/头脑风暴)\n           ▲                        │                        │\n           └────────────────────────┴────────────────────────┘\n```\n\n---\n\n## 2. 核心专业术语\n\n| 术语 | 中文释义 | 说明 |\n| :--- | :--- | :--- |\n| **Persona State Machine** | **动态人设状态机** | 根据用户当前情绪状态在倾听者、共鸣者、分析师与挚友角色间动态跃迁。 |\n| **Empathy Quotient (EQ)** | **同理心量化系数** | 控制模型在回答前是否先给出情感确认与支持的权重参数。 |\n\n---\n\n## 3. 对 ai_home 自主 Harness 的落地指导\n\n在 `ai_home` 的 AI 伴读与创作工坊中，动态人设可用于伴读模式（温柔耐心的导师）与代码审查模式（严谨犀利的架构师）之间的自由无缝切换。\n"
    },
    {
      "id": "02-02-vad-tensor-and-prompting",
      "category": "02. 🎭 第二篇：动态 Persona 情感状态机与拟人化表达 (Dynamic Persona & Emotion FSM)",
      "title": "02-02 情感张量（Valence-Arousal-Dominance）量化与 System 动态注入",
      "status": "completed",
      "path": "02-persona-engine/02-02-vad-tensor-and-prompting.md",
      "content": "# 02-02 情感张量（Valence-Arousal-Dominance）量化与 System 动态注入\n\n> **“将模糊的人类情感精确映射为计算机能够计算和微调的数学张量，是实现拟人化 AI 的基石。Agent Pi 采用心理学经典的 VAD 三维情感模型（愉悦度、激活度、掌控度），在每一轮流式交互中动态计算用户与 Agent 的情感坐标，并就地注入 System 提示词头部。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/02-02-pi-vad-tensor.jpg\" alt=\"VAD 三维情感张量空间与动态 System 提示词注入\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> VAD 三维情感张量空间与动态 System 提示词注入 (VAD Tensor Model)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. VAD 三维坐标定义\n\n- **Valence (V: 愉悦度)**: `[-1.0, +1.0]`（极度悲伤/愤怒 ➔ 极度快乐/欣慰）；\n- **Arousal (A: 激活度)**: `[0.0, 1.0]`（沉睡/平静 ➔ 狂热/极度激动）；\n- **Dominance (D: 掌控度)**: `[0.0, 1.0]`（无助/被动 ➔ 自信/主动支配）。\n\n---\n\n## 2. 对 ai_home 的落地指导\n\n通过将 VAD 张量与 Prompt Cache 友好结合，在 System-Reminder 尾部动态调整语气，既保证了情感细腻度，又毫不破坏上游大模型的缓存命中率。\n"
    },
    {
      "id": "02-03-prosody-and-speech-pacing",
      "category": "02. 🎭 第二篇：动态 Persona 情感状态机与拟人化表达 (Dynamic Persona & Emotion FSM)",
      "title": "02-03 拟人化节奏控制：语气词、停顿符插入与语音合成标点流式渲染",
      "status": "completed",
      "path": "02-persona-engine/02-03-prosody-and-speech-pacing.md",
      "content": "# 02-03 拟人化节奏控制：语气词、停顿符插入与语音合成标点流式渲染\n\n> **“完美无瑕、语速恒定的语音输出往往让人感到诡异和虚假。Agent Pi 在流式分片中巧妙注入‘语气助词（Hmm, Well, I see）’与‘毫秒级呼吸停顿（Micro-pauses）’，让声音具有呼吸感和思考的质感。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/02-03-pi-prosody-pacing.jpg\" alt=\"拟人化节奏控制与流式呼吸停顿注入 (Prosody & Speech Pacing)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 拟人化节奏控制与流式呼吸停顿注入 (Prosody & Speech Pacing)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 核心专业术语\n\n| 术语 | 中文释义 | 说明 |\n| :--- | :--- | :--- |\n| **Micro-pause Insertion** | **微停顿注入** | 在从句连接词与转折词处插入 40~120ms 呼吸停顿标记。 |\n| **Filler Word Injection** | **语气助词注入** | 在思考复杂问题时自然吐出“嗯...让我看看”，掩盖后台检索的 TTFT 延迟。 |\n"
    },
    {
      "id": "03-01-three-tier-memory-architecture",
      "category": "03. 🧠 第三篇：层次化动态记忆图谱（HMG）与用户画像 (Hierarchical Memory Graph)",
      "title": "03-01 三层认知记忆架构：Core Profile、Semantic Graph 与 Episodic Stream",
      "status": "completed",
      "path": "03-memory-graph/03-01-three-tier-memory-architecture.md",
      "content": "# 03-01 三层认知记忆架构：Core Profile、Semantic Graph 与 Episodic Stream\n\n> **“记忆是智能的基石。缺乏长效记忆的 Agent 只能充当一次性的计算函数。Agent Pi 的三层认知记忆架构（Three-Tier Memory Architecture）将人类的认知记忆分为永久不变的根画像、拓扑互联的实体关系网与时间线追加的情境事件流，实现了高精度、低开销的终身记忆。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/03-01-pi-three-tier-memory.jpg\" alt=\"三层认知记忆架构拓扑 (Three-Tier Memory Architecture)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 三层认知记忆架构拓扑 (Three-Tier Memory Architecture)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 三层认知记忆模型\n\n```\n┌───────────────────────────────────────────────────────────────────────────┐\n│                      Agent Pi 三层认知记忆架构模型 (HMG)                   │\n│                                                                           │\n│  [Tier 1: Core Profile (永恒根画像)]                                      │\n│  - 姓名、职业、核心价值观、不可变喜好 (始终置于 System Prompt 头部)       │\n│                                                                           │\n│  [Tier 2: Semantic Graph (语义关系实体图谱)]                              │\n│  - 朋友/家人/项目/概念之间的图关联节点 (按查询语义图扩散召回)             │\n│                                                                           │\n│  [Tier 3: Episodic Stream (情境事件流)]                                   │\n│  - 随时间线递进的具体对话事件与心路历程 (按时间与情绪相似度召回)          │\n└───────────────────────────────────────────────────────────────────────────┘\n```\n\n---\n\n## 2. 对 ai_home 自主 Harness 的落地指导\n\n在 `ai_home` 中，`~/.claude/projects/.../memory/` 的 Markdown 体系与 SQLite 实体表正是这一思想的绝佳工程体现。\n"
    },
    {
      "id": "03-02-ebbinghaus-memory-decay",
      "category": "03. 🧠 第三篇：层次化动态记忆图谱（HMG）与用户画像 (Hierarchical Memory Graph)",
      "title": "03-02 艾宾浩斯遗忘曲线、记忆强化跃迁与自适应衰减算法",
      "status": "completed",
      "path": "03-memory-graph/03-02-ebbinghaus-memory-decay.md",
      "content": "# 03-02 艾宾浩斯遗忘曲线、记忆强化跃迁与自适应衰减算法\n\n> **“人类大脑的伟大不仅在于能够记住，更在于能够高效遗忘无关紧要的琐事。Agent Pi 引入基于经典艾宾浩斯遗忘曲线的数学衰减模型与记忆强化机制，确保上下文窗口永远只承载最具生命力和关联度的认知资产。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/03-02-pi-ebbinghaus-decay.jpg\" alt=\"艾宾浩斯记忆强化与衰减曲线 (Ebbinghaus Decay Engine)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 艾宾浩斯记忆强化与衰减曲线 (Ebbinghaus Decay Engine)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 记忆权重与衰减数学公式\n\n$$R(t) = e^{-\\frac{t}{S \\cdot (1 + \\ln(1 + C))}}$$\n\n- $R(t)$: 当前时间 $t$ 下记忆节点的留存强度与召回权重；\n- $S$: 记忆初始稳定性系数（由情感强度 Valence/Arousal 决定）；\n- $C$: 历史被命中与强化的累计次数。\n"
    },
    {
      "id": "03-03-memory-extraction-subagent",
      "category": "03. 🧠 第三篇：层次化动态记忆图谱（HMG）与用户画像 (Hierarchical Memory Graph)",
      "title": "03-03 异步后台记忆萃取子代理（Memory Extraction Subagent）与冲突消解",
      "status": "completed",
      "path": "03-memory-graph/03-03-memory-extraction-subagent.md",
      "content": "# 03-03 异步后台记忆萃取子代理（Memory Extraction Subagent）与冲突消解\n\n> **“主对话线程必须保持绝对的毫秒级纯粹，绝不能被沉重的记忆提取与图谱更新阻塞。Agent Pi 将记忆的提炼、关联与冲突消解完全交由异步后台子代理执行。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/03-03-pi-memory-subagent.jpg\" alt=\"异步后台记忆萃取子代理与冲突消解 (Memory Extraction Subagent)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 异步后台记忆萃取子代理与冲突消解 (Memory Extraction Subagent)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 记忆冲突消解法则\n\n当用户先后说出“我不喜欢喝咖啡”与“最近爱上了拿铁”时，后台子代理自动标记旧事实的有效时间区间 `[2024-2025]`，并建立状态跃迁边 `evolved_to`。\n"
    },
    {
      "id": "04-01-silence-detection-and-icebreaker",
      "category": "04. 💓 第四篇：多通道主动关怀与长程心跳维持 (Proactive Care & Session Heartbeat)",
      "title": "04-01 长连接心跳探针、静默检测（Silence Detection）与主动破冰算法",
      "status": "completed",
      "path": "04-proactive-heartbeat/04-01-silence-detection-and-icebreaker.md",
      "content": "# 04-01 长连接心跳探针、静默检测（Silence Detection）与主动破冰算法\n\n> **“长情的陪伴不仅是‘有问必答’，更是在觉察到用户陷入长久沉默或情绪低落时，适时递上一句温暖的问候。Agent Pi 的主动关怀引擎通过智能静默检测与自适应心跳探针，赋予了 AI 真正的主动性与生命感。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/04-01-pi-silence-detection.jpg\" alt=\"长连接静默检测与主动破冰引擎 (Silence Detection & Proactive Heartbeat)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 长连接静默检测与主动破冰引擎 (Silence Detection & Proactive Heartbeat)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 静默检测状态机\n\n- **ACTIVE**: 正在热烈交互（心跳间隔 30s）；\n- **CONTEMPLATIVE**: 思考中停顿（等待 5~15s，不贸然打断）；\n- **DORMANT**: 处于闲置休眠态，触发情境感知的主动破冰机制。\n"
    },
    {
      "id": "04-02-context-aware-proactive-push",
      "category": "04. 💓 第四篇：多通道主动关怀与长程心跳维持 (Proactive Care & Session Heartbeat)",
      "title": "04-02 跨时区情境感知：时间、节气、日程提醒与多轮情感召回",
      "status": "completed",
      "path": "04-proactive-heartbeat/04-02-context-aware-proactive-push.md",
      "content": "# 04-02 跨时区情境感知：时间、节气、日程提醒与多轮情感召回\n\n> **“最动人的问候永远源于对细节的铭记。结合当地日落时间、天气突变与数天前未完待续的工作挑战，Agent Pi 能够在最恰当的时刻发起有温度的情感召回。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/04-02-pi-proactive-push.jpg\" alt=\"跨时区情境感知与主动情感召回 (Context-Aware Proactive Push)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 跨时区情境感知与主动情感召回 (Context-Aware Proactive Push)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n"
    },
    {
      "id": "05-01-pi-runtime-implementation",
      "category": "05. 🚀 第五篇：自主落地研发与 ai_home 拟人伴读引擎 (Engineering Implementation)",
      "title": "05-01 基于 UniversalAgentEventLoop 的全双工流式伴读引擎实现",
      "status": "completed",
      "path": "05-implementation/05-01-pi-runtime-implementation.md",
      "content": "# 05-01 基于 UniversalAgentEventLoop 的全双工流式伴读引擎实现\n\n> **“在 `ai_home` 项目的工程底座之上，我们如何将 Pi Agent 的全双工流式管道、Barge-in 即时打断与动态 Persona 情感状态机优雅地落地为生产级 TypeScript / Node.js 运行时？本节带来完整的架构设计与源码实现。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/05-01-pi-runtime-loop.jpg\" alt=\"基于 UniversalAgentEventLoop 的全双工流式伴读引擎 (Pi Runtime Engine)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 基于 UniversalAgentEventLoop 的全双工流式伴读引擎 (Pi Runtime Engine)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 核心 TypeScript 伴读运行时实现\n\n```typescript\nexport class PiCompanionRuntime {\n  private abortController: AbortController | null = null;\n\n  public async handleUserStreamInput(stream: AsyncIterable<string>, onDelta: (token: string) => void): Promise<void> {\n    if (this.abortController) {\n      // 触发毫秒级 Barge-in 打断\n      this.abortController.abort();\n    }\n    this.abortController = new AbortController();\n    \n    // 执行流式推理并解复用\n    for await (const chunk of stream) {\n      if (this.abortController.signal.aborted) break;\n      onDelta(chunk);\n    }\n  }\n}\n```\n"
    },
    {
      "id": "05-02-high-concurrency-cluster",
      "category": "05. 🚀 第五篇：自主落地研发与 ai_home 拟人伴读引擎 (Engineering Implementation)",
      "title": "05-02 生产级高并发 WebSocket 会话集群与 WAL 持久化方案",
      "status": "completed",
      "path": "05-implementation/05-02-high-concurrency-cluster.md",
      "content": "# 05-02 生产级高并发 WebSocket 会话集群与 WAL 持久化方案\n\n> **“全书终章：将全双工流式伴读引擎扩展至万级长连接并发集群，结合 SQLite WAL 模式与不可变追加 JSONL，打造高可用、零丢失、毫秒恢复的拟人化 Agent 基座。”**\n\n---\n\n<div class=\"ai-concept-hero\">\n  <img src=\"/docs/pi-agent-book/assets/images/05-02-pi-cluster-wal.jpg\" alt=\"高并发 WebSocket 会话集群与 WAL 持久化架构 (Cluster & WAL Architecture)\" loading=\"lazy\" />\n  <div class=\"ai-hero-caption\">\n    <div class=\"hero-cap-title\"><span>🎨</span> 高并发 WebSocket 会话集群与 WAL 持久化架构 (Cluster & WAL Architecture)</div>\n    <span class=\"hero-cap-badge\">AI 8K Concept</span>\n  </div>\n</div>\n\n## 1. 全书宏观技术总结与生产落地蓝图\n\n至此，《Agent Pi：全双工实时流式架构与拟人情感引擎设计》全书五大篇章 12 个小节全部高质量编写完成！结合 `ai_home` 的灵感工坊与沉浸式阅读器，开启下一代人机共生界面的崭新纪元。\n"
    }
  ]
};
