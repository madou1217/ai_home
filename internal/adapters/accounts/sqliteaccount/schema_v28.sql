-- v28：账号级上游错误规则与映射组挂载关系。
--
-- 为什么规则与挂载分两张表：
--   1. 语义不同：rule 是账号自己配置的规则正文，group 是「这个账号挂了哪些组」。
--      有效规则 = 按挂载顺序展开的组规则 + 账号规则，两者生命周期也不同（删组只影响挂载）。
--   2. 规则条目只在整账号读写时使用，从不按 matcher 查询，因此 rule_json 单列承载；
--      把 matcher 再拆一层只会增加 join，没有查询收益。
--
-- source 列是兼容投影的隔离层：
--   'account'    —— 账号级接口写入的配置（组挂载 + 自身规则），读取时要拼装；
--   'projection' —— 旧的 PUT /v1/management/upstream-error-rules 推来的「已拼装有效规则」，
--                   读取时原样使用，绝不能再展开组（否则组规则会被应用两次）。
-- 两个来源分列存放，双写期不会互相覆盖；账号级配置存在时优先于兼容投影。
--
-- 全部用 IF NOT EXISTS：纯新增迁移，迁移测试会把 user_version 回退后重跑。
CREATE TABLE IF NOT EXISTS account_upstream_error_rule (
  account_ref TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'account'
    CHECK (source IN ('account', 'projection')),
  -- position 是同一来源内的匹配顺序，从 0 开始连续；主键同时保证唯一。
  position INTEGER NOT NULL
    CHECK (position >= 0),
  -- rule_json 是已经按 Node 口径归一化并重新编译过的规则值对象。
  rule_json TEXT NOT NULL,
  PRIMARY KEY (account_ref, source, position),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_upstream_error_group (
  account_ref TEXT NOT NULL,
  -- position 是挂载顺序，直接来自 Node 的 AIH_UPSTREAM_ERROR_GROUP_IDS 数组下标。
  position INTEGER NOT NULL
    CHECK (position >= 0),
  group_id TEXT NOT NULL,
  PRIMARY KEY (account_ref, position),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- 拼装时按 group_id 查组；这里不建到映射组的外键：Node 的语义是「挂载了但组已不存在
-- 就跳过」，外键会把这件可恢复的配置变成整次写入失败。组删除后留下的挂载行由拼装跳过。
CREATE INDEX IF NOT EXISTS idx_account_upstream_error_group_group
  ON account_upstream_error_group (group_id);

PRAGMA user_version = 28;
