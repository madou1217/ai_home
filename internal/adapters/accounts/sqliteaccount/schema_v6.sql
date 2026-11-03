-- Codex 工作区（ChatGPT account_id，个人账号为 personal）提升为公开列。
-- 账号管理投影因此无需读取 profile_json 就能与 Node 暴露同一工作区事实；
-- 历史行从既有 v1 资料 JSON 一次性回填，之后由资料编码器写入。
ALTER TABLE account_profiles
  ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''
    CHECK (length(workspace_id) <= 256);

UPDATE account_profiles
   SET workspace_id = COALESCE(json_extract(profile_json, '$.account_id'), '')
 WHERE account_ref IN (SELECT account_ref FROM accounts WHERE provider_id = 'codex')
   AND json_type(profile_json, '$.account_id') = 'text';

PRAGMA user_version = 6;
