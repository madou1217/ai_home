-- usage_ledger 的 UTC 日粒度派生汇总表与 INSERT/DELETE/UPDATE 完整性触发器。
--
-- 仅在汇总表或任一触发器能力缺失/定义不一致时由 schema_ensure_ledger_daily.go 安装并做一次性对齐回填，
-- 日常 CLI / 服务冷启动探测到能力已就绪后跳过本脚本与回填。
--
-- 维护约定：
-- 1. 保留既有 usage_ledger_daily_after_insert（INSERT OR IGNORE 冲突忽略时不触发）。
-- 2. DELETE 递减旧桶 (day_ms, account_ref, provider_id, model_id, quota_bucket)，
--    仅在 calls <= 0 时移除空桶，保留 calls > 0 的零 token 合法桶；未知桶不插入负行。
-- 3. UPDATE 仅在桶键或任一 token 列变化时触发（跳过仅改 source_key / session_id 的热路径）；
--    先递减并按 calls <= 0 清理旧桶，再精确累加新桶，同桶更新与跨桶搬移同口径。
-- 4. day_ms 沿用既有整数除法约定 (occurred_at_ms / 86400000) * 86400000，不额外加非负约束。
-- 5. 若调用方对 usage_ledger 使用 INSERT/UPDATE OR REPLACE 覆盖既有行，SQLite 要求该连接
--    开启 PRAGMA recursive_triggers = ON 才会对被替换旧行触发 AFTER DELETE；UPSERT
--    (ON CONFLICT DO UPDATE) 与外键 ON DELETE CASCADE 不依赖该 PRAGMA。

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

DROP TRIGGER IF EXISTS usage_ledger_daily_after_delete;
CREATE TRIGGER IF NOT EXISTS usage_ledger_daily_after_delete
AFTER DELETE ON usage_ledger
BEGIN
  UPDATE usage_ledger_daily
  SET calls = calls - 1,
      input_tokens = input_tokens - COALESCE(old.input_tokens, 0),
      output_tokens = output_tokens - COALESCE(old.output_tokens, 0),
      cached_input_tokens = cached_input_tokens - COALESCE(old.cached_input_tokens, 0),
      cache_write_input_tokens = cache_write_input_tokens - COALESCE(old.cache_write_input_tokens, 0),
      reasoning_tokens = reasoning_tokens - COALESCE(old.reasoning_tokens, 0),
      total_tokens = total_tokens - COALESCE(old.total_tokens, 0)
  WHERE day_ms = ((old.occurred_at_ms / 86400000) * 86400000)
    AND account_ref = old.account_ref
    AND provider_id = old.provider_id
    AND model_id = old.model_id
    AND quota_bucket = old.quota_bucket;

  DELETE FROM usage_ledger_daily
  WHERE day_ms = ((old.occurred_at_ms / 86400000) * 86400000)
    AND account_ref = old.account_ref
    AND provider_id = old.provider_id
    AND model_id = old.model_id
    AND quota_bucket = old.quota_bucket
    AND calls <= 0;
END;

DROP TRIGGER IF EXISTS usage_ledger_daily_after_update;
CREATE TRIGGER IF NOT EXISTS usage_ledger_daily_after_update
AFTER UPDATE OF
  occurred_at_ms,
  account_ref,
  provider_id,
  model_id,
  quota_bucket,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  cache_write_input_tokens,
  reasoning_tokens,
  total_tokens
ON usage_ledger
WHEN ((old.occurred_at_ms / 86400000) * 86400000) IS NOT ((new.occurred_at_ms / 86400000) * 86400000)
  OR old.account_ref IS NOT new.account_ref
  OR old.provider_id IS NOT new.provider_id
  OR old.model_id IS NOT new.model_id
  OR old.quota_bucket IS NOT new.quota_bucket
  OR old.input_tokens IS NOT new.input_tokens
  OR old.output_tokens IS NOT new.output_tokens
  OR old.cached_input_tokens IS NOT new.cached_input_tokens
  OR old.cache_write_input_tokens IS NOT new.cache_write_input_tokens
  OR old.reasoning_tokens IS NOT new.reasoning_tokens
  OR old.total_tokens IS NOT new.total_tokens
BEGIN
  UPDATE usage_ledger_daily
  SET calls = calls - 1,
      input_tokens = input_tokens - COALESCE(old.input_tokens, 0),
      output_tokens = output_tokens - COALESCE(old.output_tokens, 0),
      cached_input_tokens = cached_input_tokens - COALESCE(old.cached_input_tokens, 0),
      cache_write_input_tokens = cache_write_input_tokens - COALESCE(old.cache_write_input_tokens, 0),
      reasoning_tokens = reasoning_tokens - COALESCE(old.reasoning_tokens, 0),
      total_tokens = total_tokens - COALESCE(old.total_tokens, 0)
  WHERE day_ms = ((old.occurred_at_ms / 86400000) * 86400000)
    AND account_ref = old.account_ref
    AND provider_id = old.provider_id
    AND model_id = old.model_id
    AND quota_bucket = old.quota_bucket;

  DELETE FROM usage_ledger_daily
  WHERE day_ms = ((old.occurred_at_ms / 86400000) * 86400000)
    AND account_ref = old.account_ref
    AND provider_id = old.provider_id
    AND model_id = old.model_id
    AND quota_bucket = old.quota_bucket
    AND calls <= 0;

  INSERT INTO usage_ledger_daily (
    day_ms, account_ref, provider_id, model_id, quota_bucket,
    calls, input_tokens, output_tokens, cached_input_tokens,
    cache_write_input_tokens, reasoning_tokens, total_tokens
  ) VALUES (
    (new.occurred_at_ms / 86400000) * 86400000,
    new.account_ref, new.provider_id, new.model_id, new.quota_bucket,
    1,
    COALESCE(new.input_tokens, 0),
    COALESCE(new.output_tokens, 0),
    COALESCE(new.cached_input_tokens, 0),
    COALESCE(new.cache_write_input_tokens, 0),
    COALESCE(new.reasoning_tokens, 0),
    COALESCE(new.total_tokens, 0)
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
