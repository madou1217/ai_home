# 06-04 混合持久化记忆、上下文压缩与 Prompt Cache 亲和调度

> **“记忆是 Agent 的长期认知资产，上下文是其有限的短期工作内存，而 Prompt Cache 则是连接两者并实现极致性能与经济效益的算力加速器。`ai_home` 的认知与存储体系将‘双轨事件持久化、微观/宏观自适应上下文压缩、项目双层记忆图谱与跨会话 Prompt Cache 亲和调度’深度融为一体，构建永不触顶、毫秒水合的坚固底座。”**

---


<div class="ai-concept-hero">
  <img src="/docs/harness-book/assets/images/06-04-hybrid-memory.jpg" alt="混合持久化存储与 Prompt Cache 亲和中枢 (Hybrid Storage & Prompt Cache Affinity)" loading="lazy" />
  <div class="ai-hero-caption">
    <div class="hero-cap-title"><span>🎨</span> 混合持久化存储与 Prompt Cache 亲和中枢 (Hybrid Storage & Prompt Cache Affinity)</div>
    <span class="hero-cap-badge">AI 8K Concept</span>
  </div>
</div>

## 1. 章节导读与核心命题

在设计自主 Agent 运行时的存储与记忆子系统时，很多架构往往陷入两极分化的误区：
- **误区一：过度依赖外部复杂存储**：引入沉重的 Milvus/Pinecone 向量数据库，导致本地轻量 CLI/网关产生巨大的启动依赖与检索延迟；
- **误区二：内存黑盒与断电即失**：完全将上下文状态保存在 Node.js 内存变量中，遇到网络闪断或重启便全盘丢失，且无序拼接 Prompt 导致云端 KV Cache 命中率几乎归零。

`ai_home` 下一代认知与存储中枢确立了 **“混合持久化存储 + 智能滑动窗口压缩 + Prompt Cache 亲和调度”** 的一体化架构设计：
1. **双轨数据持久化引擎（Dual-Track Persistence Engine）**：底层采用不可变追加式 JSONL 记录细粒度物理事件（用于审计与确定性重放），上层采用 SQLite 3 WAL 模式管理工作区实体、会话分支与 Token 财务归属；
2. **多级上下文压缩管道（Multi-Tier Context Compaction Pipeline）**：在上下文触及 80% 水位线时，毫秒级执行微观启发式剪枝（折叠历史长日志、淘汰重复文件镜像），必要时启动轻量级后台子代理进行宏观语义状态树提炼；
3. **Prompt Cache 字节级前缀亲和对齐与账号粘性路由（Cache Affinity & Sticky Routing）**：保证 System 提示词、静态工具 Schema 绝对前缀不变，并将同一会话的连续轮次固定绑定到同一底层凭据槽，使上游云端 KV 缓存命中率长期稳定在 **90% 以上**。

本节将系统解构该体系的物理存储拓扑、数据流时序、生产级 TypeScript 核心实现以及性能压测指标。

<div class="rich-diagram-box">
  <div class="diagram-header-tag">Byte-Level Cache Layout</div>
  <div class="diagram-title"><span>⚡</span> ai_home Prompt Cache 四段式字节级对齐布局</div>
  <div class="harness-stack">
    <div class="tech-card blue"><div class="card-label">Byte 0: 静态基础系统前缀 (System Base)</div><div class="card-sub">角色设定与代码质量军规 ── 100% 命中 Cache</div></div>
    <div class="flow-connector">⬇️ Breakpoint 1: {"cache_control": {"type": "ephemeral"}}</div>
    <div class="tech-card purple"><div class="card-label">静态工具声明 (Built-in + MCP Tools)</div><div class="card-sub">字典序严格排序，保持哈希稳定 ── 100% 命中 Cache</div></div>
    <div class="flow-connector">⬇️ Breakpoint 2: {"cache_control": {"type": "ephemeral"}}</div>
    <div class="tech-card green"><div class="card-label">项目记忆与压缩摘要 (&lt;compacted_state&gt;)</div><div class="card-sub">MEMORY.md 索引 + 状态树 ── 95% 增量命中</div></div>
    <div class="flow-connector">⬇️ 活跃工作交互窗口 (Active Turns)</div>
    <div class="tech-card orange"><div class="card-label">最近 2 轮 Active Turns (User Prompt + Action + Result)</div><div class="card-sub">增量 Prefill 仅消耗 500 ~ 1,500 Tokens (TTFT &lt; 180ms)</div></div>
  </div>
</div>

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
