# Node → Go 开发执行账（2026-11-14）

## 授权、基线与证据边界

- 用户明确要求实现 `docs/superpowers/plans/2026-11-14-node-go-next-development-plan.md` 全部 W0–W6 并完成提交。
- 本次开始时 HEAD=`d6bc3ffd4`；执行期间并行会话推进到 `6846d57ec`。共享 main 仍有账号、WebUI、shell 和统计等独立改动。
- 不建分支/worktree，不新增测试用例，不回退/重置并行工作。所有提交使用精确 pathspec，提交前后审查暂存区和提交范围。
- 这里的“真实 CLI”指编译后的真实 Go 程序在临时配置上执行，不是测试替身。Windows/Linux 编译只算编译证据，不算真机验收。
- 上一轮线上请求成功是历史证据，本轮不得直接复用它证明新变更已部署。当前只读 readyz=200，不代表全部功能验收。

## W0 入口账初版

已读取另一会话生成的 `docs/product-integrity/entry-inventory-2026-11-14.json`（只读，不纳入本次提交）。其条目为 CLI=962、API=460、功能域=22、Provider=96、Web=25；条目均为声明/源码证据，并非已验收功能。路由、CLI 动态参数、后台任务和页面操作仍须逐叶子映射，**W0 尚未整体完成**。

| 入口/能力 | 当前执行者/数据源 | 当前证据/缺口 | 对应工作包 |
|---|---|---|---|
| codex effort | Node 前门转 Go；原生 config.toml | 本轮真实 CLI 已验证开关、大小写、原文件保留、冲突；未跟踪文件待集中提交 | W1/W2 |
| codex set-default / unset-default | Node command router + Go 账号台账；Go hostsync 尚未接管 Codex | 可用不等于已迁移；需要先审完默认指针/宿主同步的失败边界再切换 | W3 |
| Codex HTTP / WS | Go 原生入口，shared effortalign | 对齐/重试已有并行提交；需要在最终构件上验完整会话、恢复与取消 | W1 |
| Canonical Responses service_tier | decoder → immutable Request → Codex encoder | 未提交，编译通过；响应实际调度档位不得伪写 | W1 |
| 原生 binary resolution | providercli 解包 AIH wrapper | 实机 macOS CLI version 通过；跨平台 alias 格式待审查 | W2/W3 |
| server status/restart | Node 管理命令，Go 公开主进程 + Node 子进程 | 修复未提交；独立审查正在核查多实例与停止范围 | W2 |
| health/readiness | Go 公开 handler；合同仍标 Node | 必须核实前门拓扑与合同语义，不能仅改标签 | W0/W6 |
| 账号 refresh/recovery | Go accountcredentials/accounts/SQLite | 并行在途修改，不复制另一套实现，不顺带提交 | W4 |
| 管理面/会话 watch | Go HTTP handlers + Node 兼容路径 | 并行 WebUI/auth/watch 修改未验收；需要实际桌面 Edge | W5 |
| 其它 Provider/SSH/出口/插件/桌面/安装 | 见完整计划 W6 | 叶子清单、真机覆盖、退场条件仍未完成 | W6 |

合同快照：65 条，61 个 go_owned、4 个 node_owned（含 health/readiness 和两项 preview）。`go run ./cmd/route-ownership-manifest --check` 通过。路由采集 endpoint 252/65，实际仅 14 个 Node 数据面候选参与比较，missing=0；这些数字不可计算全迁移完成率。

## 执行中发现的新增问题

### PREF-01：effort 写入改变已有权限

- 复现：原 `config.toml` mode=0640，旧实现 `effort fast` 成功后变 0600。
- 根因：临时文件默认 0600，rename 时没有恢复原 mode。
- 修复：配置 I/O 独立为 `internal/runtime/codexpreferences`；现有文件保留权限位，新文件默认 0600。CLI 仅解析意图与输出。
- 同时修复：统一大小写参数；读取/写入校验 TOML；对真实目标获取稳定侧车文件锁，两个 AIH writer 不会都基于旧内容覆盖；写入前复核文件身份、符号链接目标、权限与字节内容。
- 边界：advisory lock 约束 AIH preference writer，不约束不遵循该锁的编辑器；提交前检测外部变更，但不宣称跨所有非协作进程实现文件系统 CAS。
- 副作用：config 同目录保留 `.aih-preferences.lock` 空文件；不删除锁 inode，避免并发写者锁不同 inode。进程退出由 OS 释放锁，不依赖 PID 猜锁过期。

## 本轮已取得的真实证据

1. `go build -o /tmp/aih-migration-cli-20261114 ./cmd/aih`：成功。
2. 真实 Go CLI 在临时目录执行 fast、FAST OFF、HIGH、SHOW：exit 0；mode=0640 保留，符号链接、注释、CRLF、profile 保留。
3. 两个真实 CLI 并发写 fast/high：一个明确报锁冲突；重试后两个字段都保存，没有无声覆盖。
4. 无效 TOML 和非法参数：exit 1，原文件不变。
5. `GOOS=windows/linux GOARCH=amd64 CGO_ENABLED=0 go build ./internal/runtime/codexpreferences`：成功；未据此标记相应真机通过。
6. `go build -o /tmp/aih-migration-server-20261114 ./cmd/aih-server`：成功。构建包含当前共享工作区，未用于重启线上。
7. 相关修改 JS 的 `node --check`、`git diff --check` 和 route-ownership check：通过。
8. `/tmp/aih-migration-cli-20261114 codex version` 解析到原生 `.aih-original` 并返回 0.167.2；未执行 Node hook。

## 工作包状态（没有省略任何剩余范围）

| 工作包 | 状态 | 下一步/缺口 |
|---|---|---|
| W0 | 进行中 | 初版归属账已建；全入口覆盖、运行版本关联与在途整合未完成 |
| W1 | 进行中 | 先提交复核后的 effort/参数传递修复；补完整 WS/resume/cancel/usage 验收 |
| W2 | 进行中 | preference I/O 真实验证通过；进程生命周期安全审查及真机矩阵未完成 |
| W3 | 待执行 | Codex 默认档/宿主同步迁 Go；help/completion/escape 一致性 |
| W4 | 待集成审查 | 凭据恢复工作正在其它会话修改；待稳定后集成与真实验收 |
| W5 | 待执行 | 管理面/鉴权/watch 真业务和桌面页面验收 |
| W6 | 待执行 | 其余功能分计划、平台实机、旧回落退出与最终发布 |

## 交付登记

提交记录由实际 git commit 成功后追加，禁止提前写“已提交/已推送”。若正常 Git 网络操作失败，先查 2026-11-14 其它会话的 AWS 临时 Git 代理证据；不写全局代理、不关闭 SSH 主机密钥核验。
