-- SchemaV35: usage_ledger 的 UTC 日粒度汇总表 + 写入触发器。
--
-- 档位聚合要扫整段时间的行（90 天约 10.6 万行，纯 Go 驱动 ~70ms）。
-- 这里把 (日, 账号, Provider, 模型, 档位) 提前汇总：整日走汇总表，
-- 不足一日的首尾两段仍查明细账本，因此任意毫秒级时间窗的结果与直接
-- 聚合 usage_ledger 完全一致。
--
-- 汇总由触发器维护而不是由写入方代码维护：AppendUsageRecord 与
-- ImportUsageEvents（INSERT OR IGNORE）走同一张表，触发器保证两条路径
-- 都不会漏记；INSERT OR IGNORE 被忽略的行不会触发，重复导入不会重复计数。
CREATE TABLE IF NOT EXISTS usage_ledger_daily (
  day_ms INTEGER NOT NULL,
  account_ref TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  quota_bucket TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_ms, account_ref, provider_id, model_id, quota_bucket)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS usage_ledger_daily_after_insert
AFTER INSERT ON usage_ledger
BEGIN
  INSERT INTO usage_ledger_daily (
    day_ms, account_ref, provider_id, model_id, quota_bucket,
    calls, input_tokens, output_tokens, cached_input_tokens,
    cache_write_input_tokens, reasoning_tokens, total_tokens
  ) VALUES (
    new.occurred_at_ms / 86400000 * 86400000,
    new.account_ref, new.provider_id, new.model_id, new.quota_bucket,
    1, new.input_tokens, new.output_tokens, new.cached_input_tokens,
    new.cache_write_input_tokens, new.reasoning_tokens, new.total_tokens
  )
  ON CONFLICT(day_ms, account_ref, provider_id, model_id, quota_bucket) DO UPDATE SET
    calls = calls + 1,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
    cache_write_input_tokens = cache_write_input_tokens + excluded.cache_write_input_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    total_tokens = total_tokens + excluded.total_tokens;
END;

-- 回填用 INSERT OR IGNORE：进程若在写 PRAGMA user_version 之前退出，下一次启动
-- 会重放整段脚本，这里必须和建表/建触发器一样可重放。
INSERT OR IGNORE INTO usage_ledger_daily (
  day_ms, account_ref, provider_id, model_id, quota_bucket,
  calls, input_tokens, output_tokens, cached_input_tokens,
  cache_write_input_tokens, reasoning_tokens, total_tokens
)
SELECT occurred_at_ms / 86400000 * 86400000,
       account_ref, provider_id, model_id, quota_bucket,
       COUNT(*),
       COALESCE(SUM(input_tokens), 0),
       COALESCE(SUM(output_tokens), 0),
       COALESCE(SUM(cached_input_tokens), 0),
       COALESCE(SUM(cache_write_input_tokens), 0),
       COALESCE(SUM(reasoning_tokens), 0),
       COALESCE(SUM(total_tokens), 0)
FROM usage_ledger
GROUP BY 1, 2, 3, 4, 5;

PRAGMA user_version = 35;
