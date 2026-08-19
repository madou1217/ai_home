# 01-03 文本/音频多模态时间戳对齐与增量流式解包器（Stream Demuxer）

> **“在全双工语音与多模态交互中，文字与声音的割裂是造成卡顿感的核心根源。Agent Pi 的增量流式解包器（Stream Demuxer）在字节流入口处实施毫秒级音文分离、时间戳标记与动态重同步，让用户无论是在看文字滚动还是在听自然语音，都能享受到丝滑一致的双模态体验。”**

---

<div class="ai-concept-hero">
  <img src="/docs/pi-agent-book/assets/images/01-03-pi-demuxer.jpg" alt="多模态流式解包与音文毫秒级时间戳对齐 (Stream Demuxer)" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 多模态流式解包与音文毫秒级时间戳对齐 (Stream Demuxer)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Stream Demuxer** | **流式解复用器** | 将上游混合多模态数据包实时解包为纯文本事件、控制指令与音频二进制流的核心管道。 |
| **Timestamp Alignment** | **时间戳对齐** | 确保屏幕文字高亮与耳机声音播放进度完全同步至同一毫秒基准。 |
| **Jitter Buffer** | **抗抖动自适应缓冲区** | 抵御公网网络抖动，动态平滑音频流分片，防止声音断续与爆音。 |

---

## 2. 对 ai_home 的落地指导

在 `ai_home` 的 WebUI 中，阅读器与 AI 会话均采用该 Demuxer 设计思想，实现代码块、公式与正文流式分片的零撕裂渲染。
