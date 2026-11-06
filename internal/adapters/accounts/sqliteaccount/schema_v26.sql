-- v26：usage_ledger 的幂等导入键。
--
-- Node 侧有 100 万条历史 token 事实（model_usage_records），切流前要把它们并进 Go 账本。
-- 没有幂等键的话，导入脚本重跑一次就会把历史翻倍；source_key 用 Node 的 event_key，
-- 唯一索引保证「同一事件只落一行」，导入过程可以安全重试。
ALTER TABLE usage_ledger ADD COLUMN source_key TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_ledger_source_key
  ON usage_ledger (source_key)
  WHERE source_key <> '';

PRAGMA user_version = 26;
