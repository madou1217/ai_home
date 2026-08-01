-- 默认账号只保存启动选择，不复制账号状态、凭据、运行态或调度数据。
CREATE TABLE account_defaults (
  provider_id TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(provider_id) BETWEEN 1 AND 64
      AND provider_id NOT GLOB '*[^a-z0-9_-]*'
      AND substr(provider_id, 1, 1) NOT GLOB '[-_]'
      AND substr(provider_id, -1, 1) NOT GLOB '[-_]'
    ),
  account_ref TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- 停用当前默认账号时删除启动选择；重新启用不会隐式恢复旧选择。
CREATE TRIGGER trg_account_defaults_clear_disabled
AFTER UPDATE OF enabled ON accounts
FOR EACH ROW
WHEN OLD.enabled = 1 AND NEW.enabled = 0
BEGIN
  DELETE FROM account_defaults WHERE account_ref = NEW.account_ref;
END;

PRAGMA user_version = 5;
