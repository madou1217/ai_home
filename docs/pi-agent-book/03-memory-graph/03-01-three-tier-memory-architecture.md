# 03-01 三层认知记忆架构：Core Profile、Semantic Graph 与 Episodic Stream

> **“记忆是智能的基石。缺乏长效记忆的 Agent 只能充当一次性的计算函数。Agent Pi 的三层认知记忆架构（Three-Tier Memory Architecture）将人类的认知记忆分为永久不变的根画像、拓扑互联的实体关系网与时间线追加的情境事件流，实现了高精度、低开销的终身记忆。”**

---

<div class="ai-concept-hero">
  <img src="/docs/pi-agent-book/assets/images/03-01-pi-three-tier-memory.jpg" alt="三层认知记忆架构拓扑 (Three-Tier Memory Architecture)" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 三层认知记忆架构拓扑 (Three-Tier Memory Architecture)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. 三层认知记忆模型

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      Agent Pi 三层认知记忆架构模型 (HMG)                   │
│                                                                           │
│  [Tier 1: Core Profile (永恒根画像)]                                      │
│  - 姓名、职业、核心价值观、不可变喜好 (始终置于 System Prompt 头部)       │
│                                                                           │
│  [Tier 2: Semantic Graph (语义关系实体图谱)]                              │
│  - 朋友/家人/项目/概念之间的图关联节点 (按查询语义图扩散召回)             │
│                                                                           │
│  [Tier 3: Episodic Stream (情境事件流)]                                   │
│  - 随时间线递进的具体对话事件与心路历程 (按时间与情绪相似度召回)          │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 对 ai_home 自主 Harness 的落地指导

在 `ai_home` 中，`~/.claude/projects/.../memory/` 的 Markdown 体系与 SQLite 实体表正是这一思想的绝佳工程体现。
