-- 账号请求结果按时间桶聚合，供账号页状态条（90 天按天 + 最近 24 小时按小时）使用。
-- 只保存计数（成功 / 各类失败），不保存请求内容、模型或客户端信息；
-- outcome 是 success 或 accountruntime 的 FailureKind。按保留期定期清理。
CREATE TABLE account_outcomes (
  account_ref TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('day', 'hour')),
  bucket_start_ms INTEGER NOT NULL CHECK (bucket_start_ms >= 0),
  outcome TEXT NOT NULL
    CHECK (length(outcome) BETWEEN 1 AND 64 AND outcome NOT GLOB '*[^a-z_]*'),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (account_ref, granularity, bucket_start_ms, outcome),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_account_outcomes_bucket
  ON account_outcomes (granularity, bucket_start_ms);

PRAGMA user_version = 7;
