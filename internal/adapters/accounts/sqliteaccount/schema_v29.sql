-- v29：OAuth Job 的终态结果落库。
--
-- 原先只持久化 status/error_code：account_ref 与 cli_account_id 只活在内存的
-- 5 分钟保留期里，进程重启后回放 completed 会丢掉账号结果；finished_at 也只能
-- 用 updated_at 近似。终态是客户端查询的唯一结果，必须跨重启完整保留。
--
-- 只用 ADD COLUMN（与 v26 相同）：迁移夹具会在回退 user_version 前先 DROP COLUMN，
-- 因此这组语句可以在旧库上原样重放。
ALTER TABLE oauth_jobs ADD COLUMN account_ref TEXT NOT NULL DEFAULT ''
  CHECK (length(account_ref) <= 128);

ALTER TABLE oauth_jobs ADD COLUMN cli_account_id INTEGER NOT NULL DEFAULT 0
  CHECK (cli_account_id >= 0);

ALTER TABLE oauth_jobs ADD COLUMN finished_at_ms INTEGER NOT NULL DEFAULT 0
  CHECK (finished_at_ms BETWEEN 0 AND 253402300799999);

PRAGMA user_version = 29;
