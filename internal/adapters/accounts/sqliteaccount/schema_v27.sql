-- v27：上游错误映射组（组元数据 + 组内规则条目）。
--
-- 为什么不塞进 Node 的 app-state：
-- 1. app-state 是「读整份 JSON → 改 → 整份覆盖」的文档存储。Go 没有它的锁与
--    版本语义，两端同时写会互相覆盖；映射组一旦由 Go 提供写入口，就必须有自己的
--    并发控制，而 app-state 给不了行级 CAS。
-- 2. 组与条目的生命周期不同：删组要连同条目一起消失（ON DELETE CASCADE），
--    列表页却只需要组元数据。拆成两张表让「组」和「规则正文」各自单一职责，
--    列表查询不必把规则正文读出来。
-- 3. 规则条目只在整组读写时使用，从不按 matcher 查询，因此条目正文用一个 JSON
--    列承载；把 matcher 再拆一层只会增加 join，没有查询收益。
--
-- 全部用 IF NOT EXISTS：这是纯新增迁移，迁移测试会把 user_version 回退后重跑。
CREATE TABLE IF NOT EXISTS upstream_error_mapping_group (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'all',
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  -- position 是集合内的稳定顺序：Node 的组列表本身有序，Go 不按创建时间重排。
  position INTEGER NOT NULL
    CHECK (position >= 0),
  -- version 是乐观锁令牌，每次内容更新 +1；客户端拿旧版本提交时返回 409。
  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_error_mapping_group_position
  ON upstream_error_mapping_group (position);

CREATE TABLE IF NOT EXISTS upstream_error_mapping_rule (
  group_id TEXT NOT NULL,
  -- position 是组内匹配顺序，从 0 开始连续；主键同时保证「唯一」。
  position INTEGER NOT NULL
    CHECK (position >= 0),
  -- rule_json 是已经按 Node 口径归一化并重新编译过的规则值对象。
  rule_json TEXT NOT NULL,
  PRIMARY KEY (group_id, position),
  FOREIGN KEY (group_id) REFERENCES upstream_error_mapping_group(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

PRAGMA user_version = 27;
