-- 账号级失败阻塞：auth_invalid / rate_limited / permission_denied 等。
-- 一个账号同一失败类型只保留最后一次观察，冷却到期后由消费方忽略。
CREATE TABLE account_runtime_blocks (
  account_ref TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (length(kind) BETWEEN 1 AND 64),
  scope TEXT NOT NULL
    CHECK (scope IN ('account', 'account_model')),
  reason TEXT NOT NULL DEFAULT ''
    CHECK (length(reason) <= 500),
  observed_at_ms INTEGER NOT NULL
    CHECK (observed_at_ms BETWEEN 0 AND 253402300799999),
  until_ms INTEGER NOT NULL
    CHECK (until_ms BETWEEN 0 AND 253402300799999),
  PRIMARY KEY (account_ref, kind),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_account_runtime_blocks_until
  ON account_runtime_blocks(until_ms);

PRAGMA user_version = 14;
