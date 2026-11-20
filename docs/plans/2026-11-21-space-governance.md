# 空间治理（space-gc）— 自动回收 `~/.ai_home` 的可再生产物

> 背景：2026-11-20 实测 `~/.ai_home` 121G，其中 `run/` 106G 几乎全是会话手工整树副本，
> webpack 缓存每个副本 2.9G，账号投影里同一 CLI 版本各存一份。一次性清理只能治标；
> 本文定义**常驻规则**，由 aih-server 周期性执行，不再依赖人工。

## 1. 职责与入口

- 实现：`internal/runtime/spacegc`（规则、探测、去重），
  `internal/host/aihserver/space_gc_daemon.go`（调度）。
- 调度：服务启动 60 秒后尝试首跑；以 `last.json` 的 mtime 做 6 小时节流——频繁重启
  （开发/并行会话常见）不会重复扫描，也不会像 5 分钟延迟那样永远被重启打断。
  结果写 `<aiHome>/diagnostics/space-gc/last.json`，并打一行 `[space-gc]` 日志。
- 所有删除都先检查：目录/文件是否被进程 argv 或 cwd 引用（探测失败时只处理 7 天以上条目）。

## 2. 规则

| 对象 | 判定 | 保留 |
|---|---|---|
| `run/<未知目录>` | 不在产品保护名单 | 空闲 7 天 |
| `*-source` / 含 `go.mod` 或 `web/package.json` 且无 `.git` | 整树源码副本 | 空闲 2 小时 |
| `*.db/-wal/-shm` > 10MB（产品目录之外） | 旧数据库快照 | 空闲 6 小时 |
| `diagnostics/*` | 诊断快照 | 7 天 |
| `retained-evidence/*` | 有 `retention.json` 且 `retainUntil` 到期 | 到期即删；无 marker 视为长期保留 |
| `run/releases/*` | 旧发布 | 30 天 |
| `run/recovery-backups/*` | 旧备份 | 最近 2 个 |
| `artifact-store/trash/*` | 构件库回收站 | 7 天 |
| `retained-evidence` + `run/releases` | 内容相同的大文件（>1MB、24h 未改） | 合并成硬链接，每周一次 |

产品持久目录（`auth-projections`、`chat-workspaces`、`provider-session-state`、`harness`、
`releases`、`recovery-backups`、`virtual-browser-*` 等）在 `governor.go` 的
`protectedRunDirs` / `protectedRunPrefixes` 中显式声明；新增产品目录必须加一行，否则 7 天后会被当成临时目录。

## 3. 人工保留的写法

在 `retained-evidence/<目录>/retention.json` 写：

```json
{ "pinned": true, "reason": "为什么保留", "retainUntil": "2026-12-18T00:00:00Z" }
```

- 有 `retainUntil`：到期后由 space-gc 自动删除；
- 只有 `pinned`（无 `retainUntil`）：永不自动删除（例如敏感 AWS 历史）。

## 4. 共享优先（能公用坚决不复制）

- 账号投影：`artifact-store` + reflink/硬链接，同版本全机一份（见
  `docs/plans/2026-11-20-shared-artifact-store.md`）。
- web 构建：pnpm 全局 store + `~/.ai_home/shared-cache/webpack/<projectKey>`。
- 发布/证据：内容相同的文件合并硬链接；不再保留 `copied-*-quarantine` 这类缓存副本。

## 5. 边界

- 不处理凭据、会话库、账号投影内部状态；不 VACUUM/压缩 `aih.db`。
- 不删除活跃进程占用的目录；不跨卷硬链接。
- 规则是保守的：只回收"可再生"或"明确过期"的东西；拿不准就保留并在报告里列出。
