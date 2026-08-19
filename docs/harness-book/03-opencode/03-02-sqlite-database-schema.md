# 03-02 SQLite 实体关系（opencode.db 会话/消息/用量归属模型）

> **“在多工作区、多模型并发与团队协同的复杂 Agent 系统中，数据持久化不仅是为了记录聊天记录，更是为了构建精确到分片（Chunk）与多维度标签的会话拓扑、用量归属（Cost Attribution）与工作区资产图谱。`opencode.db` 的关系模型为开源 Agent 存储设计树立了标准化典范。”**

---

## 1. 章节导读与核心命题

随着 Agent 深入企业级团队与多项目管理，一个看似简单的本地持久化需求往往迅速演变为复杂的领域模型挑战：
1. **多工作区（Multi-Workspace）与目录漂移**：同一个开发者在多个 Git 仓库间切换，或者在同一个仓库内开启多个并行分支任务，会话必须能够准确绑定物理目录并支持重定位；
2. **消息分块与多模态内容建模（Chunk & Modality Modeling）**：单条消息中交织着用户文本、模型思考（`<think>`）、多次结构化工具调用（Tool Calls）与工具执行反馈（Tool Results），传统的 `messages(role, content)` 单字段模型在面对复杂审计与分页时彻底瓦解；
3. **多租户/多账号 Token 用量精确归属（Granular Token Attribution）**：在多账号负载均衡池中，每一次 API 调用的 Input Tokens、Output Tokens、Cache Read Tokens 必须精准归属到特定工作区、特定会话以及特定底层凭据（Account Identity），否则团队计费与限流熔断将彻底失控。

**OpenCode** 通过其核心的单文件嵌入式数据库 **`opencode.db`**，设计了一套高度规范化、支持长事务与精细化统计的关系型实体模型体系。

本节将深入解构 `opencode.db` 的核心 ER 实体关系图、DDL 索引设计、用量归属聚合算法以及并发事务隔离实践。

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                             opencode.db 核心实体关系拓扑全景图                             │
│                                                                                            │
│  ┌─────────────────────────┐                                                               │
│  │       workspaces        │ (工作区/仓库实体)                                              │
│  │ ─────────────────────── │                                                               │
│  │ PK: id                  │                                                               │
│  │     path (绝对路径)     │                                                               │
│  │     name, created_at    │                                                               │
│  └───────────┬─────────────┘                                                               │
│              │ 1:N                                                                         │
│              ▼                                                                             │
│  ┌─────────────────────────┐          1:N          ┌────────────────────────────────────┐  │
│  │        sessions         │ ────────────────────> │              messages              │  │
│  │ ─────────────────────── │                       │ ────────────────────────────────── │  │
│  │ PK: id                  │                       │ PK: id                             │  │
│  │ FK: workspace_id        │                       │ FK: session_id                     │  │
│  │     title, model        │                       │     role (user/assistant/system)   │  │
│  │     status, parent_id   │                       │     turn_index, created_at         │  │
│  │     pinned_account_key  │                       └─────────────────┬──────────────────┘  │
│  └───────────┬─────────────┘                                         │                     │
│              │                                                       │ 1:N                 │
│              │ 1:N                                                   ▼                     │
│              │                                     ┌────────────────────────────────────┐  │
│              │                                     │            message_parts           │  │
│              │                                     │ ────────────────────────────────── │  │
│              │                                     │ PK: id                             │  │
│              │                                     │ FK: message_id                     │  │
│              │                                     │     part_type (text/thinking/call) │  │
│              │                                     │     content_text, json_payload     │  │
│              │                                     │     seq_order (顺序序号)           │  │
│              │                                     └────────────────────────────────────┘  │
│              │                                                                             │
│              ▼ 1:N                                                                         │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                    token_usages                                      │  │
│  │ ──────────────────────────────────────────────────────────────────────────────────── │  │
│  │ PK: id | FK: session_id | FK: message_id | model_id | account_unique_key             │  │
│  │      input_tokens | output_tokens | cache_read_tokens | cache_write_tokens | cost    │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Relational Schema** | **关系型数据库模式** | 数据库中关于表、字段、数据类型、主外键约束及实体间关联关系的结构化定义集合。 |
| **Granular Token Attribution** | **细粒度 Token 消耗归属** | 将大模型 API 产生的每一次 Token 消耗精确关联至 `(Workspace, Session, Turn, Model, AccountKey)` 五元组的财务计量与限流审计机制。 |
| **Message Part / Chunk** | **消息内容分片** | 将复合消息（包含文本、推理思维链、工具调用参数、工具执行结果）解构为可独立索引与序列化的原子分片实体。 |
| **Session Hierarchy (Fork/Tree)** | **会话分支层级树** | 通过 `parent_id` 构成的有向无环图（DAG），支持用户或 Agent 从历史某个特定轮次“分叉（Fork）”出一条独立探索子分支。 |
| **Pinned Account Key** | **固定账号绑定键** | 会话元数据中持久化绑定的账号唯一哈希（Unique Account Key），确保该会话的所有后续交互严格命中同一账号凭据以最大化利用 Prompt Cache。 |
| **Foreign Key Cascading** | **外键级联删除/更新** | 关系型数据库特性。当父表记录（如某个 `workspace` 或 `session`）被物理删除时，数据库底层自动同步删除关联的子表记录（`messages`、`token_usages`）。 |

---

## 3. `opencode.db` 核心 DDL 建表规范与索引设计

为了兼顾高频流式写入、毫秒级全文检索与复杂多维报表统计，`opencode.db` 遵循了严格的第 3 范式（3NF）与针对性的非聚簇索引设计。

```sql
-- 开启外键约束与高性能预写式日志
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ==========================================================
-- 1. 工作区/仓库表 (workspaces)
-- ==========================================================
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,          -- 物理工作区绝对路径 (规范化后)
    name TEXT NOT NULL,                  -- 工作区显示别名
    active_branch TEXT,                  -- 当前 Git 分支快照
    git_origin_url TEXT,                 -- 远端仓库 URL
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- ==========================================================
-- 2. 会话主表 (sessions)
-- ==========================================================
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    parent_id TEXT,                      -- 父会话 ID (用于 Fork 分叉追溯)
    title TEXT NOT NULL,                 -- 会话标题 (自动生成或用户设定)
    model TEXT NOT NULL,                 -- 默认选用模型 (如 claude-opus-5)
    status TEXT CHECK(status IN ('ACTIVE', 'ARCHIVED', 'COMPACTED', 'FAILED')) DEFAULT 'ACTIVE',
    pinned_account_key TEXT,             -- 绑定的账号唯一标识 (Sticky Account)
    total_tokens_spent INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_id) REFERENCES sessions(id) ON DELETE SET NULL
);

-- ==========================================================
-- 3. 对话消息主表 (messages)
-- ==========================================================
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT CHECK(role IN ('user', 'assistant', 'system')) NOT NULL,
    turn_index INTEGER NOT NULL,         -- 交互轮次序号 (从 1 递增)
    created_at INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- ==========================================================
-- 4. 消息原子分片表 (message_parts) - 结构化解耦核心
-- ==========================================================
CREATE TABLE IF NOT EXISTS message_parts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    seq_order INTEGER NOT NULL,          -- 单条消息内的部件排列序号 (0, 1, 2...)
    part_type TEXT CHECK(part_type IN ('text', 'thinking', 'tool_use', 'tool_result', 'image')) NOT NULL,
    content_text TEXT,                   -- 纯文本、思考链或日志内容
    json_payload TEXT,                   -- 结构化参数 (Tool Call Input / Result 元数据)
    is_truncated INTEGER DEFAULT 0,      -- 是否触发了过长截断标记
    created_at INTEGER NOT NULL,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- ==========================================================
-- 5. Token 用量与财务计量表 (token_usages)
-- ==========================================================
CREATE TABLE IF NOT EXISTS token_usages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    model_id TEXT NOT NULL,              -- 真实上游模型 ID
    account_unique_key TEXT NOT NULL,    -- 扣费账号唯一凭据标识
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL DEFAULT 0.0,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- ==========================================================
-- 高性能查询索引集合
-- ==========================================================
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn_index ASC);
CREATE INDEX IF NOT EXISTS idx_message_parts_message ON message_parts(message_id, seq_order ASC);
CREATE INDEX IF NOT EXISTS idx_token_usages_account ON token_usages(account_unique_key, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_token_usages_session ON token_usages(session_id);
```

---

## 4. 细粒度 Token 用量归属与多维财务统计模型

在企业研发与多账号调度中，管理员需要清晰回答三个关键问题：
1. **项目成本**：“前端项目 `apps/web` 本周总共消耗了多少 Token，折合多少美元？”
2. **账号分摊**：“企业 Team 账号本月被哪些会话使用，是否存在异常刷量？”
3. **缓存效益**：“Prompt Cache 机制为我们节省了多少比例的 Input Token？”

通过 `token_usages` 表的规范化建模，Harness 可以执行极速 SQL 聚合查询：

```sql
-- 统计指定工作区在过去 7 天内按模型与账号细分的用量与节省率
SELECT 
    tu.model_id,
    tu.account_unique_key,
    COUNT(DISTINCT tu.session_id) AS total_sessions,
    SUM(tu.input_tokens) AS raw_input_tokens,
    SUM(tu.cache_read_tokens) AS cached_tokens,
    ROUND(CAST(SUM(tu.cache_read_tokens) AS REAL) / (SUM(tu.input_tokens) + SUM(tu.cache_read_tokens)) * 100, 2) AS cache_hit_rate_pct,
    SUM(tu.output_tokens) AS total_output_tokens,
    ROUND(SUM(tu.estimated_cost_usd), 4) AS total_cost_usd
FROM token_usages tu
JOIN sessions s ON tu.session_id = s.id
JOIN workspaces w ON s.workspace_id = w.id
WHERE w.path = '/Users/model/projects/feature/ai_home'
  AND tu.timestamp >= (strftime('%s', 'now') - 7 * 86400) * 1000
GROUP BY tu.model_id, tu.account_unique_key
ORDER BY total_cost_usd DESC;
```

---

## 5. 存储层数据访问对象（DAO）TypeScript 核心实现

以下是基于 Node.js `better-sqlite3` 实现的 `OpenCodeDatabaseManager` 核心持久化代码：

```typescript
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

export interface InsertMessageParam {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  turnIndex: number;
  parts: Array<{
    partType: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';
    contentText?: string;
    jsonPayload?: Record<string, unknown>;
  }>;
  usage?: {
    modelId: string;
    accountKey: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
}

export class OpenCodeDatabaseManager {
  private db: Database.Database;

  constructor(dbDir: string) {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'opencode.db');
    this.db = new Database(dbPath);
    this.setupPragmasAndTables();
  }

  private setupPragmasAndTables(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    // 执行前述建表 DDL (略)
  }

  /**
   * 事务性保存单轮对话产生的一整条 Message 及其所有原子部件与 Token 用量
   */
  public saveTurnMessageTransaction(param: InsertMessageParam): string {
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    
    // 使用原子事务包裹，保证所有部件与 Token 记录要么全部落盘，要么全部回滚
    const insertTx = this.db.transaction(() => {
      // 1. 插入消息主记录
      const stmtMsg = this.db.prepare(`
        INSERT INTO messages (id, session_id, role, turn_index, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmtMsg.run(messageId, param.sessionId, param.role, param.turnIndex, Date.now());

      // 2. 批量插入消息部件 (Message Parts)
      const stmtPart = this.db.prepare(`
        INSERT INTO message_parts (id, message_id, seq_order, part_type, content_text, json_payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      param.parts.forEach((part, index) => {
        const partId = `part_${messageId}_${index}`;
        stmtPart.run(
          partId,
          messageId,
          index,
          part.partType,
          part.contentText || null,
          part.jsonPayload ? JSON.stringify(part.jsonPayload) : null,
          Date.now()
        );
      });

      // 3. 若存在 Token 结算信息，记录用量归属
      if (param.usage) {
        const usageId = `use_${messageId}`;
        const stmtUsage = this.db.prepare(`
          INSERT INTO token_usages (id, session_id, message_id, model_id, account_unique_key, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmtUsage.run(
          usageId,
          param.sessionId,
          messageId,
          param.usage.modelId,
          param.usage.accountKey,
          param.usage.inputTokens,
          param.usage.outputTokens,
          param.usage.cacheReadTokens,
          param.usage.cacheWriteTokens,
          param.usage.costUsd,
          Date.now()
        );

        // 4. 原子更新 Session 维度的累积消耗
        const stmtUpdateSession = this.db.prepare(`
          UPDATE sessions 
          SET total_tokens_spent = total_tokens_spent + ?, updated_at = ?
          WHERE id = ?
        `);
        stmtUpdateSession.run(param.usage.inputTokens + param.usage.outputTokens, Date.now(), param.sessionId);
      }
    });

    insertTx();
    return messageId;
  }

  /**
   * 极速水合加载会话的完整历史上下文
   */
  public hydrateSessionHistory(sessionId: string): Array<{ role: string; parts: any[] }> {
    const stmt = this.db.prepare(`
      SELECT m.id AS message_id, m.role, m.turn_index, p.seq_order, p.part_type, p.content_text, p.json_payload
      FROM messages m
      JOIN message_parts p ON m.id = p.message_id
      WHERE m.session_id = ?
      ORDER BY m.turn_index ASC, p.seq_order ASC
    `);

    const rows = stmt.all(sessionId) as any[];
    const messageMap = new Map<string, { role: string; parts: any[] }>();

    for (const row of rows) {
      if (!messageMap.has(row.message_id)) {
        messageMap.set(row.message_id, { role: row.role, parts: [] });
      }
      messageMap.get(row.message_id)!.parts.push({
        partType: row.part_type,
        contentText: row.content_text,
        jsonPayload: row.json_payload ? JSON.parse(row.json_payload) : undefined
      });
    }

    return Array.from(messageMap.values());
  }
}
```

---

## 6. 持久化交互时序图与核心源码调用栈

### 6.1 轮次消息与用量事务落盘时序图 (Persistence Sequence)

```mermaid
sequenceDiagram
    autonumber
    participant Loop as Agent Event Loop
    participant DB as OpenCodeDatabaseManager
    participant SQLite as SQLite Core (opencode.db WAL)
    participant UI as WebUI / Terminal Status

    Loop->>Loop: 完成当前轮次 ReAct 交互 (Assistant 文本 + Tool Calls + Token 用量)
    
    Loop->>DB: 调用 saveTurnMessageTransaction(param)
    activate DB
    DB->>SQLite: BEGIN IMMEDIATE TRANSACTION
    
    DB->>SQLite: 1. INSERT INTO messages (role: 'assistant', turn_index: 2)
    DB->>SQLite: 2. 批量 INSERT INTO message_parts (thinking / text / tool_use)
    DB->>SQLite: 3. INSERT INTO token_usages (account_unique_key: "team_prod", cost: $0.042)
    DB->>SQLite: 4. UPDATE sessions SET total_tokens_spent = total_tokens_spent + 1580
    
    DB->>SQLite: COMMIT TRANSACTION
    SQLite-->>DB: 事务提交成功 (fsync to WAL)
    DB-->>Loop: 返回 messageId
    deactivate DB

    Loop->>UI: 广播 UI 更新通知 (携带持久化后的精确 Token 用量与数据库 ID)
```

### 6.2 核心源码级调用栈 (Source Call Stack)

```
[AgentEventLoop.finalizeTurn] (src/core/event-loop.ts:140)
  │
  ├── [TokenUsageCalculator.evaluateCost] (src/billing/calculator.ts:35)
  │     └── [ModelPricingTable.lookup(modelId)]
  │
  ├── [OpenCodeDatabaseManager.saveTurnMessageTransaction] (src/storage/db-manager.ts:60)
  │     ├── [Database.transaction]
  │     │     ├── [InsertMessagesStatement.run]
  │     │     ├── [InsertMessagePartsBatch.run]
  │     │     ├── [InsertTokenUsageStatement.run]
  │     │     └── [UpdateSessionTotalTokens.run]
  │     └── (Commit WAL Frame)
  │
  └── [EventEmitter.emit('turn_persisted', { sessionId, messageId })]
```

---

## 7. 极端异常边界与存储一致性防御

| 异常边界场景 | 物理成因与危害 | Harness 核心防线与自愈算法 (Self-Healing) |
| :--- | :--- | :--- |
| **1. 数据库锁争用与超时 (SQLITE_BUSY)** | 多个子代理并发写入同一个 `opencode.db` 单文件，触发写锁互斥。 | **WAL 模式 + 内存繁忙重试队列（Busy Handler）**：<br>1. 必须开启 `PRAGMA journal_mode = WAL;`；<br>2. 设置 `db.pragma('busy_timeout = 5000')`；<br>3. 在 DAO 层封装指数退避重试（Backoff Retry），最大重试 5 次。 |
| **2. 异常断电导致 WAL 未 Checkpoint (WAL Bloat)** | 系统长时间运行未执行 Checkpoint，`opencode.db-wal` 文件膨胀至数 GB。 | **启动时主动触发被动检查点（Passive Checkpoint）**：<br>数据库实例初始化时，主动执行 `PRAGMA wal_checkpoint(TRUNCATE);`，将 WAL 帧安全回刷至主文件并截断日志。 |
| **3. 数据库文件彻底损坏 (Database Malformed)** | 磁盘底层坏道导致 SQLite 抛出 `SQLITE_CORRUPT`。 | **双轨自愈：从 JSONL 物理日志零损重建（Emergency Rebuild）**：<br>捕获 `SQLITE_CORRUPT` 异常后，自动将坏库重命名备份为 `opencode.db.bak`，新建空库并扫描工作区 `events.jsonl`，完全全量重放生成全新的关系数据。 |
| **4. 跨平台换行符与大文本溢出 (Large Text Overflow)** | 工具输出了 100MB 文本，直接存入单个 SQLite 字段导致内存暴涨。 | **大字段分片与超限截断标志（`is_truncated`）**：<br>在存入 `message_parts` 前对单个文本块强制施加 64KB 上限；超限部分截断并置 `is_truncated = 1`，将全量大日志落入本地临时磁盘文件，数据库仅保留文件指针。 |

---

## 8. 对 ai_home 自主 Harness 研发的落地指导与架构设计

在 `ai_home` 项目落地高性能多模型 Agent 运行时持久化架构时，必须贯彻以下三大设计规范：

### 8.1 架构设计一：落地 `message_parts` 原子分片建模
- **当前现状**：`ai_home` 部分历史模块仍将整个轮次的消息简单序列化为一个大 JSON 字符串存入单个 `content` 字段，导致无法单独查询工具调用或提取思考过程。
- **重构方案**：
  1. 重构表结构，将消息彻底解耦为 `messages` 主表 + `message_parts` 部件子表；
  2. 独立存储 `thinking`、`text`、`tool_use`、`tool_result`，支持 WebUI 按需加载与流式局部渲染。

### 8.2 架构设计二：建立基于 `account_unique_key` 的多维用量审计中枢
- **落地方案**：
  1. 在 `token_usages` 表中严格绑定 `account_unique_key`（OAuth 邮箱或 API Key 签名）；
  2. 在 WebUI 管理后台提供 **“团队用量与成本大盘”**，直观展示每个工作区、每个模型、每个账号的 Token 消耗、Cache 命中率与折合金额。

### 8.3 架构设计三：引入 SQLite WAL 事务并发池与启动自愈检查
- **落地方案**：
  1. 统一封装 `lib/storage/sqlite-pool.ts`，强制开启 `WAL` 模式与 `foreign_keys = ON`；
  2. 启动时执行 `PRAGMA integrity_check` 与 `PRAGMA wal_checkpoint`，保障高频读写下的绝对数据安全。

---

## 9. 本章小结与下章预告

本章全面解构了 OpenCode 工业级的 **SQLite 关系模型设计（`opencode.db`）、`message_parts` 消息分块解耦、细粒度 Token 财务归属模型以及事务持久化 DAO 实现**，为 `ai_home` 的数据持久化中枢提供了成熟的设计典范。

在下一章 **【03-03 Zen / Go 双端点路由设计与多 Provider 抽象层】** 中，我们将深入剖析 OpenCode 的双端点路由架构，拆解其如何通过 Zen 策略与 Go 高性能中间层，实现跨全球多 Provider 的智能路由与协议归一。
