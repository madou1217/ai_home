# WebUI 迁移状态总表（2026-11-11）

> 口径：**Go** = 数据面/持久化在 Go，Node 只做参数预校验与代理；**Go+Node** = 数据在 Go，运行态/调度器视图仍由 Node 合并；**Node** = 主要实现仍在 Node。
> 统计只覆盖 WebUI 管理面（`/v0/webui/*` 与其 Go 对应 `/v1/management/webui/*`），不含推理前门。

## 1. 已完成（按提交时间倒序）

| # | 能力/接口 | 方法 | 归属 | 说明 | 提交 |
| --- | --- | --- | --- | --- | --- |
| 1 | 账号窗口激活 | GET | Go+Node | Go 返回设置/lastProbe/账本视图，Node 合并调度器 global | `80574e8c` |
| 2 | server 配置 | POST | Go | 立即事务合并 patch、sanitize 后整份落库 | `69655a2f` |
| 3 | 全局用量配置 | POST | Go | 规范化后整份写 `config:usage` | `37d7f582` |
| 4 | 会话框粘贴阈值 | POST | Go | 立即事务只合并 `largePasteChars` | `f8a6d51c` |
| 5 | 账号窗口激活 | POST | Go+Node | Go 写配置，Node 校验并读回合并 global | `29b7280d` |
| 6 | 别名池开关 | POST | Go+Node | Go 写 app_kv，Node 写后重载运行池 | `6b04c318` |
| 7 | 上下文窗口清空别名 | DELETE | Go | 与 POST `tokens:null` 同义 | `a635fd61` |
| 8 | 上下文窗口 | POST/bulk | Go | 覆盖表唯一写者，`BEGIN IMMEDIATE` | `42a6d0f8` |
| 9 | 上下文窗口 | GET | Go | 覆盖 > 探测快照 > models.dev 目录 | `f5078eac` |
| 10 | 账号配置文件查看 | GET | Go | 凭据记录 + 投影文件 + 脱敏 + SQLite 导出 | `d92b349a` |
| 11 | toolkit 执行目标 | GET | Go | 本机 + SSH 连接列表 | `f9bc94e1` |
| 12 | server 配置 | GET | Go | sanitize + 公开视图，夹具对拍 | `4d055cca` |
| 13 | SSH 工作区终端状态 | GET | Go | 终端会话状态 | `7d9192f8` |
| 14 | SSH 工作区列表 | GET | Go | 工作区列表 | `74b3bf35` |
| 15 | SSH 连接列表 | GET | Go | 连接列表 | `43ea861b` |
| 16 | 全局用量配置 | GET | Go | 规范化 `config:usage` | `c5a4d50b` |
| 17 | 会话框粘贴阈值 | GET | Go | 同键 `largePasteChars` | `abe53dba` |
| 18 | 插件启用/停用 | POST | Go | 候选原文 CAS | `489dedd3` / `447bf882` |
| 19 | 插件安装/卸载 | POST | Go | 制品校验、签名、清单 | `c42d2c02` |
| 20 | 插件信任根 | GET/POST | Go | 三路由代理 | `df9626ef` |
| 21 | 插件清单 | GET | Go | Node 本地清单已删 | `1d039b47` |
| 22 | WebUI 终端会话 | GET | Go | 管理密钥后反代 | `59311dfb` |
| 23 | 别名池设置 | GET | Go | app_kv 读取 | `62d65d0c` |
| 24 | 额度重置历史 | GET | Go | 分页读删除 | `fb601436` |
| 25 | 应用启动权限设置 | GET | Go | PUT 仍在 Node | `c3b88b7d` |
| 26 | 账号页读模型 | GET | Go | `/v1/management/webui/accounts` | `7f0fdafd` |
| 27 | 额度统计 | GET | Go | Node 第二套窗口算法已删 | `15917203` |
| 28 | 账号 token 用量 | GET | Go | day/week/month/total | `88953897` |
| 29 | 账号级错误规则 | CRUD | Go | 有效规则拼装收敛 Go | `3ebd4928` |
| 30 | 模型别名 | CRUD | Go | WebUI 契约 + 投影重建 | `56de9ae7` |
| 31 | 账号删除/清理 | DELETE | Go | 删除投影 + 宿主清理 | `d7c6f67b` / `6d095eb7` |
| 32 | 登录作业 | POST/轮询 | Go | codex/claude/opencode/zcode/agy/kiro 浏览器登录 | `58cc1311` 等 6 个提交 |
| 33 | 历史用量导入 | POST | Go | 幂等批量导入 | `d4921e1d` |

## 2. 未完成（按优先级）

### P0 账号写路径（影响日常操作）

| # | 接口 | 方法 | 现状 | 主要缺口 |
| --- | --- | --- | --- | --- |
| 1 | `/accounts/:p/:r/status` | POST | Go+Node | Go 写 `accounts.enabled`，Node 展示投影与默认账号维护 |
| 2 | `/accounts/:p/:r/restore-scheduling` | POST | Node | 运行态门禁 `forceRecover` + 运行池重载 |
| 3 | `/accounts/:p/:r/routing-rules` | POST | Node | 规则校验、映射组、凭据 env 写、清阻塞 |
| 4 | `/accounts/:p/:r/set-default` / `clear-default` | POST | Node | 真实会话默认账号 + 运行池 |
| 5 | `/accounts/:p/:r/set-mobile` / `clear-mobile` | POST | Node | Codex App 账号校验与热同步 |
| 6 | `/accounts/:p/:r/update` | POST | Node | 凭据编辑、状态刷新、运行池重载 |
| 7 | `/accounts/:p/:r/refresh` / `refresh-usage` | POST | Node | 上游探测与额度快照 |
| 8 | `/accounts/:p/:r/reauth` | POST | Node | 重新认证作业 |
| 9 | `/accounts/:p/:r/activity/*` | POST/GET | Node | 本机 Chrome + 验证码，强风控 |
| 10 | `/accounts/detect`、`/accounts/add`、`/accounts/local-import` | POST | Node | 宿主扫描与登录作业框架 |
| 11 | `/accounts/add/jobs/:id` 等 | GET/POST | Node | 登录作业内存状态 |
| 12 | `/accounts/import`、`/accounts/import/jobs/:id` | POST/GET | Node | 导入作业与凭据写回 |
| 13 | `/accounts/export` | GET | Go 数据 + Node 路由 | 导出内容已来自 Go，Node 补文件名/node-only 计数 |
| 14 | `/accounts/kimi/:r/plan-stats` | GET | Node | Kimi 上游套餐探测 |
| 15 | `/accounts/kimi/:r/desktop-session/*` | POST | Node | 桌面版扫码登录 |
| 16 | `/accounts/:p/:r/open-app` | POST | Node | 宿主应用/终端启动 |
| 17 | `/accounts/provider-auth-sources` | GET | Node | 插件系统 + 宿主能力探测 |
| 18 | `/accounts/plugin-login/:provider` | GET | Node | 插件登录视图 |
| 19 | `/app-entries` | GET | Node | 宿主机桌面/CLI 实测 |
| 20 | `/accounts/watch`、`/accounts/watch/snapshot` | GET/POST | Node | SSE 与后台刷新 |

### P1 模型/诊断

| # | 接口 | 方法 | 现状 | 主要缺口 |
| --- | --- | --- | --- | --- |
| 21 | `/models` | GET | Node | 按 provider 组装模型目录 |
| 22 | `/openai-models`（含 refresh/delete/watch） | GET/POST/PATCH | Node | 模型缓存、元数据、自定义模型 |
| 23 | `/provider-cli-upgrade` | GET | Node | 含 Node 调度器 state；账本可作为 Go 切片 |
| 24 | `/provider-cli-upgrade/:p/clear-broken` | POST | Node | 验证后解除熔断 |
| 25 | `/provider-hooks`、`/provider-hooks/install` | GET/POST | Node | 各 provider 官方 hook 适配器 |
| 26 | `/slash-commands` | GET | Node | 原生 CLI slash 命令发现 |

### P2 设置/运维/工具链

| # | 接口 | 方法 | 现状 | 主要缺口 |
| --- | --- | --- | --- | --- |
| 27 | `/server-config/management-key/rotate` | POST | Node | 安全敏感的即时轮换 |
| 28 | `/server/restart` | POST | Node | 进程生命周期 |
| 29 | `/control-plane/*` | GET/POST | Node | profiles 归一化 + 本机引导 |
| 30 | `/egress-pool*`、`/egress-upstreams*`、`/egress-evidence*` | GET/POST | Node | 出口池运行态与证据 |
| 31 | `/accounts/:p/:r/egress` | GET/POST | Node | 账号出口绑定（不建议先做） |
| 32 | `/toolkit/environments`、`/guide`、`/jobs`、`/plan`、`/execute` | GET/POST | Node | 14 类工具与运行时探测 |
| 33 | `/toolkit/apps/:appId/settings` | PUT | Node | 写路径（GET 已 Go） |
| 34 | `/ssh-connections` 写、`/ssh-connections/tunnels`、`/ssh-hosts/browse` | POST/PUT/DELETE/GET | Node | SSH 连接写与隧道运行态 |
| 35 | `/ssh-workspaces/:id/terminal` 等会话写 | POST | Node | 远端 PTY |
| 36 | `/fs/trust` | POST | Node | 可信目录写入（读路径仍在 Node） |
| 37 | `/tasks`、`/scheduled-tasks/*` | GET/POST | Node | 未提交的 task-queue 线 |

### P3 会话/项目/聊天/宿主

| # | 接口 | 方法 | 现状 | 主要缺口 |
| --- | --- | --- | --- | --- |
| 38 | `/projects*` | GET/POST | Node | 宿主 HOME 扫描、目录选择器 |
| 39 | `/fs/tree` `/fs/read` `/fs/access` `/fs/media` | GET | Node | 宿主文件系统授权 |
| 40 | `/git/summary` `/git/diff` | GET | Node | 宿主 git |
| 41 | `/sessions/*`（含 archived/lifecycle/watch/messages/events） | GET/POST | Node | 原生会话扫描与生命周期 |
| 42 | `/chat*`、`/chat/runs/*`、`/chat/attachments` | GET/POST | Node | 聊天编排、PTY、审批 |
| 43 | `/session-events/provider-hook` | POST | Node | 官方 hook 事件入口 |
| 44 | `/internal/approval-request`、`/internal/remote-tools` | POST | Node | 内部会话通道 |
| 45 | `/studio/image/*` | GET/POST | Node | 图片工作室 |
| 46 | `/terminal/*`（主会话已 Go） | GET/POST | Go+Node | 终端会话数据 Go，宿主 PTY 仍在 Node |

## 3. Provider × 能力矩阵（2026-11-05 盘点，未逐格重审）

112 格：**go 32 / both 20 / node 48 / none 12**。明细见 `docs/plans/2026-11-05-migration-matrix.md`。

| 能力 | go | both | node | none | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| 登录/OAuth 作业 | 0 | 2 | 14 | 0 | 后续已迁 codex/claude/opencode/zcode/agy/kiro 的浏览器登录，矩阵需重审 |
| 模型目录发现 | 14 | 2 | 0 | 0 | 16/16 由 Go 产出 |
| 额度采集 | 13 | 2 | 0 | 1 | 15/16 由 Go 产出 |
| 推理 relay | 5 | 10 | 1 | 0 | 仅 gemini 仍 node-only |
| 账号删除/宿主清理 | 0 | 2 | 14 | 0 | 删除投影已迁 Go，宿主清理仍 Node |
| 活动签到 | 0 | 0 | 5 | 11 | 强风控，短期不迁 |
| 会话/PTY/SSH | 0 | 2 | 14 | 0 | 宿主级能力，P3 最后做 |

## 4. 建议顺序

1. 账号写路径：`restore-scheduling` → `routing-rules` → `set-default/clear-default` → `update/refresh`。
2. 诊断读：`provider-cli-upgrade`（Go 拿账本，Node 补 scheduler）→ `provider-hooks`。
3. 设置：`control-plane/profiles` → `server/restart`（最后，属进程控制）。
4. 宿主面：SSH 写/隧道 → sessions/projects/fs/git/chat（放最后，收益低于风险）。
