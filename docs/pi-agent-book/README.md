# 《Physical Intelligence $\pi_0$ 与通用具身 Agent 架构设计》
> **从 Vision-Language-Action (VLA) 基础大模型到 Flow Matching 连续动作流、跨本体泛化与高频实时控制 Harness 工业级落地**

---

## 📖 书籍定位与愿景
本书旨在深度剖析工业界具身智能（Embodied AI）与机器人通用大模型的划时代之作 —— **Physical Intelligence (Pi) 的 $\pi_0$ (Pi-Zero)** 核心架构。针对传统机器人专用策略“泛化差、无法跨本体、感知与动作割裂”的痛点，系统性解构其在 **VLA 多模态感知、Flow Matching（流匹配）动作生成、跨机器人本体（Cross-Embodiment）泛化、50Hz 实时动作分块（Action Chunking）与物理执行沙箱** 等领域的底层算法、数据协议、C++/Python 源码实现与 Harness 运行时集成，为下一代具身 Agent 提供坚实的工程落地指南。

---

## 🗺️ 全景交互目录与章节进度

### 00. 前言与物理智能本质 (Introduction & Foundations)
- [x] [00-01 突破比特世界：从虚拟软件 Agent 到物理具身智能（Embodied AI）的范式跃迁](00-intro/01-embodied-ai-paradigm-shift.md)

---

### 01. 🦾 第一篇：$\pi_0$ VLA 基础大模型架构解构 (Vision-Language-Action Architecture)
- [x] [01-01 视觉-语言-动作（VLA）多模态自回归 Backbone 与特征融合拓扑](01-vla-backbone/01-01-vla-multimodal-backbone.md)
- [x] [01-02 跨本体（Cross-Embodiment）泛化表征：双臂/移动底盘/末端夹爪统一动作空间](01-vla-backbone/01-02-cross-embodiment-action-space.md)
- [x] [01-03 多视角相机流、点云与高频触觉传感器的微秒级时空对齐](01-vla-backbone/01-03-multimodal-sensor-fusion.md)

---

### 02. 🌊 第二篇：Flow Matching 动作生成算法与扩散策略 (Flow Matching & Action Diffusion)
- [x] [02-01 连续空间中的 Flow Matching 策略生成原理与数学推导](02-flow-matching/02-01-flow-matching-theory.md)
- [x] [02-02 50Hz Action Chunking（动作分块）与轨迹平滑插值机制](02-flow-matching/02-02-action-chunking-and-smoothing.md)
- [x] [02-03 专家演示数据蒸馏、强化学习微调（RL with Physical Feedback）](02-flow-matching/02-03-rl-and-expert-distillation.md)

---

### 03. ⚡ 第三篇：实时控制 Harness 与通信总线 (Real-Time Control Harness)
- [x] [03-01 实时微秒级通信总线：gRPC / ROS 2 DDS / ZeroMQ 零拷贝混合协议](03-control-harness/03-01-realtime-bus-and-dds.md)
- [x] [03-02 物理碰撞异常自愈、急停安全门禁与力控闭环（Impedance Control）](03-control-harness/03-02-safety-gate-and-force-feedback.md)
- [x] [03-03 硬件抽象层（HAL）与物理执行沙箱（Physical Execution Sandbox）](03-control-harness/03-03-hardware-abstraction-layer.md)

---

### 04. 🚀 第四篇：自主落地研发与 ai_home 具身 Agent 中枢 (ai_home Integration)
- [x] [04-01 UniversalAgentEventLoop 扩展：支持连续动作空间与物理感知循环](04-ai-home-integration/04-01-universal-loop-embodied-extension.md)
- [x] [04-02 边缘端轻量化部署：TensorRT-LLM 量化、Jetson Orin 算力优化与全景验收](04-ai-home-integration/04-02-edge-deployment-and-grand-conclusion.md)
