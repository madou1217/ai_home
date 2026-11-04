-- 账号页展示状态补充：configured 与 OAuth 待登录判定由 Go 计算并物化，
-- Node 的登录待定展示直接读这份结果，不再各自推导。
ALTER TABLE account_ui_state
  ADD COLUMN configured INTEGER NOT NULL DEFAULT 0
    CHECK (configured IN (0, 1));

ALTER TABLE account_ui_state
  ADD COLUMN oauth_pending INTEGER NOT NULL DEFAULT 0
    CHECK (oauth_pending IN (0, 1));

PRAGMA user_version = 15;
