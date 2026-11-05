-- v24：账号额度探针的最近结果。
--
-- 探针由 Node 执行（凭据读取与 Provider 差异都在 Node），但「最近一次探测结果」是
-- 账号页要展示的事实，必须跨重启保留并参与 Go 的账号视图。没有这张表时，
-- Node 重启后探针状态全部丢失，页面会退回「未知」。
CREATE TABLE IF NOT EXISTS account_probe_state (
  account_ref TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  checked_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
);

PRAGMA user_version = 24;

