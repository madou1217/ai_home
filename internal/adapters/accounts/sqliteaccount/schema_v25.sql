-- v25：账号级 Go 路由排除。
--
-- 自定义上游账号的服务端点在 Node，Go 没有它的上游适配器：只要它出现在候选集合里，
-- 请求就会被 Go 选中然后失败。这条事实必须持久化——重启后 Go 仍要记得哪些账号不能选，
-- 只放内存里等于每次重启都把配额重新交还给一个不可用的账号。
--
-- 用 IF NOT EXISTS：纯新增迁移，既有迁移测试会把 user_version 回退后重跑。
CREATE TABLE IF NOT EXISTS account_routing_exclusions (
  account_ref TEXT PRIMARY KEY,
  excluded INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
);

PRAGMA user_version = 25;
