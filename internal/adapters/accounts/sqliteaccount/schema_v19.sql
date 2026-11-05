-- 窗口账本：每个账号一行，记录「最近一次观察到的活跃窗口」。
--
-- 账本与采样是两类事实：采样记录每一次观测，账本只记录「当前窗口」的
-- 锚点 / 关窗时刻 / 来源 / 观察时刻，并且单调不回退（旧快照不能覆盖新观察）。
-- 统计页的 current 在样本之后、当前快照之前读它：样本缺失时仍能给出
-- 「窗口何时关闭」，而不是把空闲期的幻影 reset 当成当前窗口。
--
-- source 与 Node lib/server/window-activation/window-ledger.js 同枚举：
-- snapshot / probe / activity。Go 目前只写 snapshot；probe 与 activity
-- 预留给探测调度与关窗后活动检测。
CREATE TABLE account_quota_window_ledger (
  account_ref TEXT PRIMARY KEY,
  window_minutes INTEGER NOT NULL DEFAULT 0 CHECK (window_minutes >= 0),
  anchor_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (anchor_at_ms BETWEEN 0 AND 253402300799999),
  close_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (close_at_ms BETWEEN 0 AND 253402300799999),
  source TEXT NOT NULL DEFAULT ''
    CHECK (source IN ('', 'snapshot', 'probe', 'activity')),
  observed_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (observed_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

-- 重置检测状态机：每个 (账号, quotaKey) 一行，记住上一次观测。
--
-- 检测器只做增量判断，所以基线必须持久化：进程重启后第一帧不能把
-- 「回满」误判成重置，也不能把「100% → 42%」的消耗当成重置。
CREATE TABLE account_quota_detector_state (
  account_ref TEXT NOT NULL,
  quota_key TEXT NOT NULL CHECK (length(quota_key) BETWEEN 1 AND 192),
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 128
      AND provider_id NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  last_remaining_pct REAL
    CHECK (last_remaining_pct IS NULL OR (last_remaining_pct >= 0 AND last_remaining_pct <= 100)),
  last_expected_reset_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (last_expected_reset_at_ms BETWEEN 0 AND 253402300799999),
  last_captured_at_ms INTEGER NOT NULL
    CHECK (last_captured_at_ms BETWEEN 0 AND 253402300799999),
  is_armed INTEGER NOT NULL DEFAULT 0 CHECK (is_armed IN (0, 1)),
  rearm_generation INTEGER NOT NULL DEFAULT 0 CHECK (rearm_generation >= 0),
  exhausted_at_ms INTEGER
    CHECK (exhausted_at_ms IS NULL OR exhausted_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  PRIMARY KEY (account_ref, quota_key),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

-- 额度重置事件：cycle_rollover（自然滚动）与 replenishment（提前回血）。
--
-- 事件是窗口重建的第二种证据：提前回血会把旧窗口截断在回血时刻，
-- 而「只有事件、没有样本」的窗口也要能在统计页出现（source=reset）。
CREATE TABLE account_quota_reset_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) = 32),
  account_ref TEXT NOT NULL,
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 128
      AND provider_id NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  quota_key TEXT NOT NULL CHECK (length(quota_key) BETWEEN 1 AND 192),
  window_label TEXT NOT NULL DEFAULT '' CHECK (length(window_label) <= 256),
  window_minutes INTEGER NOT NULL DEFAULT 0 CHECK (window_minutes >= 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('cycle_rollover', 'replenishment')),
  classification TEXT NOT NULL DEFAULT '' CHECK (length(classification) <= 32),
  cause TEXT NOT NULL DEFAULT '' CHECK (length(cause) <= 64),
  previous_remaining_pct REAL
    CHECK (previous_remaining_pct IS NULL OR (previous_remaining_pct >= 0 AND previous_remaining_pct <= 100)),
  current_remaining_pct REAL
    CHECK (current_remaining_pct IS NULL OR (current_remaining_pct >= 0 AND current_remaining_pct <= 100)),
  previous_expected_reset_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (previous_expected_reset_at_ms BETWEEN 0 AND 253402300799999),
  exhausted_at_ms INTEGER
    CHECK (exhausted_at_ms IS NULL OR exhausted_at_ms BETWEEN 0 AND 253402300799999),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms BETWEEN 0 AND 253402300799999),
  detected_at_ms INTEGER NOT NULL
    CHECK (detected_at_ms BETWEEN 0 AND 253402300799999),
  early_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (early_duration_ms >= 0),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

-- 统计查询按 (账号, quotaKey) 取一段时间的重置事件。
CREATE INDEX idx_quota_reset_events_account_key_time
  ON account_quota_reset_events (account_ref, quota_key, occurred_at_ms);

-- 维度可用性扫描按账号取全部事件。
CREATE INDEX idx_quota_reset_events_account_time
  ON account_quota_reset_events (account_ref, occurred_at_ms);

PRAGMA user_version = 19;
