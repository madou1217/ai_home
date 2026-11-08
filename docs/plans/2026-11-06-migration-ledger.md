# Node → Go 迁移总账（2026-11-06）

> 触发条件：没有「可立即做」的切片时停止循环。以下状态都经过真机或单测验证，未验证的会明确标注。
> 最近复核：2026-11-08（`lsof`、`git status/worktree`、`curl` 与 headless Chrome 逐条取证）。

## 1. 已迁并在跑（有验证）

| 模块 | 提交 | 验证方式 |
| --- | --- | --- |
| 账号删除投影 | 表驱动 + 13 家：`726777cc` / `d3b355c9` / `bbca2a6a`；路由 `6f693d5a`；顺序修正 `2e54e712` | Go 单测逐家（投影消失/宿主逐字节不变/墓碑）+ Node 路由守卫（名单与 Go 源码双向比对）+ 反向验证（故意破坏后按预期红） |
| kiro SQLite 凭据 + 快照一致性 | `d8b84469` / `4f07ad46` | 三槽解析、binding 固定向量、adopt+CAS、删除失败后重试仍用新快照（去掉 database 写入会红） |
| 上游错误规则（组 + 账号级 + 拼装） | `3ebd4928` / `38199612` / `ab6d7060` / `71ef99d2` / `6e794a90` / `fc763c61` | 拼装顺序/停用组/Provider 不匹配/缺失组单测；CRUD 与 409 透传；存量 1 组导入对拍；过渡投影链路已删 |
| 登录 Job（codex） | `4464f7b1` / `088aa0ee` / `466a005e` / `b6106ff0` / `416b5a81` / `6261f538` / `19eed632` / `b98d882c` | 18 条表驱动单测；Complete 幂等（-race）；终态落库 v29 跨重启回放；**Begin 半程真机通过**（URL 参数与 Go 常量一致、job 落 Go、取消释放、二次 Begin 不被拦、环境复原） |
| 用量账本 + 额度统计 | `d4921e1d` / `9ba446da` / `b15ee7bc` / `6fe60a33` / `57475482` / `2e020e7b` / `e5be550d` / `c620fccb` | 历史 4.7 万行导入（幂等）；按账号切流点去重；Node 承接流量增量推送；对拍 claude/zcode 全等、codex −0.30%、codebuddy −0.24%；行字段 32/32 走 Go |
| 模型目录 | `c93bde07` / `caaf84c8` / `eedd5b93` / `4d6ed03f` / `b9665fde` / `b6610f59` / `03be8575` | harness 第二次读命中 `meta_only`（已取证）；缓存全量关系集 30/30 diff=0；旧调度器退役后四项真机验证（无残留轮询、编辑触发走 Go、Go 停只置 stale） |

## 2. 阻塞与解除进度（逐条复核于 2026-11-08）

| 事项 | 当前阻塞（含已推进） | 解除条件 |
| --- | --- | --- |
| 登录完整验收（codex） | 仍缺一次真人授权的 Complete。**「地区 403」更正为网络层现象**：`curl` 直连 `auth.openai.com` 返回 `cf-mitigated: challenge`（Cloudflare 人机挑战，不是地区封禁页），直连 `chatgpt.com` 超时、经本机 SOCKS（`127.0.0.1:1080`）返回 200；headless Chrome 仍停在 challenge，需要真浏览器。Begin 半程已真机通过，Complete 已有 18 条单测 + v29 幂等回放 | 用真浏览器（走系统 SOCKS）完成一次真实登录，核对 accounts/credentials 入库与二次登录不新增 |
| relay mux 迁 Go | 已推进：只读评估完成（`db07d511`），S 切片 = 首字节分流 + SOCKS5 认证 + CONNECT 透传 + UDP ASSOCIATE，验收标准已写明。仍阻塞：9527 由 Node 持有（`lsof` 2026-11-08 仍为 node pid 38581），Go 侧无 socks5 实现（`internal/` 全量 grep 无命中），P3 前门无代码/提交 | 先做 P3 前门让 Go 持 listener；同时补 relay golden 用例（全仓仍为零） |
| activity 签到迁 Go | 阻塞条件已变：原「并发 agent 正在改」过期——该线最后写入 2026-11-06 20:10，此后无改动；当前仍是 5 个修改态文件 + 未跟踪 `pacing.js`，未提交 | 该线提交或放弃后（或明确授权我接管这批改动），再评估 qoder/workbuddy 纯 HTTP 子集 |

## 3. 不建议做

- `peer-dispatch-daemon`：绑 Node peer store/tmux 适配器，属会话面。
- `relay-settings`：两侧共读的配置契约。
- egress 池：A 级（mihomo 子进程 + 控制面 + 车道 + 跨进程状态回收），收益窄、回滚成本高。

## 4. 遗留技术债（与迁移无关但已知）

- 临时 git worktree：`/private/tmp/aih-del-order-wt2` 目录仍在；`/private/tmp/aih-baseline-zcode`、`/private/tmp/aih-head` 目录已不存在（`git worktree list` 标 prunable），可只清元数据，删除仍需人工授权。
- 工作区有 65 个脏文件（多条并发线，较 11-06 未变），后续提交一律 pathspec。
