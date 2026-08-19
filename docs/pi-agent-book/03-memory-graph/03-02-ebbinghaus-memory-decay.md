# 03-02 艾宾浩斯遗忘曲线、记忆强化跃迁与自适应衰减算法

> **“人类大脑的伟大不仅在于能够记住，更在于能够高效遗忘无关紧要的琐事。Agent Pi 引入基于经典艾宾浩斯遗忘曲线的数学衰减模型与记忆强化机制，确保上下文窗口永远只承载最具生命力和关联度的认知资产。”**

---

<div class="ai-concept-hero">
  <img src="/docs/pi-agent-book/assets/images/03-02-pi-ebbinghaus-decay.jpg" alt="艾宾浩斯记忆强化与衰减曲线 (Ebbinghaus Decay Engine)" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 艾宾浩斯记忆强化与衰减曲线 (Ebbinghaus Decay Engine)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. 记忆权重与衰减数学公式

$$R(t) = e^{-\frac{t}{S \cdot (1 + \ln(1 + C))}}$$

- $R(t)$: 当前时间 $t$ 下记忆节点的留存强度与召回权重；
- $S$: 记忆初始稳定性系数（由情感强度 Valence/Arousal 决定）；
- $C$: 历史被命中与强化的累计次数。
