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
| W3 | 进行中 | 默认事务/恢复/权威读桥已在单库副本验收；主体提交与公开入口切换依赖单库底座提交，真实OAuth/跨平台仍缺 |
| W4 | 待集成审查 | 凭据恢复工作正在其它会话修改；待稳定后集成与真实验收 |
| W5 | 待执行 | 管理面/鉴权/watch 真业务和桌面页面验收 |
| W6 | 待执行 | 其余功能分计划、平台实机、旧回落退出与最终发布 |

## 交付登记

提交记录由实际 git commit 成功后追加，禁止提前写“已提交/已推送”。若正常 Git 网络操作失败，先查 2026-11-14 其它会话的 AWS 临时 Git 代理证据；不写全局代理、不关闭 SSH 主机密钥核验。

## 2026-11-14 后续进展

- 已提交 `d1f09a5b4`：全范围授权计划和执行账（2 个文档，不包含另一会话的全产品计划）。
- 已提交 `c1b4b84a0`：effort 命令、权限/配置保留与 writer 锁、Canonical service_tier、缺 App 重载语义、未知模型不继承模板速度档（14 个明确文件）。
- 已提交 `0e1a38ddc`：官方 CLI alias 解包复用安装器备份命名与 POSIX/CMD/PowerShell 字面量解析；真实含空格/单引号路径 + 扩展名 .js alias 启动原生 CLI version=0.167.2。
- `lib/cli/complete/command-tree.js` 在提交前发现混入 peer shell flags；仅撤回本次暂存，没有改工作文件，未纳入上述提交。
- 审查修复 `[[array-table]]` 不应被当作 TOML 根段：真实 CLI 插入 root service_tier，nested service_tier 原样保留。
- 生命周期独立审查发现 MCP helper 误认、多 AIH_HOME 误停、start 非幂等、Node 子进程误清理、打包路径识别问题。W2 保持进行中，正在修；未将未验收生命周期改动提交。
- 生命周期新方案：Go 监听成功后写入本 AIH_HOME 的无密钥 runtime identity（PID/可执行路径/hash/端口）；Node 管理只认 daemon 角色，核实进程 home 和受管父子关系，构件事实与 Node 源码指纹分开。
- 2026-11-14 执行期间全仓 `git diff --check` 在 peer `internal/runtime/chatruntime/codex_rpc.go:384` 报末尾空行；本工作不删除 peer 修改，提交门禁按本次显式路径核对并保留全仓缺口。

W0–W6 **尚未全部完成**；不据这三个提交关闭目标。未推送；尚未出现 Git 网络故障，因此未启用 AWS 临时代理。

## 2026-11-15 00:00 后 W2 进展与 Git 推送

- 当前日期已跨到 2026-11-15（Asia/Shanghai）；用户所说“今天其它会话”的代理线索按授权当时的 **2026-11-14** 检索，不误查成仅 15 日。
- 默认 `git push origin main` 遇到 `github.com:22 Connection refused`。核对本地配置是 `core.sshCommand=ssh -F /dev/null`；历史 AWS SOCKS job 未加载，1080 无 listener。
- 只读会话检索找到 14 日使用 AWS SOCKS 的线索，但未找到完整 Git 成功命令。结合已存在 AWS launcher，验证既有 AWS 主机 SSH 可达；以单次 `GIT_SSH_COMMAND` 的 `ProxyCommand=ssh -W %h:%p ...` 经 AWS 到 `ssh.github.com:443` 推送成功。未修改全局 Git/SSH 配置、未关闭 host key 校验、未转发 SSH agent。
- 共享 main 推送 `96eb20cb3..0e1a38ddc`，包含其它会话已提交内容，符合共享 main 约定；未包含它们的 dirty 工作文件。上述三项本轮提交均已推送。

### W2 审查发现与整改

两轮独立只读审查发现并逐项整改：

1. daemon/helper 角色必须分开，`__mcp-*` / `__remote-ws` 不进生命周期管理。
2. 同一可执行文件下不同 AIH_HOME 不能互相 stop；native 与 Node 的 home 解析须匹配各自 runtime 规则。
3. native supervisor 的 start 必须幂等；已解析的 listener 端口不能被 tracked PID 的空端口覆盖。
4. stop 先停父进程；若父进程被强制结束，随后只清理创建身份和命令均匹配的原 Node 子进程。
5. alias/打包路径使用既有安装根解析，不依赖发行包中不存在的 cmd 源目录。
6. PID 身份必须绑定 OS process start ID，不能因 PID 复用误认另一实例；无可信环境或身份时失败关闭。
7. autostart 检查实际 launcher 的 home，正确支持 Windows scheduled-task/CMD 与 startup/VBS；其它 home 的 job 不宣称当前已安装/加载。
8. Node 源码指纹和 Go runtime binary hash/build stamp 分开校验；新增 runtime identity 含无凭据 PID/home/exe/hash/port/start ID，退出时只清理自己未被替换的记录。

### W2 实机验证边界

- 真实启动两个空账号库的 Go+Node 服务，各自独立临时 AIH_HOME/端口；没有改真实账号库，没有占用/重启 9527。
- 两个 identity 的 PID、home、port、hash 均与实际进程吻合；给临时构件写入真实 build stamp 后，status 只显示各自服务且不误报 stale。
- 真实原生 `__mcp-approve` 作为同二进制 helper 保持存活；重复 start 两次都不改父/Node 子进程 PID。
- **不传 --port**、仅从持久配置读端口的两实例也通过上述验证。
- 正常 stop A：A 退出，B 和 helper 均存活。
- `SIGSTOP` 暂停临时 A 父进程，再实际 server stop：父进程进入 forced 路径，原 Node 子进程被清理，B/helper 不受影响。复核使用平台 `signal.SIGSTOP` 而非硬编码信号数，只有这次属于 forced 证据。
- 临时进程全部退出，9527 `/healthz` 仍返回 200。
- Windows/Linux 相关 Go 包交叉编译通过，**未做 Windows/Linux 真机生命周期验收**。
- 当前共享 9527 仍是未写 runtime identity 的旧构件，CLI 会如实显示 native runtime identity 未验证；本次没有把旧进程伪报成新构件，也未重启加载这些新变更。

W2 的多实例安全/状态代码具备提交证据；W2 全平台、安装/升级完整工作包尚未验收完成，后续不能省略。W3–W6 继续在目标中。

### W2 提交检查点

- `c90f1a820` 已提交：server lifecycle 按实例/进程创建身份隔离、受管子进程清理、构件身份验证（10 个明确文件）。
- 最新 forced 真机记录：无 `--port` 的临时服务 A/B；A 父进程 SIGSTOP 后 server stop 输出 `[forced]`，原 Node PID 96570 被清理；B 及 MCP helper 保持存活。未触碰 9527。
- 审查中指出的全部六项具体问题已在本提交范围整改；Windows/Linux 仅编译，不据此关闭跨平台真实验收。
- 下一实际工作：W3 Codex 默认档迁移。已确认不能直接把 codex 加进通用 allowlist：Go hostsync 未支持 Codex，现有 WebUI HostFileProjection 对 Codex BuildAccount 忽略账号引用，仅写 config provider；尚未覆盖 OAuth/auth.json、网关 client key、宿主同步事务和 Desktop 重载。必须补业务链路后切 owner，不接受“Go 返回成功但宿主未切换”。

## W0：补齐 Go 分文件路由注册发现（2026-11-15）

新增只读工具 `go run ./cmd/route-entry-inventory`。原 regex 工具仅扫描主 router，新的 AST 工具读取 host 构造器、HTTP handler 常量和 internal/contracts 中的别名/拼接；不启动服务、不读账号库、不修改生成合同。

当前实际扫描结果：

- mux_registration=79，webui_constructor=411，derived_public_alias_candidate=357，共 847 条**源码证据**。
- unresolved=8，均记录表达式/函数/文件/行号，包括动态 route.Pattern、alias、函数本地 TrimSuffix 的变量、noderpc 循环拼接。
- 保留显式 `SkipPublicAlias` 与 `/internal/` 排除，不把派生候选当作一定生效；重复/保留路由、构造器可达性、handler 内部 WS/SSE/方法语义必须另外核实。
- 源码条目不等于唯一 URL，更不等于验收功能数。现有 source scanner 输出仍保留；没有改写另一会话的 product-inventory。
- 使用实际当前仓库执行采集成功；Go AST 语法错误会显式失败，不吞错误输出“覆盖完整”。本工具不新增测试文件。

复现命令：`go run ./cmd/route-entry-inventory > /tmp/aih-route-entry-inventory.json`。输出 stdout JSON，无凭据、无实际会话内容。

## W3：宿主配置与动态网关认证依赖（2026-11-15）

- 已盘清 Node 默认行为：`set-default <id>` 写 native openai auth/endpoint，同时保留 command-backed aih_server 供历史会话；无参数 set-default / unset-default 落回网关。Go 通用 hostsync 不能直接替代。
- 新 `codex gateway-auth --ai-home <absolute>` 是供原生配置调用的机器接口，只在 stdout 返回当前网关 key；持久 key 优先，绝不继承任意 OPENAI_API_KEY；错误使用封闭代码。
- 新 HostSpec/PatchHost 是纯内容构建器，当前**尚未切公开默认账号入口**。API/OAuth/gateway 模式都保留 unrelated provider、profile、effort/tier；网关模式 root endpoint 指向网关，OAuth 仅去掉带 AIH 标记的 endpoint。
- 独立审查指出简单按行 TOML 扫描不安全。已改为基于真实 parser 的 statement/value spans，精确保留 quoted key、Unicode 转义、多行字符串、数组；不支持的 inline/dotted managed provider 布局显式拒绝且不给输出。
- 修复 parser 的两项底层限制：表身份用组件编码而非点拼接（`"aih_server.auth"` 与 `aih_server.auth` 不混淆）；允许多行 literal string 的 4/5 个闭合单引号。
- 真实验证：生成三模式配置，原生 Codex 0.167.2 app-server `config/read` 均成功；重复构建幂等；生成的认证命令在持久 key 轮换后立即读新值，无需重写 TOML。
- 独立 Python tomllib 核对 quoted whitespace/Unicode/包含 ] 的表名、转义 triple quotes、嵌套数组与开发指令保持不变；现存 root endpoint→API/gateway→OAuth 的 marker 邻接已复验。
- `effort fast` 也复用 statement scanner，真实 CLI 修改 complex config 只改变根 service_tier，文本中的伪键不变。
- 绝对路径的控制字符、空 hostname、越界端口均先拒绝；stderr 不回显输入配置/密钥。
- 新文件/事务服务仍在集成中：本段不证明宿主账号切换、rollback/recovery、Desktop 重载、Windows/Linux 真机已完成。

## W3 默认事务实施中（2026-11-15）

依赖提交 `7903450e9` 已完成：Go HostSpec TOML 内容构建、机器用 gateway-auth 命令、语句级偏好编辑。默认账号事务仍在审查/集成中，**公开 Node 前门尚未切到新事务，9527 未迁移新 schema**。

当前实现覆盖：

- native config/auth 预检→host 文件锁→版本化默认状态快照→BEGIN IMMEDIATE 核验→0600 journal→文件发布→数据库提交→清理 journal。
- v31 增加 `account_default_ownership` 操作收据及 DB trigger guard。消费者仍读 `account_defaults`；guard 阻止迟到的旧 Node/旧服务 SQL 把不同账号写回来，不是依赖有竞态的客户端标记检查。
- 两个 SQLite 文件使用 FULL 同步；Unix 同步目录元数据，Windows 采用 MoveFileEx WRITE_THROUGH。WAL 多文件并非全局原子提交：局部提交错误保留 journal，后续遇到状态不匹配明确要求恢复，不猜成功。
- OAuth 切走前尝试保存已登记 outgoing identity 的较新凭据，不把 outgoing token 写入 incoming 账号；未知宿主 OAuth 登录要求先登记，不无声丢弃。当前没有真实 Codex OAuth 账号，因此该分支仍未获真实续期验收。
- auth.json 发布固定0600，config 保留原 mode；临时文件、journal 不泄露 key；只在旧值/文件身份仍匹配时回滚。
- Node 默认读侧、默认 CLI 环境和 Go app-server 在所有权转移后读 Go 默认；旧同步不再把 legacy slot 当权威。
- 管理 API 接同一 host transaction，避免先写 DB 默认再尝试 host sync 的半成功。

本轮实际验收（全部隔离数据目录，真实程序，不新增测试用例）：

1. 私密临时 SQLite clone 中选择账号41：auth key/baseURL 与该账号匹配（只输出 boolean），默认指针一致，config max/fast/profile/mode 保留。
2. gateway/unset：原生 provider 和 root endpoint 都指向本地网关，清空账号钉选；未知ID/无效TOML失败且原配置/默认状态不变。
3. 真实 Node front-door adapter 调真实 Go CLI，set/unset/help/invalid参数/JSON回显通过；兼容启动器读 Go 凭据而非继承的错误 key。
4. 用实际 SQLite 连接模拟已迟到的 legacy SQL：不同账号 UPDATE、DELETE 和 gateway 后重新 INSERT 均被数据库约束拒绝；正常 disable 清默认及 delete 级联不受阻。
5. 真实临时 Go Server：WebUI set-default 200、clear-default 200；generic PUT 旧默认请求返回409；坏TOML API返回失败，之前默认 ref+version不变。
6. macOS 给临时 auth.json 设置 user immutable，强制真实文件发布失败：配置自动回滚、auth原样、默认仍gateway、journal已清；解除约束后重试成功。
7. native CLI/Server 构建、相关 JS syntax、Windows/Linux 包交叉编译通过；不将交叉编译计为跨平台真机验证。

仍需完成：复审问题闭环、真实 crash/recovery受控验收、CLI前门部署 gate与 schema同步加载、Desktop重载证据、旧Node/UI写入口彻底收敛、OAuth账号续期与多平台验收。W4–W6 仍未关闭。

## 2026-11-15 恢复后的 W3 增量验收（禁止重启网关）

用户/恢复协调会话已完成 16MiB 入站修复和正式单库切换；本会话**未重做入站修改、数据库合并、回退或共享服务重启**。现场只读确认 `aih.db` schema31、Codex ownership receipt=0，9527 正常。本轮全部默认切换只发生在 SQLite 私密快照和临时 `.codex`。

### 已适应的单库事实

恢复会话把 host default metadata 从 ATTACH 改为 `main.app_kv`；本会话保留此修复。默认指针、owner 和 operation receipt 现在同一业务库事务提交；文件仍有独立 journal 恢复边界。旧文档中多库 WAL 描述仅为当时设计历史，不是当前实施。

### 已关闭的审查问题

- Node 与 Go 的启动器检查 pending journal / conflict；config 单文件软链接的 realpath 旁标记也检查。未处理的切换不得启动混合账号环境。
- 原生默认与 gateway 模式从 Go receipt读取，晚到 app_kv profile 无权覆盖；首次 legacy→Go 也检查代次。
- Node healer/project registry 的配置发布统一调用 Go stdin compare-and-replace，取得同一文件锁并拒绝过期快照。
- 既有文件以平台 swap/保留 displaced inode 后验证；新增文件 no-replace。未确认的新 native 内容保留并标记冲突，不删除以换成功。
- journal v2 记录 stage路径；逐个 cleanup 对**实际移除快照**再次核对 pre/after-image，防止外部写者持有旧 inode 续期后被删。
- auth.json 回滚强制私密模式/Windows protected DACL，Windows 文件 mode仅用于 readonly比较，不当 ACL证据。
- 删除/停用自动回网关变为条件式事务；不会在事务后单独回写profile，也不会清掉更新的默认选择。

独立审查者 Locke 对此前四个具体发现的最终只读复核已关闭（不是全项目完成声明）。

### 本轮真实操作结果

1. 编译真实 CLI 到 `/tmp/aih-w3-cli-20261115`；macOS业务调用、Windows/Linux相关包交叉编译通过。没有新增测试用例。
2. 单库clone中账号41/API default→gateway：host auth key/endpoint与账号一致（只输出boolean），config0640/auth0600、max/fast及profile保留；未产生旧app-state.db。
3. late profile写入、旧generic default SQL写入分别被权威读侧/数据库guard阻止；默认选择不会被恢复成旧值。
4. 实际auth文件immutable导致发布失败：config/auth/默认状态回退，journal/stage清理；解除限制后重试成功。
5. 观察真实journal后SIGKILL新CLI：Node受管启动和Go配置自愈拒绝；重试set-default后回到一致状态、journal/stage清空。
6. 单库临时Go Server实际WebUI set/clear=200，迟到generic PUT=409；坏TOML=失败且默认ref+version不变。仅启动临时私有端口，不触碰9527。
7. 条件式自动落点：wrong expected-ref、OnlyIfUnselected但已有新默认均返回applied=false，文件不变；Go app-server env在pending journal时拒绝，正常态通过。
8. **真实并发native inode更新**：另一个线程持有旧auth文件，在它被swap到stage后写入新内容并fsync；实际CLI返回 `codex_default_external_edit_preserved_recovery_required`，外部新字节仍存在且恢复gate保留。
9. 配置文件软链到独立目录且目标旁有conflict marker：实际Go effort和Node admission都拒绝，配置不变。
10. 已安装标准CLI在临时配置上验证 `effort --replace-config` 可用；未修改安装文件或宿主配置。

### 当前提交/依赖边界

- `751e3ed83` 已提交：共享配置写锁/CAS、外部冲突保留、恢复gate和协作healer/project writer（14个明确文件）。
- W3事务主体、默认读桥和API接线仍未提交，等待单库owner确认其 businessdb/appstate 底座的提交边界；已通过peer发出协调信息，不把对方未提交代码夹带。
- `cmd/aih/run.go`、`bin/ai-home.js`、`composition.go`、schema migration存在并行hunk；不用裸提交纳入。
- 公共default前门还没切；原生Desktop重载仍是显式Node兼容effect，不宣称整个Codex入口纯Go。真实OAuth账号、Windows/Linux真实运行、W4–W6全部验收仍未完成。

### 2026-11-15 W3追加checkpoint：四项审查闭环与独立提交

- `751e3ed83` 与 `ffd256dc7` 已通过一次性 AWS ProxyCommand 推到 origin/main。没有更改全局Git/SSH配置，没有重启网关。
- 最后审查发现的四项均在只读复核中关闭：stage cleanup校验实际删除快照；auth rollback不依赖Windows合成mode；config healer安全交换保留外部版本；legacy→Go也比较启动代次。随后补齐单文件symlink目标旁conflict marker定位，真实CLI/Node均拒绝启动/写入。
- 新的真实并发验证确实观测到 native writer 在被swap的旧auth inode上续写：CLI退出1并报external_edit_preserved，更新后的字节保留且recovery gate仍在；不是仅凭代码声称处理竞态。
- 最新CLI/Server构建在 `/tmp`，单库API/CLI验收再次通过；共享9527进程持续存活，shared schema31且owner receipt仍为0，实际用户默认账号未被本轮切换。
- W3单库事务不再引用ATTACH；当前未提交的businessdb/appstate底座由恢复owner保有，已通过peer请求提交边界。该依赖不能用回退单库或夹带对方全文件来绕开。
- W3事务主体仍待精确提交；其它W0–W6不足没有删除。全目标保持active。

### W0增量：只解析可证明不变的局部路由（2026-11-15）

`cmd/route-entry-inventory` 已支持顶层一次赋值且未取地址/重赋值/遮蔽的局部字符串表达式，及明确的标准库 TrimSuffix/TrimPrefix 调用；没有引入任意代码执行或推测动态变量。实际当前仓库采集结果为 mux=79、WebUI constructor=420、派生alias候选=365，仍全部标记 runtime_state=not_verified。四条聊天集合/运行入口已从unknown变为源码可解析；剩余4处是动态 route.Pattern、alias、两处RPC循环。未解析数下降不是业务验收率提高，W0全入口核对仍进行中。

本轮未写测试用例；真实执行编译后的采集器及标准 go run，输出逐条检查源码函数/表达式。共享服务未重启，数据库未改写。
