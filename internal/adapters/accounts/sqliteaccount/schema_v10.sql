-- 删除墓碑：账号 ref 与静态密钥指纹的不可逆删除事实。
-- Node 旧实现放在 app_kv；Go 自有库需要同样的语义，否则宿主扫描/导入会把已删账号复活。
CREATE TABLE account_tombstones (
  tombstone_key TEXT NOT NULL PRIMARY KEY
    CHECK (length(tombstone_key) BETWEEN 1 AND 256),
  account_ref TEXT NOT NULL
    CHECK (
      length(account_ref) = 25
      AND substr(account_ref, 1, 5) = 'acct_'
      AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
    ),
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 64
      AND provider_id NOT GLOB '*[^a-z0-9_-]*'
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('account', 'api_key')),
  fingerprint TEXT NOT NULL DEFAULT ''
    CHECK (fingerprint = '' OR fingerprint GLOB '[0-9a-f]*'),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999)
) STRICT;

CREATE INDEX idx_account_tombstones_ref
  ON account_tombstones (account_ref);
CREATE INDEX idx_account_tombstones_key
  ON account_tombstones (provider_id, kind, fingerprint);

PRAGMA user_version = 10;
