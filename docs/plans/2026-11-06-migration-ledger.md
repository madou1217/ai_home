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
| relay mux 迁 Go | 代码已就绪（internal/adapters/socks5 / relaymux / relayudp，含 golden 与 -race），未接线。仍阻塞：9527 由 Node 持有，Go 没有入口 listener；用户名到回环端口的映射仍在 Node | Go 需要先成为外部入口（或由 Node 把 relay 端口流量转给 Go），再补凭据映射 |
| activity 签到迁 Go | 阻塞条件已变：原「并发 agent 正在改」过期——该线最后写入 2026-11-06 20:10，此后无改动；当前仍是 13 个修改态文件 + 4 个未跟踪（含 `pacing.js`、`account-activity-identity.js`），共 17 个，未提交 | 该线提交或放弃后（或明确授权我接管这批改动），再评估 qoder/workbuddy 纯 HTTP 子集 |

## 3. 不建议做

- `peer-dispatch-daemon`：绑 Node peer store/tmux 适配器，属会话面。
- `relay-settings`：两侧共读的配置契约。
- egress 池：A 级（mihomo 子进程 + 控制面 + 车道 + 跨进程状态回收），收益窄、回滚成本高。

## 4. 遗留技术债（与迁移无关但已知）

- 临时 git worktree：`/private/tmp/aih-del-order-wt2` 目录仍在；`/private/tmp/aih-baseline-zcode`、`/private/tmp/aih-head` 目录已不存在（`git worktree list` 标 prunable），可只清元数据，删除仍需人工授权。
- 工作区有 65 个脏文件（多条并发线，较 11-06 未变），后续提交一律 pathspec。

## 5. 2026-11-08 会战：并行切片落地

> 方式：10 个 workflow subagent + 5 个 aih peer（独立 worktree）。所有切片合并后在 main 上跑
> `go test ./...` 与相关 Node 用例。提交：`ebf1072d` / `7f0fdafd` / `4f6c...`（见 git log）。

| 切片 | 结果 | 验证 |
| --- | --- | --- |
| /ui 静态托管 | Go 与 Node serveStaticFile 语义对齐（尾斜杠/资源 404/SPA/HEAD/Content-Length） | 33 条 parity 子测试 + 7 条穿越防护 |
| 令牌刷新 | gemini / grok / cline 迁 Go；Node 策略表删三项、删 gemini/cline 模块；委托开关只覆盖宿主仍维护的 Provider | 15 条契约子测试；委托豁免单测；Node 73 项 |
| 登录策略 | zcode（自定义协议）/ opencode（设备码）迁 Go 并注册进 Job 框架 | 全量单测；登录服务允许四家 Provider |
| relay mux | SOCKS5 服务端（RFC1928/1929 + UDP 关联登记）+ 首字节分流 | 20 例 + `-race`；变异验证 |
| UDP 前端 | 共享 socket、两张表、首报锁定、歧义丢弃、120s 回收、BND 改写 | 21 子例 |
| 账号删除清理 | `internal/adapters/accountremoval`（投影目录/会话探测三态/防穿越） | 临时目录 + 假 tmux probe |
| 账号页读模型 | `GET /v1/management/webui/accounts`（camelCase、分页、缺表 fail-soft、derived_by=go_partial） | sqlite fixture + 对拍脚本 |
| 额度统计切流 | Node quota-stats 全量走 Go；删除第二套窗口算法 921 行 | 23 项 Node 用例；真机 200 |
| 账号写路由清点 | 删除 58 处零引用绑定与 0 调用方守卫 | 4 项新用例 |
| chat 竖切（peer） | `internal/transport/http/webuichatapi`：命令/信封/上游/SSE | 全包测试 |
| 终端会话（peer） | `internal/runtime/terminalsession`：create/attach/write/resize/kill/回放 | 全包测试 |
| SSH 宿主（peer） | `internal/adapters/sshhost`：hostkey/identity/probe/shell/supervisor | 全包测试 |
| session chat（peer） | `internal/runtime/providercli/sessionchat`：命令/环境/失败分类 + 对拍夹具 | 对拍 7220 行夹具 |
| 插件清单（peer） | `pluginapi.InventoryPath` 只读清单（控制面读 app-state.db） | 全包测试 |
