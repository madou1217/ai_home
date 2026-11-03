# 会话库读取：连接池归并 vs 分批 ATTACH（实测）

> 2026-10-31。对应实现：`lib/sessions/session-db-pool.js`；复现脚本：
> `node scripts/bench-session-db-pool.js [--accounts N] [--rows N] [--limit N] [--json]`

## 要解决的问题

cline 这类 Provider 每个账号一个 `sessions.db`。要求是**跨账号可列出会话**，且
**不合并库、不复制行**（会话严禁复制）。合并 DB 必然要把行 INSERT 到另一个库，
也就是复制，所以只能在读取侧合并。

## 为什么不是一条 `ATTACH ... UNION ALL`

`SQLITE_MAX_ATTACHED` 是 SQLite 的**编译期**常量，Node 内置的那份是 10：

```
attached 10
failed at 10 -> too many attached databases - max 10
```

运行时没有任何 PRAGMA 能改；要提到 125 只能自编译 SQLite 并 fork `node:sqlite`。分批
ATTACH（每批 10 个）可以绕过上限，但每次查询都要 ATTACH→解析 schema→UNION ALL→DETACH，
100 个库就是 10 轮。

## 方案

`createSessionDbPool()`：

1. 每个库一条**常驻只读连接**（`PRAGMA query_only`、`busy_timeout=250`，LRU 上限 512）；
2. 每库执行 `SELECT … ORDER BY started_at DESC LIMIT n`，单库只吐 n 行；
3. 结果按库的"新鲜度"缓存（主库 mtime + `-wal` mtime/size；不算 `-shm`——读连接自己
   会改它，算进去缓存永远失效）；
4. 各库的 list 已排序，用 **k 路归并**取前 n 条，按会话 id 去重（不摊平再整体排序）。

## 实测（macOS，node 22，同一份临时库，每账号 200 行，limit=50）

| 账号数 | 池 warm | 分批 ATTACH | 倍率 |
|---|---|---|---|
| 100 | **1.1 ms** | 9.4~11.4 ms | 8~10× |
| 200 | **3.0 ms** | 18.7 ms | 6.3× |
| 500 | **5.6 ms** | 52.6 ms | 9.3× |

冷启动（第一次查询含建 N 条连接）：

| 账号数 | 冷启动 |
|---|---|
| 100 | ~16 ms |
| 200 | ~66 ms |
| 500 | ~132 ms |

冷启动只在第一次列表出现；之后都是缓存 + 归并的热路径。

## 两个踩过的坑（已修）

- **LRU 上限小于账号数**：上限 128、200 个库时每轮都把刚建的连接挤掉，实测退化到
  27 ms（比 ATTACH 还慢）。上限提到 512 后回到 3 ms 级。
- **把 `-shm` 算进新鲜度**：读连接自己会更新 shm 的 mtime，缓存每次都被判"变了"，
  等于没有缓存。只认主库 mtime + `-wal`。

## 回归守卫（为什么不写绝对阈值）

`test/session-db-pool.test.js` 里有一条 "回归基准" 用例，只做**结构断言 + 同进程相对比较**：

- 库没变时 `stats().queries` 不涨、`cacheHits` 按来源数涨 —— 缓存被绕过会立刻红；
- 默认连接上限 ≥ 512 —— 防住"LRU 小于账号数导致抖动"那个坑；
- 同一份数据下 `pool 平均 < attach 平均 × 1.5`，只留 1.5x 余量吸收机器抖动。

绝对毫秒数不写进断言：不同机器/CI 负载下会抖，写死就是 flaky test。趋势看本文档与
`scripts/bench-session-db-pool.js --json` 的输出。

## 正确性边界

- 只读：不建表、不改数据、不拿写锁；库被别的进程独占时只丢该来源（`busy_timeout`
  会先等 250ms）。
- 单库失败（不存在 / 不是 SQLite / 缺表 / 锁死）进 `failed` 与 `stats().failures`，
  不影响其它账号。
- 这是"读侧合并"：写侧仍然是每个账号写自己的库，原生 `cline --id` 只看得到自己的库。
  原生跨账号续聊需要"一个共享库"，与"不合并"冲突，刻意不做。
