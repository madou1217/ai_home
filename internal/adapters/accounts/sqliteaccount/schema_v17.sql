-- OAuth Job 公开快照：重启后 Node/CLI 仍要能查询 Job 状态，因此快照必须落盘。
--
-- 只保存可对外展示的字段，绝不含授权 URL、state、PKCE verifier、授权码或 Token：
-- 这些私有值只活在进程内的 OAuth Flow 里，进程一重启就自然消失，也就不该有持久副本。
CREATE TABLE oauth_jobs (
  job_id TEXT PRIMARY KEY
    CHECK (length(job_id) BETWEEN 1 AND 128),
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 64),
  purpose TEXT NOT NULL
    CHECK (length(purpose) BETWEEN 1 AND 32),
  target_ref TEXT NOT NULL DEFAULT ''
    CHECK (length(target_ref) <= 128),
  status TEXT NOT NULL
    CHECK (length(status) BETWEEN 1 AND 32),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  expires_at_ms INTEGER NOT NULL
    CHECK (expires_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(error_code) <= 64),
  error_message TEXT NOT NULL DEFAULT ''
) STRICT, WITHOUT ROWID;

-- 同一 Provider 的「是否还有活动 Job」是每次 Start 前的必查条件。
CREATE INDEX idx_oauth_jobs_provider_status
  ON oauth_jobs(provider_id, status);

-- 终态保留与容量回收都按最后写入时间扫描。
CREATE INDEX idx_oauth_jobs_updated_at
  ON oauth_jobs(updated_at_ms);

PRAGMA user_version = 17;
