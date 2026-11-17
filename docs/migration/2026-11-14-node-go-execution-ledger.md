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
| W0 | 进行中 | 入口/动态RPC已有真实核对；全CLI/WS/jobs/hooks/UI叶子覆盖和当前运行版本关联仍缺 |
| W1 | 进行中 | none后续帧、真实tier回传、managed/raw exec resume已修；Mac标准CLI和Windows/Linux真实矩阵通过，metadata版本/完整取消与账号切换矩阵仍缺 |
| W2 | 进行中 | Mac隔离生命周期及三平台配置/crash恢复有证据；标准CLI已发布，完整三平台托管服务/安装升级矩阵仍缺，禁止共享重启 |
| W3 | 进行中 | 默认事务/公开入口/exec intent Go归属已提交；Desktop effect、mobile全命令/TAB/OAuth与完整App状态验收仍缺 |
| W4 | 进行中 | API-key真实刷新/去重/保旧目录、模型写busy/cancel已闭环；真实OAuth轮换/re-key、其他writer及版本贯通UI仍缺 |
| W5 | 进行中 | 管理auth/assets/watch及RPC有分项证据；现有Edge缺受支持连接，真实完整页面旅程未验收 |
| W6 | 进行中 | 其它owner已交付部分native/backup/hooks/包装；仍需逐域子计划/遗留退出/全平台安装服务与最终发布闭环 |

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

### 2026-11-15公开默认命令切流与共享快照边界

- 其它会话创建 `b71a8858e chore(snapshot): AWS cutover baseline`，明确包含当前在途 single-store/provider/session/front-door/WebUI。W3主体文件与该快照 blob逐一相同，因此它们已经进入共享main，不再计为“主体未提交”。这是快照提交，不等于整个W3/全迁移验收。
- 快照后主索引仍保留旧树，曾显示214文件、约-63609行的反向diff；工作文件全都存在。已通知提交方和并行owner，**本会话未reset/restore主索引**。
- 在明确路径、已运行验收的基础上，一次性独立索引提交 `c26511ad7`，仅2文件：公共`aih codex set-default/unset-default`转Go Host事务，以及保留`--`原生逃生门。
- 只重建标准aih-go（不触碰aih-server），真实公共CLI在临时单库/host目录执行 set41、unset、JSON、invalid-ID、help成功符合合同；偏好profile不变、未产生legacy DB、`--`逃生门没有切账号。真实用户默认账号未改变。
- 旧`node lib/cli/app.js codex set-default`入口也转同一适配器而不执行旧业务writer；真实临时路径执行JSON结果ok/selected41且Go receipt落库。
- Desktop reload/restart仍由聚焦的Node兼容effect承担，Go负责账号/配置/默认指针；不宣称Desktop全平台生命周期已迁完。共享网关从未被本轮重启；外部恢复/部署会话的进程变化独立记录。
- 后续提交仍用明确pathspec及一次性独立索引，直到快照owner确认主索引同步。绝不把反向diff当成自己的改动提交。

## W4/W5真实模型刷新与作业检查点（2026-11-15）

- 运行独立临时Go Server、单库私密clone，仅启用API-key账号41；本地透明转发器原样访问账号既有上游模型目录，凭据不打印、不导出、不提交。
- 初始模型读200/224行；通过真实管理API对gpt-6.1-sol设置force_disable，随后真实上游刷新200（实际上游200），人工策略保持。
- WebUI异步刷新连续两次POST均202，同一jobId，第二次alreadyRunning=true；实际只访问上游一次；轮询到succeeded/finishedAt非空，models/status succeeded、API-key usage skipped。
- 停止这个临时透明转发器后，真实刷新返回502/model_refresh_failed，原目录224行和人工策略逐行相同，未因失败清空last-known-good。
- 临时实例/转发器退出，clone清理；共享9527数据库、配置、进程未改动；没有新增测试文件。
- 本地无Codex OAuth账号，因此不能用API-key目录检查证明OAuth刷新单飞、旋转token、身份re-key等分支完成。相关源码现已集成并保留严格身份守卫，但真业务门槛仍未过。
- W5独立既有证据覆盖管理鉴权/静态资源条件请求/native watch；本轮确认已有Microsoft Edge进程，但无可用CDP监听，DevToolsActivePort读取被OS拒绝，也没有暴露的browser工具。不使用AppleScript、不另开浏览器；真实桌面页面验收仍记未完成。
- 并行main快照后主索引反向diff仍存在，精确checkpoint用一次性索引，主索引未改；不把编译、API成功或peer报告替代全W0–W6完成。

## 2026-11-15跨平台真实配置恢复验收

详见 `2026-11-15-codex-default-platform-acceptance.md`。真实Windows/Linux均通过effort配置保留、gateway default、网关key来源隔离、journal出现后终止CLI与显式重试恢复；Windows journal以protected DACL验证且原生Codex0.163.0 config/read通过。两个主机只操作本次临时目录，进程/目录均清理，已有任务/服务未改变。共享9527未重启。

这只补齐W2/W3相应平台子项，不宣称OAuth、Desktop、原生推理、UI或全计划已完成；Linux无官方Codex，相关原生验收仍缺。共享索引反向diff依然由快照owner协调，本会话继续单次独立索引精确提交。

## 2026-11-15 W1：真实最终档位回传

真实 Canonical 别名请求确认：`none` 已对齐 `low`，`priority` 已送达上游；上游最终返回 `default`，但客户端 JSON 原先丢失 `service_tier`。补齐可选 Canonical 响应元数据及 JSON/SSE 共用 renderer，终态只使用自己的上游快照，不继承 created 的 `auto`、不回填请求的 `priority`。失败元数据沿原有分类/Coordinator链传递，不改变重试、可见性和记账决策。

修复后真实 JSON/SSE 均 200 且完整回传 `default`，每轮一次上游POST、一条usage（11入/5出/16总）。真实流首个文本增量后受控断连，客户端failed档位缺省，上游仅一次POST、无重放、无新usage；未收到终态用量不等于上游免费。`go build ./...`通过。详见 `2026-11-15-codex-response-tier-acceptance.md` 的构件hash、命令和边界。

全部在权限受限数据库副本/独立端口执行，临时资源已清理；共享9527未重启、新构件未发布。WS/resume/fork等完整矩阵、OAuth、真实页面和全W0–W6仍未关闭。原W3 reviewer源码复核关闭旧五项，同时发现Windows两次rename之间与Unix安全回滚重入两个恢复边界；交原代理窄修，不能以此前平台成功记录覆盖这些新发现。

## 2026-11-15 W3：回滚安全权限重入与初次发布中断

原reviewer复审关闭两个窄缺陷：Windows初次两步发布中间态须同时匹配stage after-image与displaced before-image才能no-replace恢复；Unix旧auth回滚收紧到0600后再次中断，可认可完全相同旧内容的安全化权限，不重新放宽到0644。

主代理用完整生产CLI与真实生成的journal完成Unix两次SIGKILL链：旧CLI恢复exit1/external_edit，patched CLI同journal恢复exit0且清理journal/stage、auth仍0600。数据库仅权限受限副本，未写原库/原宿主凭据、未重启9527；go build ./...与Windows交叉编译通过。详情 `2026-11-15-codex-default-reentry-acceptance.md`。

子代理曾越界生成临时合成fixture/component driver，已停止，全部排除验收且不提交；正式Unix证据由主代理真实完整CLI补齐。Windows精确初次窗口仍未真机验收；review另指出回滚自身的两次move之间再次崩溃时，unjournaled rollback temp仍无法自动恢复，保持后续任务。全目标继续active。

## 2026-11-15 W1：WS后续帧none复发根因与闭环

真实同WS两轮复现原始错误：首轮none→low成功，第二轮省略model虽补回gpt-6.1-sol，effort却原样none，上游unsupported_value。原因client pump只normalizeModel，绕过首轮/切模型共用prepareClientFrame。将pump接为Handler方法，抽出bound-frame model/effort准备，不在后续帧执行fresh-peer sanitizer（避免误删同连接previous_response_id与same-account reasoning）；保持observer串行/切模型及foreign-reasoning guard不变。

完整新构件真实两轮均completed，上游两帧皆low/priority，客户端最终皆default；第二轮携前轮真实responseID且store:false，上游仍保留该续接引用并成功。按clone前usage ID边界仅2条新记录。共享9527未重启，真实临时实例/relay/数据库副本已清理。详情 `2026-11-15-codex-ws-followup-acceptance.md`；这关闭后续省略model的none复发，不代表resume/fork/所有WS矩阵完成。

最终WS复审原代理两名与替代代理均因工具协议400终止，能力发现无native review可用；按AGENTS能力链显式降级self_review，已在WS验收文档记录精确commit bypass、原因/风险/自审路径与真实最终构件证据。不将审查故障称为通过、不绕过共享服务重启限制。

## 2026-11-15 W3：Windows回滚两次移动中断的精确闭环

剩余匿名rollback temp缺口已修：从原journal.Staged派生.rollback/.rollback.displaced，固定名发布前完整write/sync；present target只在身份/内容匹配时Exchange，missing target必须凭before/after双证据no-replace恢复，统一4个合法candidate校验/cleanup，auth继续0600/DACL，不改schema/共享fileexchange。

真实Windows完整生产CLI在实际Exchange第一MoveAside成功、第二次执行前由私有debugger断点终止，分别命中初次publication与rollback窗口。真实journal显示target缺失+对应双witness；旧CLI同journal重试exit1/external_edit，新CLI同journalexit0且journal/stage清理。重复rollback gap后实际写入独立native config，新CLI拒绝覆盖、hash不变、journal保留。没有改磁盘binary、没有伪造journal/复制函数用例。macOS完整CLI真实双SIGKILL也重跑通过。

Windows临时目录已校验路径/二进制hash且无活进程后清理，已有task状态前后一致；本机私有数据库副本/进程已清理。go build ./...、Windows构建、focused go vet、route manifest --check通过。详见 `2026-11-15-codex-rollback-publication-acceptance.md`。共享9527未重启/未发布；仍不声称断电全窗口、OAuth、Desktop/Edge或全W0–W6完成。

W3新五文件复审：原subagent再次工具协议400；已读跨会话peer请求尚无结论，消息已读不等于运行/通过。按AGENTS链显式self_review commit bypass，精确范围、crash状态/角色/权限/no-replace自审与未独立复审风险写入验收文档；不以此授权部署或共享重启。

## 2026-11-15 W0：当前入口盘点与动态RPC真实核对

重新执行Go AST盘点：864候选（mux79/WebUI420/public alias365），保留4个动态表达式；不把注册计数当迁移完成率。手工对齐nodeRPCOperations七操作在direct/WebUI/public三前缀的21叶子，真实独立Go server执行30次HTTP：5列表/status每前缀200、2不存在会话404、无鉴权401、错误方法405、未知op404一致。空状态/分派已实证，不替代真实会话正文/UI业务。详情 `2026-11-15-entry-inventory-checkpoint.md`。

旧Node/Go collector比较仍仅含14个Node候选，missing0不能宣称全面对齐。完整产品清单另在/tmp刷新供后续审计，不覆盖并行owner已提交的inventory。全部只读/私有实例，不重启共享9527。

## 2026-11-15 W1：原生CLI新建/resume/fork与实际优先级

实际官方Codex0.167.2通过独立Go网关运行：fast→native新建成功，resume同thread成功，fork新thread成功；均最终OK，无工具执行。none对齐low，fast送priority，真实最终default。fork显式default/low有效且不改root；fast off后的新建按default省略tier，显式fast profile胜过root default。每轮native先generate:false预热再生成，两者不能算重复业务；四生成轮仅4条usage。

**新确认未完成项**：旧fast会话resume仍发priority，即使root fast off、-c default、显式default profile或-c flex；原生请求本身已是priority，非网关覆盖。故不能宣称resume tier优先级完成，也不通过全局网关override/篡改rollout掩盖。安装版本schema提供thread/resume、turn/start serviceTier typed入口，后续需在受管resume边界正规实现/验收。详见 `2026-11-15-codex-native-tier-precedence.md`，包含真实记录/计账与外部限制。全部私有CODEX_HOME/数据库副本清理、共享服务未重启。

## 2026-11-15 W1：受管本地resume/fork typed档位意图

真实native app-server typed thread/resume/turn/start default验证可用后，补caller-local Go桥：native config/read按原命令/Args/Env/Cwd解析实际service_tier，4s/4MiB有界只读probe；仅缺省resume/fork补typed字段，显式typed/null优先，request config tier映射typed。共享gateway未opt-in、不全局改写请求、不写vendor会话文件。

真实旧helper root fast off仍priority；新helper返回default并实际生成完成、同thread、2生成轮仅2usage。显式fork fast保持priority、缺省default、request config fast优先；-c default覆盖root fast且不改配置。实际原生PTY TUI也完成恢复，显式default原样。最终构件真实坏TOML502与SIGSTOP原生probe后取消回收通过。详见 `2026-11-15-codex-managed-resume-tier.md`。仅4个production文件，无新测试用例，暂不宣称raw exec resume/profile bypass或整个W1完成。

reviewer thread limit/原代理工具400，peer已读无结论，按AGENTS显式self_review commit bypass并记录未独立复审风险。共享服务未重启，新构件仅隔离验证；原始全目标保持active。

后续真实调查确认raw exec可通过正式API而非改文件解决：私有真实thread经thread/resume(default)+thread/settings/update(default)+unsubscribe后，全新native exec resume按default发出并完成；2实际生成轮只有2usage。尚未接入启动器，需要精确UUID/name/--last、profile、account scope、活动线程和release-before-launch保护；不把手工调用成功宣称自动路径已完成。记录追加在managed-resume-tier文档。

## 2026-11-15 W1：原生exec resume正式启动意图接线

实现同一个Go codexexecintent模块并接Go CLI与Node default launcher：native config/read及profile root tier/explicit覆盖→精确UUID/name或provider/cwd-scoped last→shared sessions旁per-thread OS lease→metadata/latest-turn idle守卫→官方thread/resume+settings/update+unsubscribe→确认control进程Done后native foreground，lease持有到结束。无vendor rollout/SQLite直接修改。Node private pipe helper丢失会终止foreground并明确exit1，不静默继续。

真实Go UUID/default、profile fast、explicit default赢profile、last固定同ID通过5生成5usage；exact name通过，不存在name/unknown option0上游；Node preflight+完整default launcher通过3生成3usage，重复lease明确busy。reviewer恢复live查出failure unlock顺序/helper loss/stdin '-'三项，已修；stdin真实又发现pointer-only TTY误把pipe放PTY导致EOF hang，改实际term.IsTerminal后same-thread/OK/default/2usage通过。helper SIGKILL真实故障6ms exit1/foreground消失，无追加生成；SIGSTOP native control后owner关闭13ms回收无残留。

复审随后指出Windows npm descendant和Close超时解锁两风险，已复用taskkill /T、等待实际Done再解锁；正在原reviewer final窄确认。详见 `2026-11-15-codex-exec-resume-tier.md`，实机/源码/交叉编译边界分别记录；共享9527未由本会话重启，原全W0-W6未关闭。

W1 exec intent最终独立复审Hubble在23:17:53确认本范围无remaining must-fix；最终Close等待Done、Windows taskkill status/error+立即诊断已源码关闭。真实Windows生产helper实际回收parent+child989ms，不存在PID显式失败；hash/noPIDs/私有目录清理与existing task state4未变均确认。全量build/focused vet/JS语法通过，准备本owner18路径窄checkpoint，不夹带并行逆diff。

W1 exec交付检查发现标准server未含private command，因此新增resolver标准能力优先、无显式override才允许同目录companion；exclusive创建ignored aih-codex-exec-intent，不替换标准server/CLI、不重启共享服务。无任何binary override的实际Node公共launcher再验收same-thread/default成功3生成3usage，重复lease拒绝；显式old binary失败关闭。标准Go CLI仍需后续协调重建，不能将tmp构件成功称全量已加载。

## 2026-11-16 标准CLI交付与Windows真实exec矩阵

canonical buildGoCLIPlan构建，769真实依赖文件与e3266101c committed blob一致且构建前后hash稳定；核对目标oldhash/inode无并行变化后原子发布标准aih-go，旧构件私有保留。标准路径实际fast off/UUID/profile/explicit/last矩阵5成功生成5usage；不再只以/tmp构件宣称CLI可用，standard server未替换/未重启。

Windows官方0.163.0真实新建、同thread managed resume、last+stdin、fast profile、explicit default覆盖通过；首次生成失败后，观察到原私有SSH forward进程已不在，换成live tool handle后沿原thread重试，失败记录不计通过。真实上游6生成尝试5成功5usage，缺终态用量不等于免费。两端私有目录/DB clone/进程/relay与一次性key文件清理，已有Windows task state4未变。详见 `2026-11-16-standard-cli-windows-native-acceptance.md`。Linux官方客户端/OAuth/Desktop/Edge及全W0-W6仍未关闭。

Node宿主guard incident由peer独立负责，我未改相关路径；Go ready200和/ui后来200仅读态观察，不宣称浏览器业务已验收。各自范围/显式pathspec提交规则持续遵守。

## 2026-11-16 Linux官方native0.167.2真实验收

原Linux缺官方Codex缺口本轮按固定版本official package/sha校验补齐：只临时解包，不系统安装。/tmp tmpfs配额导致初次解包失败后，核对archive摘要迁到有空间的私有/var/tmp；只清自己incomplete目录，未删他人文件。真实Linux new、UUID resume、last+stdin、fast profile、explicit default均同thread/OK；请求none对齐low，priority/default按意图送达，上游五个最终default，5生成5usage。root配置保持default。

native/CLI hash、真实/proc精确PID、私有目录清理与existing service inactive/dead/MainPID0未变已核对；本机DB clone/gateway/relay/reverse SSH与一次性key文件清理。详见 `2026-11-16-linux-native-exec-acceptance.md`。不把临时native可用称全局安装，不关闭OAuth/浏览器/全W0-W6。

## 2026-11-16 W4：模型写入争锁、取消与路由发布

真实私有DB external BEGIN IMMEDIATE下GET200而manual PATCH1ms500/internal_error，根因deferred事务先读后升级写锁立即busy。窄修两model写入口：2s writer admission含mutex/conn/BEGIN IMMEDIATE，busy_timeout连接局部0并恢复，25..200ms只retry BEGIN，无业务/上游重放；超限503/account_model_write_busy+Retry-After1。commit前检查取消，提交阶段WithoutCancel且成功持锁publish，再清理。

Hubble独立review指出postcommit取消/PRAGMA预算映射两项，均修复并final窄review无blocking。最终真实锁保留2003ms503不改旧值；350ms解锁同请求385ms200；client cancel后解锁6s无迟到写、后续200。真实上游refresh仅1call/224rows/人工策略保留，断私有relay502保完整last-good。详情 `2026-11-16-model-write-contention.md`。不写共享DB/重启/新增测试，2s非whole-refresh SLA；全W4及W0-W6仍未关闭。

## 2026-11-16 原需求逐项审计

`2026-11-16-requirement-evidence-audit.md`按原顺序保留42个W0-W6勾选要求和7个交付门槛，逐项分证据/部分/缺口，不删原范围、不用route或目录数量作完成百分比。更新顶部过时状态（标准CLI和Windows/Linux native已实证，但三平台托管服务不是同一要求）。当前明确未完成，safe下一步含W1 metadata版本/来源、完整transport cells、剩余CLI/服务/多writer和W6逐域；OAuth/Edge只是特定验收输入限制，不构成全目标停止理由。

## 2026-11-16 WORK native/composer bounded checkpoint

源码 `e036cf01f`（前置协议视图 `987a3d026`）仅提交本owner21路径：account-native/gateway descriptor、既有策略/projection/Capture复用、child env与binary别名、真实transport门槛、AGY stream-json、session-scoped composer/default/submit校验。Hubble与Mendel独立源码审查finding已关闭；主index原字节保留，未夹带configsnapshot/claudedesktopconfig/toolkit六条并行未提交。

从已提交源码archive仅覆盖本组的依赖闭包build/vet通过，产物`f915dfa3dd19f5b73eed51cadc529f1bce4ea0fa713fc9be131ad00b7c0b305e`真实private API及installed Claude验证：固定Claude2/catalog2、CBcn19/catalog19、global224；invalid422、AGY gateway422/absent404；alias wildcard/shadow/restore；Claude fixed-account WORK回合202→completed/idle且实回`WORK_NATIVE_OK`。目录数来自最新DB副本，不与早轮20/223混淆；direct native无gateway ledger记账证明。私有HOME/DB/服务均清理。全部5780非doc文件与提交源码匹配。详见`2026-11-16-work-native-execution-acceptance.md`。

剩余明确未关：零AGY注册账号下仅natural noauth ERROR，无authenticated inference/resume/Capture；global Claude native `/v1/messages?beta=true`仍upstream参数拒绝；其他transport/profile、Edge真实页面、shared WORK发布另行闭环。Chat owner单独授权发布85851ec39不含本组；本session未重启/部署。原W0–W6不标完成。

## 2026-11-16 W0/native Go owner 与 Node 退出状态卡

新增 `2026-11-16-w0-native-node-exit-status.md` 对齐原W0–W6和统一总览，不以21源码/隔离矩阵作迁移完成。Codex effort/default/exec-intent、local appserver及本地native WORK核心已Go；仍有公开CLI/安装wrapper/stdio语义及条件host writer，static启动合同/remote代理，alias首迁/wildcard来源与Node model-policy兼容写者，supervisor尚未退。每项分Go目标、Node调用/写者、阻碍、下一切换及Node-off/退役门禁；不恢复第二套Node业务。

2026-11-16 23:57只读运行证据更新：共享Go93990/Node94287，runtime identity与磁盘sha5cc9d8a9...一致，内嵌revcef00368e且modified=true；旧stamp仍85851ec39/079a565d...不符。历史“当时未加载WORK”不当现状，但不以dirty revision宣称精确加载及验收；先由当前发布owner补来源证明。source/push/artifact/loaded/real accept/Node停用删除分列；AGY、Capture、globalClaude、其他transport与完整Node-off保持Partial。Hubble/Mendel只读审计；本轮仅本人文档checkpoint，无新增feature/test、源码/DB/服务变更，不碰M/terminal/统一README，不授权删除或共享重启。

## 2026-11-17 R1 本地 WORK 无 AIH Node server 宿主真实验收

从 committed9c94b3ad9 archive固定来源构建57e97796...（5999文件逐内容匹配，未带并行worktree），实际Claude2.1.325/静态账号跑create/list/catalog/send/SSE→仅私有Go停起后同session/nativeID+CLI --resume历史正确→active cancel→confirm allow真实文件/deny无文件/pendingcancel清空→5session删除/runs0/全部观察私有进程退出及敏感HOME/DB清理。无AIH Node server/frontdoor/RPC宿主参与，approval MCP为同Go构件；并非仅编译或目录矩阵。

PATH不含node，但仍观察绝对Homebrew Node子进程（一项明确version，另一未完全分类），故仅关闭该静态账号本地WORK的Node宿主依赖验收，不报全服务零Node调用。首轮operator误用rootGET405和事件名已真实纠正重跑，不当产品bug；无production源码修复/新测试。证据`2026-11-17-work-node-free-acceptance.md`及`evidence/2026-11-17-work-node-host-free.json`；AGY0账号、Capture、globalgateway/其他transport、UI/remote/publicwrapper/Node退出删除及共享loaded仍分列未关闭。不等R0来源问题阻塞隔离工程；未共享重启、迁库、凭据改写或动M/Chat9/terminal/protocol。

## 2026-11-17 R1 公开 Go CLI 固定账号 Node-off 实跑

不重复已完成WebUI WORK链，另选公开Go CLI NativeDirect入口：source9c94b3ad9 archive构建aih-go aae834af...，10:46真实执行`aih-go claude <现有数字alias> -- --print --output-format json --model deepseek-flash ...`，exit0/Claude success/实回GO_CLI_NODE_OFF_OK。私有HOME/DB、PATH无node、Gateway随机未监听且无管理key，无AIH server/RPC宿主；观察GoCLI43029→官方Claude43031，Node0/残留0/敏感目录清理。只证明该Go入口，不冒称安装的aih Node包装已切换或删除，亦不关闭OAuth/TUI/取消矩阵。结果追加原acceptance及evidence JSON；本轮无production修复/新test，M/Chat/terminal/protocol/R4R6R8未动。

## 2026-11-17 R1 Codex 显式账号 exec/e 单点 Go 转交

监督独占确认bin/ai-home.js::tryRunGoProviderLaunch，落盘前HEAD/index/disk同blob382d139...且100755；仅1hunk(11+/5-)接codex+数字alias+exec/e(至多一--)，opaque argv直接交既有Go，不走Node app/router/PTY/defaultlauncher/stdio业务，Go失败不fallback。11:10实际公开entry+现存Go cac088bb...→官方Codex0.167.2，实回CODEX_GO_DISPATCH_OK/turn.completed；e-help成功、invalidalias失败关闭，V8 old业务模块均0。私有同字节candidate另6条含缺Go和exactID resume同线程/记住前文，证据分列；共享产物/stamp/服务未操作。Hubble独立审查无blocking，Node bootstrap仍保留，不称整个CLI退出。

同构件空库定向warmup另分类两个新Node探测：Go probeSingleHost→DeepSeek runCli --version和Pi cli --version，source重构与实际ps文本hash291d.../7e14...匹配，Mendel复核。属第三方JS CLI运行时，旧历史PID argv缺失不retroclaim、wholeNodefree不关闭。结果追加既有acceptance§8/§9及evidence JSON；仅该bin源hunk加本人文档，M/Chat9/terminal/protocol/R4R6R8/安装器不动，不新增tests/features或Node业务。


## 2026-11-18 R1 model-prefix headless：真实私有候选，scope待确认

选取bin/ai-home.js::tryRunGoProviderLaunch单一最小predicate，不重复已交即刻exec或R3。已交源0ae8a37a私有archive候选只接一个-m/--model/--model=后紧邻exec/e，argv原样给既有Go。Hubble发现-m -- exec边界P2后增加非空非option值门禁，复审新SHA bca11c5f...无blocking；新SHA02:41:49–02:42:06实跑：真实CODEX_PREFIX_REVIEWED_OK/turn.completed、escape/e与inline帮助成功、invalidalias与私有缺Go失败关闭，五项旧Node业务模块加载0；malformed不接新Go而旧业务仍加载，明确保留未迁。私有进程/敏感目录已清理。当前生产bin仍e1db...干净、无source落地或shared发布；模型前缀扩shape的scope请求pm-3f465d7e尚无回执，旧授权不自动扩大。既有acceptance§10/evidence记录可恢复diff与原始digest，不以private候选代替安装入口/Node退役，Nodebootstrap仍在。M/Chat9/terminal/protocol/R4R6R8/安装器未动，无新tests/sharedrestart/stamp。


## 2026-11-18 R1 model-prefix：scope直接获批后共享单点实做

用户直接准予原owner独占bin::tryRunGoProviderLaunch，已解除上一checkpoint等待。02:48:51重新逐blob/index/mode核对e1db clean后，仅落已独立审查同SHA bca11c5f predicate(12+/1-)，保留peer install/availability。02:49:32–02:49:48真实共享公开entry+现存标准Go62ade266...→官方Codex实回CODEX_PUBLIC_PREFIX_GO_OK/turn.completed；escape短-m e帮助、inline帮助成功，无效alias失败关闭；四项V8旧业务模块0、私有PID/敏感目录清理、entry及Go前后SHA相同。缺Go仍单列此前同SHA私有candidate证据，不移动共享产物。§10待scope记录由§11新事实接续；Nodebootstrap及malformed/默认/TUI等未退役，不宣称全R1/W0-W6完成。无新tests/sharedrestart/stamp/M/协议改动。下一R2已先只读核cf13ed88f26path及18b/2ff后续，并向1e7bb原owner询问在写paths/合同；不以本单点收工。


## 2026-11-18 03:22 · R2 CLI POSIX 纯版本直接 Go checkpoint（Partial）

监督pm-a03c1cb6确认精确两path后，03:20逐blob核同HEAD/index/disk再落wrapper.go CLI-owned POSIX exact --version/-V分支及provider_info.go raw适配。最终b4b84260/195c2c92经原Hubble/Mendel源码复审无blocking；amd64→x64和native signal两P2已修。固定2075e22f2 archive+两path、Goed479591的最终18真实操作通过：绝对NODE_BIN及PATH均无Node、JS helper不可用仍原样官方版本0，缺/旧/不可执行Go、override/host admission、产品真实managed激活/卸载/损坏拒绝均失败关闭，官方native子进程SIGKILL静默137；4排除形状仍旧Node路径126。原JS私有spike不计Node-off。本人三privatehome已清、观察PID/root进程0；build/vet及Linux/Windows x64仅交叉编译通过。共享Go/hook/服务/stamp未更新，仍需公开安装/loaded、旧Node条件selfheal单writer、其他R2分支及W0-W6退出门禁；不称全迁移完成。证据在原acceptance §12及原JSON新增key，不碰run.go/JS/M/协议/Terminal等并行scope。


R2补界：Mendel对最终raw/source/cleanup独立复核，18预期为0×6/1×7/126×4/137×1。额外真正cmd/aih-server+enableCLIHook私有入口尝试ready/鉴权status可用但120s未启CLI，来源核Options.CodexHooks未穿composition传递、内部daemon仅notification；已停止仅本人private并清home，public安装门禁仍阻塞。明确原18矩阵由两私有operational main调用真库，不冒称全程既有公开入口；两path授权不自动覆盖驱动合规。host接线超scope已报监督分owner，本writer不扩composition/run.go/Node路径。


## 2026-11-18 03:44 · R2 后续 stdio 真入口与最小范围调查

00dfa6a05版本两path已push；监督sole接composition，本writer继续而非以version收工。03:42现存__codex-local-app-server私有HOME/PATH无node/无AIHNodehost/无凭据经现成wscat真收6帧：initialize/configread/modellist9/threadlist0成功，threadgoalget真-32600不计兼容。客户端第三方Node单列；初DEVNULL0frame不算、纠正stdin后才实证，PID/home清。下一候选仅transport-neutral bridge.go+既有stdio_bridge/必要stdio_lines让WS委托共享有界核心；3path尚待监督独占未写，不盲把localappserver或串行launchrpc接公开stdin。完整enabled stdio仍需metadata列表/Goal、resumehydration/state机、条件rollout/title writer合同，已明确解除owner并报监督。新事实进acceptance§13/原JSON，无新增生产代码/tests/restart/stamp或别人的索引同步。
