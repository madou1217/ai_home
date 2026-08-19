# 03-03 异步后台记忆萃取子代理（Memory Extraction Subagent）与冲突消解

> **“主对话线程必须保持绝对的毫秒级纯粹，绝不能被沉重的记忆提取与图谱更新阻塞。Agent Pi 将记忆的提炼、关联与冲突消解完全交由异步后台子代理执行。”**

---

<div class="ai-concept-hero">
  <img src="/docs/pi-agent-book/assets/images/03-03-pi-memory-subagent.jpg" alt="异步后台记忆萃取子代理与冲突消解 (Memory Extraction Subagent)" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 异步后台记忆萃取子代理与冲突消解 (Memory Extraction Subagent)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. 记忆冲突消解法则

当用户先后说出“我不喜欢喝咖啡”与“最近爱上了拿铁”时，后台子代理自动标记旧事实的有效时间区间 `[2024-2025]`，并建立状态跃迁边 `evolved_to`。
