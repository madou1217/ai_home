-- (账号, 模型) 冷却与连续失败计数：进程重启后不能立刻重试刚被限流的模型。
-- 只保存失败分类与时间，不保存请求内容、Provider 响应或凭据；
-- streak/cooldown 的分类为空时，对应的计数与时间必须同时为零。
CREATE TABLE account_runtime_state (
  account_ref TEXT NOT NULL,
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  streak_kind TEXT NOT NULL DEFAULT ''
    CHECK (streak_kind = '' OR streak_kind NOT GLOB '*[^a-z_]*'),
  streak_count INTEGER NOT NULL DEFAULT 0 CHECK (streak_count BETWEEN 0 AND 255),
  streak_expires_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (streak_expires_at_ms BETWEEN 0 AND 253402300799999),
  cooldown_kind TEXT NOT NULL DEFAULT ''
    CHECK (cooldown_kind = '' OR cooldown_kind NOT GLOB '*[^a-z_]*'),
  cooldown_until_ms INTEGER NOT NULL DEFAULT 0
    CHECK (cooldown_until_ms BETWEEN 0 AND 253402300799999),
  last_failure_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (last_failure_at_ms BETWEEN 0 AND 253402300799999),
  CHECK (streak_kind <> '' OR (streak_count = 0 AND streak_expires_at_ms = 0)),
  CHECK (streak_kind = '' OR (streak_count >= 1 AND streak_expires_at_ms >= 1)),
  CHECK (cooldown_kind <> '' OR cooldown_until_ms = 0),
  CHECK (cooldown_kind = '' OR cooldown_until_ms >= 1),
  PRIMARY KEY (account_ref, model_id),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_account_runtime_state_cooldown
  ON account_runtime_state (cooldown_until_ms);

PRAGMA user_version = 8;
