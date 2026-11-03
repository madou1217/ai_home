-- 成功推理的持久化 token 事实；不保存请求正文、凭据或定价结果。
-- Go 直接拥有该账本，Node 的增量 feed 只用于兼容期实时消费。
CREATE TABLE usage_ledger (
  usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_ref TEXT NOT NULL,
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 64
      AND provider_id NOT GLOB '*[^a-z0-9_-]*'),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  session_id TEXT NOT NULL DEFAULT '' CHECK (length(session_id) <= 256),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 253402300799999),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
  cache_write_input_tokens INTEGER NOT NULL CHECK (cache_write_input_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 1),
  CHECK (cached_input_tokens + cache_write_input_tokens <= input_tokens),
  CHECK (reasoning_tokens <= output_tokens),
  CHECK (total_tokens = input_tokens + output_tokens),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_usage_ledger_time ON usage_ledger (occurred_at_ms);
CREATE INDEX idx_usage_ledger_provider_model_time
  ON usage_ledger (provider_id, model_id, occurred_at_ms);
CREATE INDEX idx_usage_ledger_account_time
  ON usage_ledger (account_ref, occurred_at_ms);

PRAGMA user_version = 9;
