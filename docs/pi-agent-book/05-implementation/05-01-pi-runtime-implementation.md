# 05-01 基于 UniversalAgentEventLoop 的全双工流式伴读引擎实现

> **“在 `ai_home` 项目的工程底座之上，我们如何将 Pi Agent 的全双工流式管道、Barge-in 即时打断与动态 Persona 情感状态机优雅地落地为生产级 TypeScript / Node.js 运行时？本节带来完整的架构设计与源码实现。”**

---

<div class="ai-concept-hero">
  <img src="/docs/pi-agent-book/assets/images/05-01-pi-runtime-loop.jpg" alt="基于 UniversalAgentEventLoop 的全双工流式伴读引擎 (Pi Runtime Engine)" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 基于 UniversalAgentEventLoop 的全双工流式伴读引擎 (Pi Runtime Engine)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. 核心 TypeScript 伴读运行时实现

```typescript
export class PiCompanionRuntime {
  private abortController: AbortController | null = null;

  public async handleUserStreamInput(stream: AsyncIterable<string>, onDelta: (token: string) => void): Promise<void> {
    if (this.abortController) {
      // 触发毫秒级 Barge-in 打断
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    
    // 执行流式推理并解复用
    for await (const chunk of stream) {
      if (this.abortController.signal.aborted) break;
      onDelta(chunk);
    }
  }
}
```
