-- v30：OAuth Job 归属（owner/source），避免 Go 重启把 Node 仍在跑的 Job 标成 expired。
ALTER TABLE oauth_jobs ADD COLUMN owner TEXT NOT NULL DEFAULT 'go'
  CHECK (owner IN ('go', 'node'));

ALTER TABLE oauth_jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'go'
  CHECK (source IN ('go', 'node'));

PRAGMA user_version = 30;
