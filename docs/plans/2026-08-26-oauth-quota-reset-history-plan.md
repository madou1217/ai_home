# OAuth 账号配额重置历史记录与可视化方案 (v3 双审闭环终版)

## 1. 业务目标
为所有支持配额/用量探测的 OAuth Providers（Codex, Claude, Kimi, ZCode, Gemini, AGY 等）提供统一、精准、抗并发抖动的**配额重置事件检测、不可变流水持久化与 WebUI 历史时间轴查看**功能。

---

## 2. 核心架构与架构评审关键结论 (AIH Codex & Claude 联合评审)

### 2.1 状态机与多特征检测算法 (Multi-Signal State Machine)
不能单纯依赖 `currentRemainingPct === 100%`（因为探测间隔期可能已重置并再次被消耗，例如 `10% ➔ 重置 ➔ 85%`）。
检测算法基于**周期标识推进 (Cycle Rollover)** + **回血迟滞状态机 (Armed Replenishment)** 双轨驱动：

1. **信号 A：自然周期顺延 (`cycle_rollover / natural`)**：
   - 当快照中的 `resetAtMs`（或周期标识）发生跃迁，跨越了上一轮的 `previousExpectedResetAtMs`（新周期顺延）。
   - 此时无论当前用量是 100% 还是重置后又被消耗到 85%，均确认发生了一次自然周期重置。
2. **信号 B：提前/异常回血 (`replenishment / early_inferred`)**：
   - 上一轮快照处于消耗态（`previousRemainingPct <= 95%` 进入 Armed 状态）；
   - 当前时间距离原定重置目标仍有较大差距（$now < \text{previousExpectedResetAtMs} - 3\text{分钟}$）；
   - 剩余比例出现大幅回升（$\ge 99.5\%$ 或跃升幅度 $\ge 30\%$）；
   - 判定为提前回血重置，并计算推断提前量 $\text{earlyDurationMs} = \text{previousExpectedResetAtMs} - now$。

### 2.2 多 Provider 动态维度统一抽取 (Unified Quota Key)
不使用硬编码字段，通过统一 Adapter 将不同 Provider 快照映射为标准化 `Observation`：
- **Codex**: `quota_key = rate_limit:${entry.bucket}` (如 `rate_limit:primary`, `rate_limit:secondary`)，`windowLabel` 为动态 `5h`, `7days`, `30days`
- **Claude**: `quota_key = rate_limit:${entry.bucket}` (如 `rate_limit:five_hour`, `rate_limit:seven_day`)
- **Kimi / ZCode**: `quota_key = rate_limit:${entry.bucket || 'balance'}`
- **Gemini / AGY**: `quota_key = model:${model.model}`

### 2.3 数据库表结构与并发幂等设计 (`app-state.db`)
拆分**状态跟踪表**与**不可变事件流水表**，并在 SQLite `BEGIN IMMEDIATE` 短事务中保证并发探测幂等：

```sql
-- 1. 检测器状态表（记录每个 quota_key 的最新基线与 armed 状态）
CREATE TABLE IF NOT EXISTS account_quota_detector_state (
  account_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  quota_key TEXT NOT NULL,
  last_remaining_pct REAL,
  last_expected_reset_at_ms INTEGER,
  last_captured_at_ms INTEGER NOT NULL,
  is_armed INTEGER DEFAULT 0,
  rearm_generation INTEGER DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_ref, quota_key)
);

-- 2. 重置事件流水表（不可变事件记录）
CREATE TABLE IF NOT EXISTS account_quota_reset_events (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,       -- 幂等主键（防重复探测风暴）
  account_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  quota_key TEXT NOT NULL,
  window_label TEXT,
  window_minutes INTEGER,
  event_kind TEXT NOT NULL,             -- 'cycle_rollover' | 'replenishment'
  classification TEXT NOT NULL,         -- 'natural' | 'early_inferred' | 'unknown'
  cause TEXT DEFAULT 'unknown',         -- 'scheduled' | 'reset_credit' | 'plan_change' | 'unknown'
  previous_remaining_pct REAL,
  current_remaining_pct REAL,
  previous_expected_reset_at_ms INTEGER,
  detected_at_ms INTEGER NOT NULL,
  early_duration_ms INTEGER DEFAULT 0,
  FOREIGN KEY (account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quota_reset_account_time
  ON account_quota_reset_events (account_ref, detected_at_ms DESC, id DESC);
```

### 2.4 幂等键 (`event_key`) 生成规则
- 自然周期切换：`hash("${accountRef}:${provider}:${quotaKey}:cycle:${previousExpectedResetAtMs}:${currentExpectedResetAtMs}")`
- 提前回血：`hash("${accountRef}:${provider}:${quotaKey}:rearm:${rearmGeneration}:${Math.floor(detectedAtMs / 60000)}")`
- 插入时使用 `INSERT ... ON CONFLICT(event_key) DO NOTHING`，从数据库层绝对杜绝并发多写导致的重复记录。

### 2.5 API 契约设计
- **`GET /v0/webui/accounts/:provider/:accountRef/quota-reset-events`**
  - 参数：`limit` (默认 50, 最大 100), `beforeId` (游标分页)
  - 响应：
    ```json
    {
      "ok": true,
      "provider": "codex",
      "accountRef": "acct_3306a0fb0bfb1c1127fb",
      "events": [
        {
          "id": 12,
          "quotaKey": "rate_limit:secondary",
          "windowLabel": "7days",
          "windowMinutes": 10080,
          "eventKind": "replenishment",
          "classification": "early_inferred",
          "previousRemainingPct": 10.0,
          "currentRemainingPct": 100.0,
          "previousExpectedResetAtMs": 1787890000000,
          "detectedAtMs": 1787544000000,
          "earlyDurationMs": 346000000
        }
      ]
    }
    ```

### 2.6 WebUI 前端设计与呈现
1. **入口**：在所有 OAuth 账号卡片的操作按钮区，统一提供 **「重置历史」** 按钮（图标：`HistoryOutlined` / 时钟）。
2. **弹窗组件 (`AccountQuotaResetHistoryModal.tsx`)**：
   - 采用 Ant Design `Timeline` 时间轴流式展示；
   - 顶部统计卡片：累计重置次数、最近自然周期重置时间、最近提前回血重置时间；
   - 列表项清晰标注：
     - 所属动态窗口标签（如 `5h 窗口`、`7天 周期`、`gemini-2.5-flash`）；
     - 用量变化：`10% ➔ 100%`（带色彩高亮）；
     - 判定标签：`【自然周期重置】`（绿色）/ `【提前回血】`（蓝色）；
     - 详细信息：检测于 `16:02`，原定重置 `3天后`（推断提前了 `2天22小时`）。

---

## 3. 实施与验证步骤
1. **数据层**：新建 `lib/account/quota-reset-store.js`（建表、事务写入与检测器状态推进、分页查询）。
2. **检测层**：新建 `lib/account/quota-reset-detector.js`（快照解构为 Observation、多信号状态机判定、幂等插入）。
3. **集成点**：在 `writeAccountUsageSnapshot`（快照持久化主入口）中串联检测流程。
4. **路由层**：在 `lib/server/webui-account-routes.js` 注册 `GET /quota-reset-events`。
5. **前端层**：在 `web/src/features/accounts/` 实现 `AccountQuotaResetHistoryModal.tsx`，并在账号列表/卡片中接入。
6. **测试用例**：
   - 单元测试：周期跨越检测、提前回血检测、并发探测幂等去重（`INSERT ... ON CONFLICT`）、乱序观测丢弃、非 100% 漏记场景（10% -> 重置 -> 80%）。
   - 集成测试：API 请求与全量 `npm test` 回归。
