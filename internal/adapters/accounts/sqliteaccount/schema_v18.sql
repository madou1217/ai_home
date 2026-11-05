-- 额度窗口采样：每个 (账号, quotaKey, 窗口长度, 5 分钟桶) 只保留第一条。
--
-- 这张表是「窗口期额度统计」的历史真相：额度窗口不按日历滚动，锚点是上一个窗口
-- 关闭后的首个真实请求（见 core/accountusage/quota_window.go 的 F1–F4），
-- 所以窗口只能从连续采样 + reset 值反推，不能靠日聚合。
--
-- remaining_pct 允许 NULL：Provider 只给了 reset、没给剩余比例时，仍要留下
-- 「这个窗口存在过」的证据，但不能伪造消耗。
CREATE TABLE account_quota_window_samples (
  sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_ref TEXT NOT NULL,
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 128
      AND provider_id NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  quota_key TEXT NOT NULL CHECK (length(quota_key) BETWEEN 1 AND 192),
  window_label TEXT NOT NULL DEFAULT '' CHECK (length(window_label) <= 256),
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  remaining_pct REAL
    CHECK (remaining_pct IS NULL OR (remaining_pct >= 0 AND remaining_pct <= 100)),
  expected_reset_at_ms INTEGER NOT NULL
    CHECK (expected_reset_at_ms BETWEEN 0 AND 253402300799999),
  captured_at_ms INTEGER NOT NULL
    CHECK (captured_at_ms BETWEEN 0 AND 253402300799999),
  captured_bucket INTEGER NOT NULL CHECK (captured_bucket >= 0),
  plan_type TEXT NOT NULL DEFAULT '' CHECK (length(plan_type) <= 64),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  UNIQUE (account_ref, quota_key, window_minutes, captured_bucket),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

-- 统计查询按 (账号, quotaKey) 取一段时间的样本，顺序必须由索引直接满足。
CREATE INDEX idx_quota_window_samples_account_key_time
  ON account_quota_window_samples (account_ref, quota_key, captured_at_ms);

-- 保留期清理按采集时间扫全表。
CREATE INDEX idx_quota_window_samples_time
  ON account_quota_window_samples (captured_at_ms);

PRAGMA user_version = 18;
