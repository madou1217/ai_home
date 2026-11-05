-- v22：Go 自有的模型别名表。
--
-- 为什么用 IF NOT EXISTS：这是纯新增迁移，重跑必须无副作用。既有迁移测试会把
-- user_version 回退到旧版本再打开，若这里用裸 CREATE，表已存在就会让整个 Open 失败。
--
-- 在此之前别名只存在 Node 的 app-state.db，Go 只接推送投影（内存快照）。
-- 这张表让 Go 能在重启后自己恢复别名，不再依赖 Node 再推一次；
-- generation 单调递增，供路由编译判断「这份快照是否比已发布的新」。
CREATE TABLE IF NOT EXISTS model_alias (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  target TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'all',
  target_provider TEXT NOT NULL DEFAULT 'auto',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  -- position 保留推送顺序：Node 用数组下标做同优先级候选的稳定 tiebreaker，
  -- 只按 priority/created_at 排序会改变别名解析结果。
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS model_alias_order ON model_alias (position);

CREATE TABLE IF NOT EXISTS model_alias_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO model_alias_meta (id, generation) VALUES (1, 0);


PRAGMA user_version = 22;
