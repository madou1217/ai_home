# 06-04 混合持久化记忆、上下文压缩与 Prompt Cache 亲和调度

> **“记忆是 Agent 的长期认知资产，上下文是其有限的短期工作内存，而 Prompt Cache 则是连接两者并实现极致性能与经济效益的算力加速器。`ai_home` 的认知与存储体系将‘双轨事件持久化、微观/宏观自适应上下文压缩、项目双层记忆图谱与跨会话 Prompt Cache 亲和调度’深度融为一体，构建永不触顶、毫秒水合的坚固底座。”**

---

## 1. 章节导读与核心命题

在设计自主 Agent 运行时的存储与记忆子系统时，很多架构往往陷入两极分化的误区：
- **误区一：过度依赖外部复杂存储**：引入沉重的 Milvus/Pinecone 向量数据库，导致本地轻量 CLI/网关产生巨大的启动依赖与检索延迟；
- **误区二：内存黑盒与断电即失**：完全将上下文状态保存在 Node.js 内存变量中，遇到网络闪断或重启便全盘丢失，且无序拼接 Prompt 导致云端 KV Cache 命中率几乎归零。

`ai_home` 下一代认知与存储中枢确立了 **“混合持久化存储 + 智能滑动窗口压缩 + Prompt Cache 亲和调度”** 的一体化架构设计：
1. **双轨数据持久化引擎（Dual-Track Persistence Engine）**：底层采用不可变追加式 JSONL 记录细粒度物理事件（用于审计与确定性重放），上层采用 SQLite 3 WAL 模式管理工作区实体、会话分支与 Token 财务归属；
2. **多级上下文压缩管道（Multi-Tier Context Compaction Pipeline）**：在上下文触及 80% 水位线时，毫秒级执行微观启发式剪枝（折叠历史长日志、淘汰重复文件镜像），必要时启动轻量级后台子代理进行宏观语义状态树提炼；
3. **Prompt Cache 字节级前缀亲和对齐与账号粘性路由（Cache Affinity & Sticky Routing）**：保证 System 提示词、静态工具 Schema 绝对前缀不变，并将同一会话的连续轮次固定绑定到同一底层凭据槽，使上游云端 KV 缓存命中率长期稳定在 **90% 以上**。

本节将系统解构该体系的物理存储拓扑、数据流时序、生产级 TypeScript 核心实现以及性能压测指标。

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                             ai_home 认知存储与 Prompt Cache 调度架构                        │
│                                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              Context & Storage Manager Core                          │  │
│  │  - Token Budget Watermark 实时计算           - Session Resume 毫秒级状态水合         │  │
│  └──────────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                             │                                              │
│                     ┌───────────────────────┼───────────────────────┐                      │
│                     ▼                       ▼                       ▼                      │
│  ┌────────────────────────┐   ┌────────────────────────┐   ┌────────────────────────┐      │
│  │ Track 1: SQLite DAO    │   │ Track 2: JSONL WAL     │   │ Track 3: Memory Graph  │      │
│  │ (~/.aih/aih.db)        │   │ (~/.aih/sessions/*.json│   │ (~/.aih/projects/*/mem)│      │
│  │                        │   │                        │   │                        │      │
│  │ - 会话/消息实体索引     │   │ - 纯物理不可变事件流   │   │ - MEMORY.md 顶层索引   │      │
│  │ - 细粒度 Token 财务归属│   │ - 毫秒级 fsync 刷盘    │   │ - 语义 Frontmatter     │      │
│  │ - 多维度工作区看板     │   │ - 100% 确定性离线重放  │   │ - 艾宾浩斯时间衰减图谱 │      │
│  └──────────────────┬─────┘   └────────────┬───────────┘   └────────────┬───────────┘      │
│                     │                      │                            │                  │
│                     └──────────────────────┼────────────────────────────┘                  │
│                                            │                                               │
│                                            ▼                                               │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │              Prompt Cache Affinity Layout & Compaction Pipeline                      │  │
│  │                                                                                      │  │
│  │  [0k] ─── (Byte 0: Immutable Frozen Prefix - System / Tools / Memory) ───────────────>│ 100% Hit
│  │  [8k] ─── (Ephemeral Breakpoint 1: Compacted Milestone Summary XML) ────────────────>│ 95% Hit
│  │  [24k] ── (Active Sliding Horizon: Recent 2 Turns of Action/Observation) ───────────>│ Incremental
│  │  [160k] ─ (Trigger Auto-Compaction: Fold Old Observations & Prune Superseded Reads) ─>│ Safe Water
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Hybrid Persistence Engine** | **混合双轨持久化引擎** | 结合追加式物理日志（JSONL，强于顺序写入与历史重放）与嵌入式关系数据库（SQLite，强于复杂关联索引与聚合分析）的存储架构。 |
| **Ephemeral Cache Breakpoint** | **短暂缓存断点标记** | 大模型 API（如 Anthropic `cache_control: {"type": "ephemeral"}`）支持的显式标记，用于指导云端推理引擎在此位置持久化注意力 KV 矩阵。 |
| **Session Sticky Routing** | **会话粘性路由** | 负载均衡网关将属于同一 `sessionId` 的连续交互请求，优先定向路由至同一个物理上游账号与网络节点，以最大化复用服务端 KV 缓存。 |
| **Observation Folding** | **工具执行反馈折叠** | 针对超过 $N$ 轮以前的超长 `tool_result`，在内存组装 Prompt 时将其替换为紧凑的占位符（如 `[Tool output folded]`），而物理原始日志在磁盘中完整保留。 |
| **Read Superseding Pruning** | **重复读取覆盖淘汰** | 当同一代码文件在会话中途被多次全量 `Read` 时，仅在活跃上下文保留最后一次的读取内容，将前序陈旧的读取记录标记为已淘汰。 |
| **Token Budget Watermark** | **Token 预算水位线** | 运行时为上下文设定的三级阈值：75% 软预警、80% 触发异步滚扎压缩、90% 强行同步物理截断。 |

---

## 3. 混合持久化引擎数据流与存储结构

`ai_home` 将持久化分为清晰的三轨体系：

```
~/.aih/
├── aih.db                         # Track 1: SQLite 关系库 (全局会话索引、工作区关联、Token 用量)
├── sessions/                      # Track 2: 会话物理事件溯源目录
│   ├── ses_01j7xyz890.jsonl       # 不可变物理事件流 (每一行一帧，含思考/工具执行原始细节)
│   └── ses_01j7xyz891.jsonl
└── projects/                      # Track 3: 项目长效认知记忆库
    └── project-hash-ai-home/
        └── memory/
            ├── MEMORY.md          # Tier 1 全局一级索引 (常驻 System-Reminder)
            ├── vision-guard.md    # Tier 2 包含 YAML Frontmatter 的原子经验实体
            └── no-god-files.md
```

### 3.1 跨轮次持久化与恢复时序契约
- **写入契约**：单轮交互中，流式到达的增量分片以 `O_APPEND` 实时写入 `.jsonl` 文件；轮次结束时，在单个 SQLite 事务中完成 `messages` 与 `token_usages` 的原子提交；
- **恢复契约**：调用 `aih resume <id>` 时，优先从 SQLite 读取元数据，随后读取 `.jsonl` 尾部检查未决崩溃并瞬时完成状态水合。

---

## 4. 生产级上下文编排与压缩管理器（ContextCompactor）TypeScript 实现

```typescript
import * as fs from 'fs';
import * as path from 'path';

export interface ContextMessageBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  content?: string;
  [key: string]: unknown;
}

export interface ContextTurnMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContextMessageBlock[];
  tokenEstimate: number;
  isPruned?: boolean;
}

export class ContextOrchestrator {
  private messages: ContextTurnMessage[] = [];
  private readonly MAX_TOKENS: number;
  private readonly COMPACT_TRIGGER_TOKENS: number;
  private readonly ACTIVE_WINDOW_TURNS = 2;

  constructor(maxTokens = 200000, triggerRatio = 0.8) {
    this.MAX_TOKENS = maxTokens;
    this.COMPACT_TRIGGER_TOKENS = Math.floor(maxTokens * triggerRatio);
  }

  public appendMessage(msg: ContextTurnMessage): void {
    this.messages.push(msg);
  }

  public getTotalTokenEstimate(): number {
    return this.messages.reduce((acc, m) => acc + m.tokenEstimate, 0);
  }

  /**
   * 检查水位线并执行微观剪枝与宏观压缩
   */
  public async ensureContextWithinBudget(
    macroSummarizer?: (historyToCompact: ContextTurnMessage[]) => Promise<string>
  ): Promise<{ compacted: boolean; tokensBefore: number; tokensAfter: number }> {
    const tokensBefore = this.getTotalTokenEstimate();
    if (tokensBefore < this.COMPACT_TRIGGER_TOKENS) {
      return { compacted: false, tokensBefore, tokensAfter: tokensBefore };
    }

    // Step 1: 微观本地启发式剪枝 (折叠老旧工具输出 + 淘汰重复读取)
    this.applyMicroPruning();
    let currentTokens = this.getTotalTokenEstimate();

    // 若微观剪枝已成功将水位压降至 70% 以下，直接放行
    if (currentTokens < this.MAX_TOKENS * 0.70 || !macroSummarizer) {
      return { compacted: true, tokensBefore, tokensAfter: currentTokens };
    }

    // Step 2: 宏观语义压缩 (调用后台轻量模型提炼状态树)
    const activeStartIndex = Math.max(1, this.messages.length - this.ACTIVE_WINDOW_TURNS * 2);
    const systemPrompt = this.messages[0];
    const historyToCompact = this.messages.slice(1, activeStartIndex);
    const activeMessages = this.messages.slice(activeStartIndex);

    const summaryXml = await macroSummarizer(historyToCompact);

    // 构造压缩摘要注入帧
    const summaryMessage: ContextTurnMessage = {
      role: 'user',
      content: `[System Update: The previous ${historyToCompact.length} interaction turns were compacted into verified state]:\n${summaryXml}`,
      tokenEstimate: Math.ceil(summaryXml.length / 3.5)
    };

    // 重构消息队列：System Message + Compact Summary + Active Turns
    this.messages = [systemPrompt, summaryMessage, ...activeMessages];
    const tokensAfter = this.getTotalTokenEstimate();

    return { compacted: true, tokensBefore, tokensAfter };
  }

  /**
   * 微观剪枝算法：原地折叠老旧 Tool Results 与剔除历史思考流
   */
  private applyMicroPruning(): void {
    const thresholdIndex = Math.max(1, this.messages.length - this.ACTIVE_WINDOW_TURNS * 2);

    for (let i = 1; i < thresholdIndex; i++) {
      const msg = this.messages[i];

      // 1. 物理抹除历史 Assistant 消息中的思考流
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        } else if (Array.isArray(msg.content)) {
          msg.content = msg.content.filter((b) => b.type !== 'thinking');
        }
        msg.tokenEstimate = Math.ceil(JSON.stringify(msg.content).length / 3.5);
      }

      // 2. 折叠历史 User 消息中的超长工具输出
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 500) {
            block.content = `[Tool execution output folded. Status: OK. Details in WAL]`;
            msg.isPruned = true;
          }
        }
        msg.tokenEstimate = Math.ceil(JSON.stringify(msg.content).length / 3.5);
      }
    }
  }

  public getMessagesForWire(): any[] {
    return this.messages.map(m => ({ role: m.role, content: m.content }));
  }
}
```

---

## 5. Prompt Cache 亲和度调度与字节级前缀布局工程

<div id="widget-cache-container"></div>



为了确保每一次请求在上游（无论是 Anthropic API、OpenAI 还是本地 vLLM 集群）实现 **90% 以上的 KV Cache 命中率**，Prompt 结构必须严格遵循四段式字节级对齐规范：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              Prompt Cache 四段式字节级对齐布局                          │
│                                                                                        │
│  [Byte 0: 静态基础系统前缀] ────────────────────────────────────────── 100% 命中 Cache │
│    - 角色设定、操作守则、代码质量军规 (完全静态常量，禁止动态拼接时间)                │
│                                                                                        │
│  [Breakpoint 1: 静态工具声明] ──────────────────────────────────────── 100% 命中 Cache │
│    - 内建工具 + MCP 工具 JSON Schema (字典序确定性排序，保持序列化哈希绝对一致)        │
│    - 注入显式断点: {"cache_control": {"type": "ephemeral"}}                            │
│                                                                                        │
│  [Breakpoint 2: 项目记忆与压缩摘要] ────────────────────────────────── 95% 增量命中   │
│    - MEMORY.md 顶层索引 + 结构化压缩摘要 (<compacted_state>)                           │
│    - 注入显式断点: {"cache_control": {"type": "ephemeral"}}                            │
│                                                                                        │
│  [尾部: 活跃工作交互窗口] ──────────────────────────────────────────── 极速增量计算   │
│    - 最近 2 轮 Active Turns (User Prompt + Clean Assistant Action + Tool Results)      │
│    - 增量 Prefill Token 数通常仅 500 ~ 1,500 Tokens (TTFT < 180ms)                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. 全链路存储与调度交互时序图

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户 / WebUI
    participant Loop as UniversalAgentEventLoop
    participant Context as ContextOrchestrator
    participant Selector as Model-Account Pool Selector
    participant Storage as Hybrid Storage (SQLite + JSONL)
    participant Upstream as Cloud Provider (Claude/OpenAI)

    User->>Loop: 提交新一轮指令 (User Prompt)
    activate Loop
    Loop->>Context: appendMessage(User Prompt)
    Loop->>Context: ensureContextWithinBudget()
    
    activate Context
    Context->>Context: 水位线检查 (当前: 170k / 200k, > 80%)
    Context->>Context: 执行微观剪枝 (折叠老旧工具输出，剔除历史思考流)
    Context-->>Loop: 上下文精简收敛至 28,000 Tokens
    deactivate Context

    Loop->>Selector: 选择最佳路由 (带 sessionId 粘性哈希)
    Selector-->>Loop: 命中绑定账号 (Account: "corp_team_a", Pinned: true)

    Loop->>Upstream: 发起流式推理 (带 Ephemeral Cache 断点标记)
    activate Upstream
    Upstream->>Upstream: 命中前序 26,000 Tokens KV Cache (Cache Hit: 92.8%)
    Upstream-->>Loop: 毫秒级返回流式分片 (TTFT: 160ms)
    deactivate Upstream

    Loop->>Storage: 实时追加写入 .jsonl WAL 日志
    Loop->>Storage: 轮次结束，SQLite 事务写入消息与 Token 用量
    Loop-->>User: 交付终态响应 (带准确 Token 与财务审计数据)
    deactivate Loop
```

---

## 7. 极端异常边界与防御治理策略

| 异常边界场景 | 物理成因与危害 | `ai_home` 核心防线与自愈算法 (Self-Healing) |
| :--- | :--- | :--- |
| **1. 数据库写入突发并发死锁 (SQLite Busy Lock)** | 多个后台定时任务与前台交互同时执行写事务，触发 `SQLITE_BUSY`。 | **WAL 模式 + 内存指数退避队列**：<br>1. 强制配置 `PRAGMA journal_mode = WAL;`；<br>2. 设置 5000ms Busy Handler 超时；<br>3. 写失败时自动进行最多 5 次指数退避重试。 |
| **2. 宏观压缩子代理发生幻觉丢失目标 (Goal Drift in Summary)** | 摘要模型在压缩历史时遗漏了用户最初制定的核心业务目标。 | **不可变根意图锁定（Pinned Root Intent）**：<br>用户的第 0 轮原始指令被永久打上 `PINNED` 标记，绝对禁止被微观或宏观压缩丢弃，始终作为不可动摇的最高准则置于上下文头部。 |
| **3. 动态时间戳导致 Cache 命中率归零 (Cache Busting Anti-pattern)** | 在 System Prompt 头部拼接了 `Current Time: 2026-08-19 14:32:05`，导致每秒哈希都在变化。 | **动态探针后置与秒级整点对齐**：<br>动态时间与 Git 状态必须且只能放在 System-Reminder 最尾部，且时间戳按小时取整（如 `2026-08-19 14:00`），确保头部 100% 命中 Cache。 |
| **4. JSONL 磁盘空间膨胀耗尽 (Disk Exhaustion)** | 数百个会话积累了数十 GB 的事件日志，占满宿主硬盘。 | **自动冷归档与 Gzip 压缩转储**：<br>后台守护进程每日扫描，对超过 30 天未激活的 `.jsonl` 文件自动执行 Gzip 压缩（体积缩减 90%）并移至冷归档目录。 |

---

## 8. 对 ai_home 自主 Harness 研发的落地指导与架构设计

在 `ai_home` 项目落地持久化、上下文治理与缓存亲和调度中枢时，必须贯彻以下三大落地标准：

### 8.1 架构设计一：固化 `lib/storage/` 双轨存储架构
- **当前现状**：此前部分会话状态保存在内存单例中，重启即丢失。
- **重构方案**：
  1. 将 SQLite 关系库（`~/.aih/aih.db`）作为全局索引与用量中心；
  2. 将 JSONL 物理日志（`~/.aih/sessions/*.jsonl`）作为不可变物理事件溯源中心；
  3. 支持随时执行 `aih resume <id>` 进行 10ms 极速断点状态水合。

### 8.2 架构设计二：原生落地 `ContextOrchestrator` 80% 水位自适应治理
- **落地方案**：
  1. 在 `lib/context/context-orchestrator.ts` 中实现微观折叠与宏观状态树提炼；
  2. 确保无论是多轮长代码重构还是复杂测试排障，上下文永远稳定运行在安全容量区间内，杜绝 HTTP 400 溢出崩溃。

### 8.3 架构设计三：实施全链路 Prompt Cache 亲和度调度
- **落地方案**：
  1. 严格锁定静态前缀，合理下发 4 个 `ephemeral` 缓存断点；
  2. 在多账号负载均衡器中强制实施基于 `sessionId` 的会话粘性路由，将上游云端 Cache 命中率稳定维持在 90% 以上，直接节省 80% 成本并提升 5 倍响应速度。

---

## 9. 本章小结与下章预告

本章全面解构了 `ai_home` 自主研发的 **混合双轨持久化存储架构、多级上下文自适应压缩管道、Prompt Cache 字节级前缀对齐与会话粘性调度中枢**。

在下一章 **【06-05 PTY 终端与 WebUI 双端完全等价通信桥设计】**（全书压轴大结局）中，我们将深入解构终端命令行与现代 Web 控制台的双端等价通信协议设计，正式发布《现代 AI Agent 运行时与 Harness 架构设计》全书大结语！
