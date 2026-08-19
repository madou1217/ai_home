# 《Agent Pi：全双工实时流式架构与拟人情感引擎设计》
> **从 Inflection Pi 核心哲学到生产级毫秒流式管道、Barge-in 即时打断、动态 Persona 状态机与层次化记忆图谱（HMG）工业级落地**

---

## 📖 书籍定位与愿景
本书旨在深度剖析工业界个人智能伴侣与低延迟语音/文本交互的标杆系统 —— **Inflection Pi (Agent Pi)** 的核心架构。针对传统问答式 Agent “迟钝、冰冷、单向回合制”的痛点，系统性解构其在**全双工毫秒级 WebSocket 流式管道、Barge-in 双向即时打断、动态 Persona 拟人情感有限状态机（FSM）、层次化动态记忆图谱（Hierarchical Memory Graph）与多通道对话心跳维持**等领域的底层协议、数据结构与源码实现，并直接指导在现代 Agent 运行时（如 `ai_home`）中落地具有极低延迟与极高拟人同理心的下一代 Agent 引擎。

---

## 🚀 网页版 AI 沉浸式伴读阅读器 (Web & AI Interactive Reader)

本书已全量内置了一套基于现代化 Web 前端的 **沉浸式 AI 伴读阅读器**：
- **物理入口**：`docs/pi-agent-book/reader/index.html`（支持通过 `aih` 本地服务及 Web 控制台工坊直接访问）
- **核心特性**：
  1. **全景章节导航与快速检索**：左侧内置 12 个小节完整的层级导航，支持实时模糊搜索；
  2. **沉浸式暗黑阅读体验**：Linear 级设计质感，支持字号调整、排版缩放与双语流程图展示；
  3. **划词即问 (Highlight & Ask AI)**：阅读正文中遇到任何概念，直接鼠标划词即可一键唤起 AI 深度解析；
  4. **全双工免密 AI 伴读 Copilot**：免配置 Key 直连本地 `aih-server` 统一网关。

---

## 🗺️ 全景交互目录与章节进度

### 00. 前言与设计哲学 (Introduction & Philosophy)
- [x] [00-01 从“冷冰冰的问答工具”到“全双工长情伴侣”：Agent Pi 的拟人化设计哲学](00-intro/01-philosophy-of-pi-agent.md)

---

### 01. ⚡ 第一篇：全双工极低延迟流式管道与打断机制 (Full-Duplex Streaming & Barge-in)
- [x] [01-01 全双工 WebSocket 帧协议设计与 TTFT < 120ms 极致优化](01-streaming-pipeline/01-01-websocket-wire-protocol.md)
- [x] [01-02 毫秒级双向打断（Barge-in）、流式排空与原子状态重置](01-streaming-pipeline/01-02-barge-in-and-drain.md)
- [x] [01-03 文本/音频多模态时间戳对齐与增量流式解包器（Stream Demuxer）](01-streaming-pipeline/01-03-multimodal-demuxer.md)

---

### 02. 🎭 第二篇：动态 Persona 情感状态机与拟人化表达 (Dynamic Persona & Emotion FSM)
- [x] [02-01 动态 Persona 有限状态机：情绪共鸣、同理心与语调自适应跃迁](02-persona-engine/02-01-persona-state-machine.md)
- [x] [02-02 情感张量（Valence-Arousal-Dominance）量化与 System 动态注入](02-persona-engine/02-02-vad-tensor-and-prompting.md)
- [x] [02-03 拟人化节奏控制：语气词、停顿符插入与语音合成标点流式渲染](02-persona-engine/02-03-prosody-and-speech-pacing.md)

---

### 03. 🧠 第三篇：层次化动态记忆图谱（HMG）与用户画像 (Hierarchical Memory Graph)
- [x] [03-01 三层认知记忆架构：Core Profile、Semantic Graph 与 Episodic Stream](03-memory-graph/03-01-three-tier-memory-architecture.md)
- [x] [03-02 艾宾浩斯遗忘曲线、记忆强化跃迁与自适应衰减算法](03-memory-graph/03-02-ebbinghaus-memory-decay.md)
- [x] [03-03 异步后台记忆萃取子代理（Memory Extraction Subagent）与冲突消解](03-memory-graph/03-03-memory-extraction-subagent.md)

---

### 04. 💓 第四篇：多通道主动关怀与长程心跳维持 (Proactive Care & Session Heartbeat)
- [x] [04-01 长连接心跳探针、静默检测（Silence Detection）与主动破冰算法](04-proactive-heartbeat/04-01-silence-detection-and-icebreaker.md)
- [x] [04-02 跨时区情境感知：时间、节气、日程提醒与多轮情感召回](04-proactive-heartbeat/04-02-context-aware-proactive-push.md)

---

### 05. 🚀 第五篇：自主落地研发与 ai_home 拟人伴读引擎 (Engineering Implementation)
- [x] [05-01 基于 UniversalAgentEventLoop 的全双工流式伴读引擎实现](05-implementation/05-01-pi-runtime-implementation.md)
- [x] [05-02 生产级高并发 WebSocket 会话集群与 WAL 持久化方案](05-implementation/05-02-high-concurrency-cluster.md)
