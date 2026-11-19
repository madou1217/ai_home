-- SchemaV33: usage_ledger 记录本次请求实际消费的额度档位。
-- 档位由账号/Provider 调度策略给出（如 credits / 5h / 7days），空表示不区分档位。
ALTER TABLE usage_ledger ADD COLUMN quota_bucket TEXT NOT NULL DEFAULT '';

PRAGMA user_version = 33;
