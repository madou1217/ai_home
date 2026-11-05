-- 账号级额度状态的物化列：Go 是唯一计算方，Node 服务端与 CLI 都直接读这份结果，
-- 不再各自从快照推导（codex Team/Free 的 pending 语义只在这里实现一次）。
ALTER TABLE account_usage_snapshots
  ADD COLUMN quota_status TEXT NOT NULL DEFAULT ''
    CHECK (
      quota_status IN ('', 'available', 'exhausted', 'pending', 'not_applicable')
    );

ALTER TABLE account_usage_snapshots
  ADD COLUMN quota_reason TEXT NOT NULL DEFAULT ''
    CHECK (length(quota_reason) <= 128);

ALTER TABLE account_usage_snapshots
  ADD COLUMN remaining_bps INTEGER
    CHECK (remaining_bps IS NULL OR remaining_bps BETWEEN 0 AND 10000);

ALTER TABLE account_usage_snapshots
  ADD COLUMN has_numeric_remaining INTEGER NOT NULL DEFAULT 0
    CHECK (has_numeric_remaining IN (0, 1));

PRAGMA user_version = 12;
