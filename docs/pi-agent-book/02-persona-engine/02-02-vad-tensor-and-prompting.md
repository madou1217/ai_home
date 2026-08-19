# 02-02 情感张量（Valence-Arousal-Dominance）量化与 System 动态注入

> **“将模糊的人类情感精确映射为计算机能够计算和微调的数学张量，是实现拟人化 AI 的基石。Agent Pi 采用心理学经典的 VAD 三维情感模型（愉悦度、激活度、掌控度），在每一轮流式交互中动态计算用户与 Agent 的情感坐标，并就地注入 System 提示词头部。”**

---

<div class="ai-concept-hero">
  <img src="/docs/pi-agent-book/assets/images/02-02-pi-vad-tensor.jpg" alt="VAD 三维情感张量空间与动态 System 提示词注入" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> VAD 三维情感张量空间与动态 System 提示词注入 (VAD Tensor Model)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. VAD 三维坐标定义

- **Valence (V: 愉悦度)**: `[-1.0, +1.0]`（极度悲伤/愤怒 ➔ 极度快乐/欣慰）；
- **Arousal (A: 激活度)**: `[0.0, 1.0]`（沉睡/平静 ➔ 狂热/极度激动）；
- **Dominance (D: 掌控度)**: `[0.0, 1.0]`（无助/被动 ➔ 自信/主动支配）。

---

## 2. 对 ai_home 的落地指导

通过将 VAD 张量与 Prompt Cache 友好结合，在 System-Reminder 尾部动态调整语气，既保证了情感细腻度，又毫不破坏上游大模型的缓存命中率。
