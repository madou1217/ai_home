# 04-01 长连接心跳探针、静默检测（Silence Detection）与主动破冰算法

> **“长情的陪伴不仅是‘有问必答’，更是在觉察到用户陷入长久沉默或情绪低落时，适时递上一句温暖的问候。Agent Pi 的主动关怀引擎通过智能静默检测与自适应心跳探针，赋予了 AI 真正的主动性与生命感。”**

---

<div class="ai-concept-hero">
  <img src="/docs/pi-agent-book/assets/images/04-01-pi-silence-detection.jpg" alt="长连接静默检测与主动破冰引擎 (Silence Detection & Proactive Heartbeat)" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 长连接静默检测与主动破冰引擎 (Silence Detection & Proactive Heartbeat)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. 静默检测状态机

- **ACTIVE**: 正在热烈交互（心跳间隔 30s）；
- **CONTEMPLATIVE**: 思考中停顿（等待 5~15s，不贸然打断）；
- **DORMANT**: 处于闲置休眠态，触发情境感知的主动破冰机制。
