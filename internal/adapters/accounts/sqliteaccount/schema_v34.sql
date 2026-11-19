-- SchemaV34: 给 usage_ledger 加覆盖索引，让按额度档位聚合不必回表读宽行。
--
-- 账本行含 session_id / source_key 等宽列（约 2.3 行/页），按时间索引扫描后
-- 仍要逐行回表取 6 个 token 列；实测 90 天窗口 ~120ms。覆盖索引把聚合需要的
-- 列全部放进索引（约 4MB），同样的查询退化为顺序索引扫描。
CREATE INDEX IF NOT EXISTS idx_usage_ledger_quota_bucket_cover ON usage_ledger(
  occurred_at_ms,
  provider_id,
  quota_bucket,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  cache_write_input_tokens,
  reasoning_tokens,
  total_tokens
);

PRAGMA user_version = 34;
