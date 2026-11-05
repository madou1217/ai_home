-- 账号当前额度快照补套餐标识。
--
-- plan_type 是 Provider 归一后的短 token（如 pro / max / allegretto），未知为空。
-- 它属于账号级事实：同一快照的每一行都写同一个值，读取时逐行比对，
-- 与 source / captured_at_ms 的「整份快照一致」约束相同。
--
-- 旧库升级后已有行取默认空串（未知），不会把历史快照伪造成某个套餐。
ALTER TABLE account_usage
  ADD COLUMN plan_type TEXT NOT NULL DEFAULT ''
    CHECK (length(plan_type) <= 64);

PRAGMA user_version = 20;
