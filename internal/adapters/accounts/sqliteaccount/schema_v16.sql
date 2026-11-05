-- 账号级运行态文档：Node 每轮把 account_state.runtime_state 的完整 JSON 投影到这里，
-- Go 负责持久化与派生（status / until / reason），后续读取方以 Go 为准。
--
-- 与 account_runtime_blocks 的区别：blocks 是「当前生效的失败阻塞」物化，
-- 只保留 kind/scope/until；本表保存完整文档（含按模型冷却），供派生与回读。
CREATE TABLE account_runtime_states (
  account_ref TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(account_ref) = 25
      AND substr(account_ref, 1, 5) = 'acct_'
      AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
    ),
  state_json TEXT NOT NULL
    CHECK (length(state_json) BETWEEN 2 AND 65536),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_account_runtime_states_updated
  ON account_runtime_states(updated_at_ms);

PRAGMA user_version = 16;
