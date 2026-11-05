-- 账号模型探测事实：区分「从未探测 / 探测失败 / 成功」。
--
-- account_models 只保存当前目录快照，清空全部模型后与「从未刷新过」在数据上完全一样；
-- WebUI 需要最近一次探测的时刻、来源与错误，才能决定展示旧目录、空目录还是失败态，
-- 而不是把一次失败的刷新误当成「这个账号没有模型」。
--
-- 每个账号只保留一条（PRIMARY KEY）。失败时调用方不覆盖 last_model_count / 成功来源：
-- 目录快照仍是上一次成功的结果，计数必须与它保持一致；last_source 改记为 error，
-- 让读侧即使只看来源也能判断最近一次探测没有成功。
--
-- provider_id 从 accounts 派生写入，保留它是为了让「按 Provider 看最近失败」不必再 JOIN
-- accounts；账号删除时由外键级联清理。
CREATE TABLE account_model_probes (
  account_ref TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(account_ref) = 25
      AND substr(account_ref, 1, 5) = 'acct_'
      AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
    ),
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 64),
  last_attempt_at_ms INTEGER NOT NULL
    CHECK (last_attempt_at_ms BETWEEN 0 AND 253402300799999),
  last_error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_code) <= 64),
  last_error_message TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_message) <= 300),
  last_source TEXT NOT NULL DEFAULT ''
    CHECK (length(last_source) <= 16),
  last_model_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_model_count BETWEEN 0 AND 1024),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

PRAGMA user_version = 21;
