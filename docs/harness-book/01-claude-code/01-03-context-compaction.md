# 01-03 上下文滑动窗口、自动压缩（Auto-Compaction）与 Token 预算

> **“在长程自主 Agent 运行时中，上下文窗口（Context Window）不仅是物理内存，更是昂贵且稀缺的注意力算力资源。优秀的 Harness 必须像操作系统的虚拟内存管理器一样，精细化执行上下文分级、按需换页、自动滚扎压缩（Compaction）与 Prompt Cache 字节级对齐。”**

---


<div class="ai-concept-hero">
  <img src="/docs/harness-book/assets/images/01-03-context-compaction.jpg" alt="上下文 Token 树与 GPU KV Cache 压缩拓扑" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 上下文 Token 树与 GPU KV Cache 压缩拓扑</div>
    <span class="hero-cap-badge">Gemini 3.1 Flash Image</span>
  </div>
</div>

## 1. 章节导读与核心命题

当 Agent 深入复杂工程场景执行长程任务（如大规模代码库重构、跨模块缺陷排查、多文件联动编写）时，执行轨迹（Trajectory）通常会迅速演进至数十甚至上百轮 ReAct 循环。每一次工具读取的代码、运行测试输出的数百行日志，都会使上下文 Token 呈指数级膨胀。

如果不加节制，系统将迅速面临三大致命危机：
1. **硬超限崩溃（Context Overflow）**：触发大模型 API 的物理上限（如 200k / 1M tokens），导致抛出 HTTP 400 错误使会话彻底夭折；
2. **注意力稀释与性能恶化（Needle in a Haystack Degradation）**：过长且充斥无关历史的 Prompt 会导致模型发生“灾难性遗忘”，忽略最初的用户核心指令；
3. **经济学与延迟灾难**：无谓的全量上下文重复传输，将导致单轮交互成本暴增数十倍，首字延迟（TTFT）从毫秒级恶化至数十秒。

本节将深入 Anthropic **Claude Code** 的底层内存治理机制，深度剖析其 **多级 Token 预算分配体系、微观启发式输出剪枝、基于语义的宏观自动滚扎压缩（Auto-Compaction）算法以及 Prompt Cache 字节级对齐工程**。

<div class="rich-diagram-box">
  <div class="diagram-header-tag">Context Engine</div>
  <div class="diagram-title"><span>📦</span> 上下文生命周期与多级压缩引擎拓扑</div>
  <div class="split-two-col">
    <div class="col-box">
      <div class="col-title">🧹 微观启发式剪枝 (Micro Pruning)</div>
      <div class="tech-card blue" style="margin-bottom:6px;"><div class="card-label">超长工具输出折叠</div><div class="card-sub">&gt;500 行日志替换为简要占位符</div></div>
      <div class="tech-card green"><div class="card-label">重复读取按 LRU 淘汰</div><div class="card-sub">仅保留文件最新读取镜像</div></div>
    </div>
    <div class="col-box">
      <div class="col-title">🧠 宏观语义压缩 (Macro Compaction)</div>
      <div class="tech-card purple" style="margin-bottom:6px;"><div class="card-label">Fork 独立后台子代理</div><div class="card-sub">生成结构化 XML 状态树</div></div>
      <div class="tech-card cyan"><div class="card-label">原子替换历史消息</div><div class="card-sub">回收 70%+ 上下文 Token</div></div>
    </div>
  </div>
</div>

---

## 2. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Context Compaction** | **上下文滚扎压缩** | 当对话历史逼近模型 Token 水位线阈值时，Harness 通过结构化提炼、陈旧事件折叠与语义摘要，在最大程度保留任务关键信息的前提下，大幅削减上下文 Token 总量的技术。 |
| **Token Budget Watermark** | **Token 预算水位线** | 运行时为上下文窗口设定的分级警戒水位（如 75% 软预警、80% 触发异步压缩、95% 强行同步截断），用于精细化控制内存生命周期。 |
| **Micro Pruning** | **微观启发式剪枝** | 不经过 LLM 推理、纯靠确定性算法对历史消息中的大型数据块（如超长工具输出、重复文件读取、过期中间报错）进行本地就地截断或占位符替换。 |
| **Macro Semantic Compaction** | **宏观语义压缩** | 唤起专门的 Summarizer Agent，对过去数十轮的执行轨迹进行目标、决策、修改文件集与未决问题的结构化多维提炼，并生成紧凑的里程碑摘要。 |
| **Prompt Cache Alignment** | **提示词缓存对齐** | 确保 System Prompt 及早期稳定历史的字节级前缀哈希严格不变，以最大化触发云端大模型厂商的 KV 缓存命中，降低计算成本与首字延迟。 |
| **KV Cache (Key-Value Cache)** | **注意力键值对缓存** | 大模型自注意力机制中保存已计算 Token 的 Key 和 Value 矩阵的显存结构。Prompt Cache 的物理本质就是服务商层面的 KV Cache 复用。 |
| **Headroom Reserve** | **净空预留区** | Harness 强制在上下文总容量中预留的一块不可被历史消息侵占的安全缓冲区（通常为 8k~16k tokens），专门用于承载单次请求的最大输出 Token 及思考预算。 |
| **Sliding Window** | **滑动窗口** | 一种固定容量或固定轮数的缓存管理窗口，随着新事件的产生，最陈旧且权重最低的事件从窗口尾部被淘汰或转入归档存储。 |

---

## 3. 多级 Token 预算水位线与分区拓扑

<div id="widget-cache-container"></div>



Claude Code 将单次请求的上下文空间进行了严密的物理分区，构建了四层 Token 预算模型：

<div class="rich-diagram-box">
  <div class="diagram-header-tag">Memory Partition Model</div>
  <div class="diagram-title"><span>🧠</span> 上下文物理内存分区模型 (Total: 200,000 Tokens)</div>
  <div class="harness-stack">
    <div class="stack-layer">
      <div class="layer-badge">Zone A: 静态系统底护区 (~8,000 Tokens) ── 100% 命中 Prompt Cache</div>
      <div class="chips-flex-wrap">
        <span class="tech-card blue" style="padding:4px 8px; font-size:11px;">Core System Prompt</span>
        <span class="tech-card blue" style="padding:4px 8px; font-size:11px;">Global Safety Rules</span>
        <span class="tech-card blue" style="padding:4px 8px; font-size:11px;">Built-in Tools Schema</span>
        <span class="tech-card blue" style="padding:4px 8px; font-size:11px;">MCP Tools Schema</span>
      </div>
    </div>
    <div class="stack-layer">
      <div class="layer-badge">Zone B: 压缩摘要区 (~12,000 Tokens) ── 周期性异步滚扎更新 (95% 命中)</div>
      <div class="tech-card purple"><div class="card-label">&lt;compacted_summary&gt; 任务最初目标、关键决策链、已修改文件列表与测试现状</div></div>
    </div>
    <div class="stack-layer">
      <div class="layer-badge">Zone C: 活跃执行轨迹区 (~140,000 Tokens) ── 动态滑动增长</div>
      <div class="tech-card cyan"><div class="card-label">最近 N 轮完整 Thought、Action、Observation（只读工具结果根据 LRU 启发式剪枝）</div></div>
    </div>
    <div class="stack-layer">
      <div class="layer-badge">Zone D: 弹性警戒与净空区 (~40,000 Tokens) ── 绝对安全红线</div>
      <div class="chips-grid-3">
        <div class="tech-card orange"><div class="card-label">160k (80% 水位)</div><div class="card-sub">触发异步预压缩</div></div>
        <div class="tech-card red"><div class="card-label">184k (92% 水位)</div><div class="card-sub">触发同步阻塞修剪</div></div>
        <div class="tech-card green"><div class="card-label">16k (Reserve)</div><div class="card-sub">锁定给 max_tokens 输出</div></div>
      </div>
    </div>
  </div>
</div>

---

## 4. 微观剪枝（Micro Pruning）与宏观压缩（Macro Compaction）双引擎机制

为了在性能开销与上下文保真度之间取得极致平衡，Claude Code 设计了“**微观本地修剪 -> 宏观语义压缩**”的双层递进治理体系。

<div class="rich-diagram-box">
  <div class="diagram-header-tag">Cache Breakpoints</div>
  <div class="diagram-title"><span>⚡</span> Prompt Cache 字节级对齐与四段式断点布局</div>
  <div class="harness-stack">
    <div class="tech-card blue"><div class="card-label">1. 静态基础系统提示词 (Static System Prompt)</div><div class="card-sub">角色、代码风格、全局原则 ── 100% 命中 Cache</div></div>
    <div class="flow-connector">⬇️ Breakpoint 1: cache_control = {"type": "ephemeral"}</div>
    <div class="tech-card purple"><div class="card-label">2. 工具定义 Schema 列表 (Tools Definition List)</div><div class="card-sub">字典序严格排序，保持哈希稳定 ── 100% 命中 Cache</div></div>
    <div class="flow-connector">⬇️ Breakpoint 2: cache_control = {"type": "ephemeral"}</div>
    <div class="tech-card green"><div class="card-label">3. 历史滚扎压缩摘要 (Compacted Context Summary)</div><div class="card-sub">&lt;compacted_context&gt; 状态树 ── 95% 增量命中</div></div>
    <div class="flow-connector">⬇️ Breakpoint 3: cache_control = {"type": "ephemeral"}</div>
    <div class="tech-card cyan"><div class="card-label">4. 动态环境感知探针 (Dynamic Probes - System Reminder)</div><div class="card-sub">当前时间、Git SHA、CWD、MEMORY.md 动态召回</div></div>
    <div class="flow-connector">⬇️ 极速增量计算区 (No Cache)</div>
    <div class="tech-card orange"><div class="card-label">5. 当前活跃对话轮次 (Active Turns: Recent 2 Rounds)</div><div class="card-sub">增量 Prefill 仅消耗 ~1.2k Tokens (TTFT &lt; 180ms)</div></div>
  </div>
</div>

### 5.1 保持 Prompt Cache 命中的四大工程军规
1. **军规一：工具 Schema 绝对确定性排序**：
   - 动态加载的 MCP 工具列表必须使用 `tools.sort((a, b) => a.name.localeCompare(b.name))` 排序后再序列化为 JSON，杜绝因遍历无序导致 Schema 文本漂移；
2. **军规二：动态探针（时间、Git）绝不上移**：
   - 严禁将 `Today's date is 2026-08-19` 或 `gitStatus` 放在 System Prompt 顶部；
   - 必须将其放入 System Prompt 的最尾部，或包装在 `System-Reminder` 消息块中，确保其上方的全部静态指令 100% 稳定命中 Cache；
3. **军规三：合理安插 Ephemeral 断点（最多 4 个）**：
   - Anthropic API 允许显式标记 `{"cache_control": {"type": "ephemeral"}}`；
   - 将断点分别锚定在：① 静态指令结束处、② 工具声明结束处、③ 压缩摘要结束处、④ 倒数第二轮对话结束处；
4. **军规四：账号路由亲和性绑定（Account Affinity）**：
   - 在支持多账号负载均衡的网关（如 `ai_home`）中，同一个 Session ID 的连续请求必须通过哈希粘性（Sticky Session）路由到同一个底层上游账号，避免因切换 Token 凭据导致服务端 KV Cache 完全失效。

---

## 6. 上下文管理器底层数据结构与源码解构

### 6.1 TypeScript 核心数据结构定义

```typescript
/**
 * 消息块与缓存控制结构
 */
export interface CacheControl {
  type: 'ephemeral';
}

export interface ContextMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
  tokenCount?: number;
  cacheControl?: CacheControl;
  isPruned?: boolean;
  timestamp: number;
}

/**
 * 上下文滑动窗口治理器配置
 */
export interface ContextCompactorOptions {
  maxContextTokens: number;        // 硬上限 (如 200,000)
  compactionTriggerTokens: number; // 软水位 (如 160,000, 80%)
  headroomReserveTokens: number;   // 预留净空 (如 16,000)
  minActiveTurnsToKeep: number;    // 压缩时保留的最近活跃轮数 (如 4 轮)
}

/**
 * 压缩状态汇总报告
 */
export interface CompactionReport {
  sessionId: string;
  tokensBefore: number;
  tokensAfter: number;
  prunedToolResultsCount: number;
  compactedTurnCount: number;
  durationMs: number;
}
```

### 6.2 上下文压缩与微观剪枝核心调度引擎实现

```typescript
export class ContextOrchestrator {
  private messages: ContextMessage[] = [];
  private options: ContextCompactorOptions;

  constructor(options: ContextCompactorOptions) {
    this.options = options;
  }

  /**
   * 计算当前上下文的总估算 Token 数 (包含历史与系统区)
   */
  public calculateTotalTokens(): number {
    return this.messages.reduce((acc, msg) => acc + (msg.tokenCount || 0), 0);
  }

  /**
   * 每轮迭代前执行的水位线治理主逻辑
   */
  public async ensureContextWithinBudget(llmSummarizer: (history: ContextMessage[]) => Promise<string>): Promise<CompactionReport | null> {
    const totalTokens = this.calculateTotalTokens();
    
    // 未触达警戒水位线，直接放行
    if (totalTokens < this.options.compactionTriggerTokens) {
      return null;
    }

    const startTime = Date.now();
    let prunedCount = 0;

    // Phase 1: 优先执行微观启发式剪枝 (Micro Pruning)
    prunedCount = this.applyMicroPruning();
    const tokensAfterMicro = this.calculateTotalTokens();

    // 若微观剪枝后已回落至安全水位 (例如 < 70%)，则跳过耗时的 LLM 宏观压缩
    if (tokensAfterMicro < this.options.compactionTriggerTokens * 0.9) {
      return {
        sessionId: 'active_session',
        tokensBefore: totalTokens,
        tokensAfter: tokensAfterMicro,
        prunedToolResultsCount: prunedCount,
        compactedTurnCount: 0,
        durationMs: Date.now() - startTime
      };
    }

    // Phase 2: 执行宏观语义自动滚扎压缩 (Macro Semantic Compaction)
    const activeStartIndex = Math.max(0, this.messages.length - this.options.minActiveTurnsToKeep);
    const targetHistoryToCompact = this.messages.slice(1, activeStartIndex); // 保留第0项SystemPrompt与最近Active轮
    const activeMessages = this.messages.slice(activeStartIndex);

    // 调用专门的轻量级 Agent 提炼 XML 结构化摘要
    const summaryXml = await llmSummarizer(targetHistoryToCompact);

    // 构造压缩摘要消息帧，置入 Prompt Cache 标记
    const summaryMessage: ContextMessage = {
      id: `compact_summary_${Date.now()}`,
      role: 'user',
      content: `[System State Update: The previous ${targetHistoryToCompact.length} conversation turns have been compacted into the following verified state tree]:\n${summaryXml}`,
      tokenCount: Math.ceil(summaryXml.length / 3.5),
      cacheControl: { type: 'ephemeral' },
      timestamp: Date.now()
    };

    // 重组消息队列：System Message + Compacted Summary + Active Messages
    const systemMessage = this.messages[0];
    this.messages = [systemMessage, summaryMessage, ...activeMessages];

    const tokensFinal = this.calculateTotalTokens();

    return {
      sessionId: 'active_session',
      tokensBefore: totalTokens,
      tokensAfter: tokensFinal,
      prunedToolResultsCount: prunedCount,
      compactedTurnCount: targetHistoryToCompact.length,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * 微观剪枝：扫描陈旧的大型 Tool Results 并进行就地折叠
   */
  private applyMicroPruning(): number {
    let count = 0;
    const thresholdIndex = this.messages.length - this.options.minActiveTurnsToKeep;

    for (let i = 1; i < thresholdIndex; i++) {
      const msg = this.messages[i];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 800) {
            block.content = `[Tool output truncated. Status: EXECUTED, length: ${block.content.length} chars. Full logs in WAL.]`;
            msg.tokenCount = Math.ceil(JSON.stringify(msg.content).length / 3.5);
            msg.isPruned = true;
            count++;
          }
        }
      }
    }
    return count;
  }
}
```

---

## 7. 压缩状态时序流与核心调用栈

### 7.1 自动压缩（Auto-Compaction）时序图 (Compaction Sequence)

```mermaid
sequenceDiagram
    autonumber
    participant Loop as ReAct Event Loop
    participant Orchestrator as Context Orchestrator
    participant Pruner as Micro Pruning Engine
    participant Subagent as Compaction Subagent (LLM)
    participant WAL as 本地事件日志 (JSONL)

    Loop->>Orchestrator: 轮次结束，提交当前上下文进行安全检查
    Orchestrator->>Orchestrator: 计算 Total Tokens (当前: 172,000 / 200,000)
    
    Note over Orchestrator: 超过 80% 水位线 (160,000)，触发治理流水线

    Orchestrator->>Pruner: Step 1: 执行本地启发式微观剪枝
    Pruner->>Pruner: 扫描并折叠 3 轮前的超长 tool_result
    Pruner-->>Orchestrator: 剪枝完成 (Token 降至 165,000，仍 > 80%)

    Orchestrator->>Subagent: Step 2: 提取历史区间 [1, N-4]，唤起子代理总结
    activate Subagent
    Subagent->>Subagent: 分析 Intent、Milestones、Modified Files
    Subagent-->>Orchestrator: 返回结构化 XML 状态树 (<compacted_context> ~2,000 tokens)
    deactivate Subagent

    Orchestrator->>WAL: 记录 CompactionEvent (含剪枝元数据与状态快照)
    Orchestrator->>Orchestrator: 重组 Context Tree (System + Summary + Recent Active)
    Orchestrator->>Orchestrator: 刷新 Token 计数 (当前: 38,000 tokens，降幅 77%)
    
    Orchestrator-->>Loop: 上下文健康就绪 (Compaction Completed)，继续下一轮 ReAct
```

### 7.2 核心源码级调用栈 (Source Call Stack)

```
[AgentEventLoop.tick] (lib/runtime/agent-event-loop.ts:188)
  │
  └── [ContextOrchestrator.ensureContextWithinBudget] (lib/context/orchestrator.ts:72)
        │
        ├── [ContextOrchestrator.calculateTotalTokens] (lib/context/token-counter.ts:25)
        │
        ├── [MicroPruner.execute] (lib/context/pruners/micro-pruner.ts:40)
        │     ├── [ToolResultCollapser.collapseOldObservations]
        │     └── [ReadCacheManager.evictSupersededReads]
        │
        └── [MacroCompactor.compactHistory] (lib/context/compactors/macro-compactor.ts:85)
              ├── [HistorySplitter.splitActiveHorizon] (lib/context/splitter.ts:31)
              ├── [CompactionSubagent.generateSummaryXml] (lib/agents/compaction-agent.ts:60)
              │     └── [LLMClient.postOneShot] (lib/models/client.ts:110)
              ├── [PromptCacheMarker.injectEphemeralBreaks] (lib/context/cache-marker.ts:18)
              └── [WALStorage.appendCompactionSnapshot] (lib/storage/wal.ts:92)
```

---

## 8. 极端异常边界与防御治理策略

| 异常边界场景 | 物理成因与危害 | Harness 核心防线与自愈算法 (Self-Healing) |
| :--- | :--- | :--- |
| **1. 压缩子代理自身超时或崩溃 (Compactor Crash)** | 宏观压缩调用的 LLM API 遇到 500 错误、网络中断或超时，导致压缩流程挂起。 | **退避降级与激进微观剪枝（Aggressive Fallback）**：<br>设置 15s 硬超时。若 LLM 压缩失败，系统**绝不中断主任务**，而是自动降级到本地纯规则的激进剪枝模式：直接强行丢弃最陈旧的 50% 历史消息，并注入固定文本模板：`"[Warning: System history pruned due to compaction timeout. Key context preserved in recent turns]"`。 |
| **2. 压缩摘要信息幻觉丢失 (Information Loss)** | 压缩模型遗漏了用户最初提出的某个微妙约束（如“不要修改 package.json”）。 | **锚定不可变意图（Pinned Immutable Goal）**：<br>用户的第 0 轮原始 Prompt（Initial User Instruction）被永久标记为 `PINNED`，绝对禁止被任何微观剪枝或宏观压缩丢弃，它与 System Prompt 一同作为不可动摇的最高准则始终存在。 |
| **3. 震荡压缩（Thrashing Compaction）** | 每次压缩后释放的 Token 极少，导致接下来的每一轮都重复触发耗时的宏观压缩。 | **指数级压缩冷却与最小清理阈值**：<br>1. 压缩操作完成后，设置至少 5 轮的 `Compaction Cooldown` 冷却期；<br>2. 压缩算法要求单次必须至少释放总容量的 30% 以上（如从 80% 降至 50% 以下），若压缩后仍超标，强制扩大历史裁剪窗口。 |
| **4. 缓存断裂雪崩（Cache Busting Cascade）** | 每次压缩都修改了最头部的 System Prompt，导致上游厂商所有用户的 KV Cache 整体失效。 | **追加式摘要注入（Append-only Summary Insertion）**：<br>严格禁止修改已缓存的 System Prompt 前缀，压缩摘要只能作为第一条 User Message 或特定注入块追加，确保头部静态 Cache 命中率永远为 100%。 |

---

## 9. 对 ai_home 自主 Harness 研发的落地指导与架构设计

在 `ai_home` 项目开发高性能自主 Agent Harness 运行时的过程中，上下文治理模块必须严格落地以下三大设计规范：

### 9.1 架构设计一：落地 `ContextTokenBudgeter` 毫秒级分级监控
- **当前现状**：目前网关层主要以全量透传为主，缺少对长程会话上下文水位的实时度量。
- **重构方案**：
  1. 在 `lib/context/` 下引入轻量级 Token 估算器（基于 `tiktoken` 或字符比率快速估算）；
  2. 在每一轮请求进出时动态更新 `currentTotalTokens`，并划分 `75% (Warn)`、`80% (Auto-Compact)`、`90% (Hard-Truncate)` 三级水位线；
  3. 当触发 80% 水位时，自动异步启动 Compaction 流水线。

### 9.2 架构设计二：建立分层微观剪枝管道（Micro Pruning Pipeline）
- **落地方案**：
  1. 实现 `ObservationCollapser`：在组装大模型请求消息时，自动扫描超过 3 轮以前的 `tool_result`，对超长文本（>1KB）执行本地行数折叠；
  2. 实现 `ReadDeduplicator`：对同一文件的多次全量读取历史进行去重，只保留最新一次的读取内容；
  3. 将剪枝前后的完整原始内容保留在 `~/.aih/sessions/<id>.jsonl` 中，保证审计日志完整，而进网关的 Prompt 实现轻量化。

### 9.3 架构设计三：实施 Prompt Cache 字节级锁定与账号粘性路由
- **落地方案**：
  1. **固定 System 提示词结构**：将 `ai_home` 系统的角色、操作规则与工具 Schema 严格固定在 Prompt 头部，并在末尾显式注入 `cache_control: { type: "ephemeral" }`；
  2. **会话账号亲和性（Session-Account Sticky Routing）**：在负载均衡调度器（`model-account-pool-selector`）中，确保同一个会话的所有轮次优先路由至同一个上游账号凭据槽，使上游 Prompt Cache 命中率提升至 90% 以上，直接降低 80% 的模型推理延迟与成本。

---

## 10. 本章小结与下章预告

本章全面解构了现代 Agent Harness 的上下文滑动窗口、Token 预算治理、微观/宏观双层压缩机制以及 Prompt Cache 字节级对齐工程，提供了详尽的数据结构、算法时序与边界防御方案，并为 `ai_home` 的上下文管理中枢制定了明确的重构规范。

在下一章 **【01-04 多 Agent 协同编排：Fork 机制、Workflow 与并发隔离】** 中，我们将探讨如何突破单 Agent 上下文与算力瓶颈，深入剖析 Claude Code 的子代理派生（Fork）、声明式工作流编排（Workflow）以及基于 Git Worktree 的多 Agent 并发隔离机制。
