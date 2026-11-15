# M0：CLI 声明与执行合同映射

## 1. 范围与证据等级

| 项目 | 本次边界 |
|---|---|
| 对应计划 | `docs/superpowers/plans/2026-11-14-product-integrity-optimization.md` 的 M0 入口映射；不是 M0–M5 整体验收 |
| 源码快照 | 2026-11-14 23:51（Asia/Shanghai）收尾复核，HEAD `0e1a38ddcb9f` **加共享工作区未提交内容**；读码期间并行修改持续，以下摘要标识已核对版本，不能用 HEAD 单独重建 |
| 唯一写入 | `docs/product-integrity/cli-contract-map.md`；其他文件，包括主会话正在修改的 shell/runtime，全部只读 |
| 执行边界 | 仅源码读取与静态核对；未运行 CLI/help、测试、provider、配置操作、推理、构建或 Git 写操作 |
| 行状态 | 下表全部为 `source_audited / runtime_not_verified`。有声明、有 handler、已运行成功是三件事；不能据行数计算功能验收率 |
| 问题等级 | “确认差异”仅指源码可确定的分派/声明差异；是否触发实际故障、上游版本支持及最终副作用仍待真实验收 |

证据缩写（行号为本次快照，代码继续变化时以函数名重新定位）：

| 代号 | 源码 / 职责 | SHA-256 前 12 位 |
|---|---|---|
| D | `lib/cli/complete/command-tree.js`：声明与补全候选，不是可执行注册表 | `6ea8ed31ae1a` |
| E | `bin/ai-home.js`：公开 Node 入口、条件式 Go 转发、轻量入口 | `9ea4825af92b` |
| R | `lib/cli/commands/root/router.js`：Node 根命令路由 | `4f27640cf769` |
| G | `cmd/aih/run.go`：Go CLI 根路由 | `dca9d24cd12e` |
| P | `lib/cli/commands/ai-cli/router.js`：Node provider/harness 路由 | `93c9d5a51d07` |
| C | `lib/cli/complete/resolve.js`：账号位、动作位、会话位补全 | `97f8e0a3522e` |

下文路径均相对仓库根；`D:39` 表示该文件第 39 行附近。表内叶子用逗号分隔，表示**必须分别登记**，不是一条已完成业务。建议功能 ID 为 `cli.<根命令>.<动作>`；provider 叶子为 `cli.provider.<provider>.<动作>`，参数次序/执行模式为其独立验收变体。

## 2. 实际分派顺序与不可破坏语义

| 顺序 | 源码链 | 必须保留的边界 |
|---|---|---|
| 1 | E:12、1103–1113：`__complete/__suggest/__learn` 直达 `lib/cli/complete/index.js` | 不装配完整 CLI；补全/建议/学习不是同一种操作，学习会写历史/纠错状态 |
| 2 | E:1112：家族 session/login/common/restart/launch → 全局 sessions/ls → Codex 特例 → 其他 provider 快路径 | **第一个返回 true 的分支拥有本次调用**。账号位置、额外参数、管理 key、出口绑定可改变实际 owner；不能只按 provider 名判定 Node/Go |
| 3 | E:713 `resolveGoCLIBinary` → `bin/native/<platform>-<arch>/aih-go[.exe]` → G | 被接管的形态若二进制缺失通常报错且不回落 Node；不满足转发条件则可能继续 Node。Go handler 存在不等于公开入口可达 |
| 4 | E:1113 → `lib/cli/app.js:584,753` → `lib/cli/bootstrap/root-dispatch.js` → R | R 先规范别名、处理全局命令/备份，再落 P；`runServerEntry` 是 Node 命令入口，不代表服务进程也是 Node |
| 5 | P:440、554 → `runCliPty`；`lib/cli/services/pty/runtime.js:134` 装配 launch/spawn/run；G:238–258 → `internal/host/aihcli` 的 `app.Run` | 保留官方二进制、参数、账号身份、原生会话与退出/信号语义；不能把 AIH 统一动作当 prompt，也不能拿删功能换对齐 |

- `ls/list` 是根别名；`ss/sessions` 是根别名；`help/--help/-h` 与空参数走根帮助。
- `serve` **不是** `server` 的简单同义替换：`lib/cli/commands/root/args.js:7–27` 将裸 `serve` 变成 `server start`，带参数变成 `server serve <原参数>`，帮助特判；`daemon` 则为 `server <原参数>`。补全下钻不能抹掉这一区别。
- 顶层 `usage` 是历史 token/成本统计；provider `usage` 是账号额度；顶层 `resume` 是跨 provider 选择器；provider `resume` 是原生会话动词。不能合并为同一叶子。
- 未知顶层走 P:576–594 的提示/拒绝（通常 exit 2），纠错建议不能自动执行；已知 provider 下非 AIH 保留动作则可能是合法原生命令，不能同样当拼写错误改写。
- P:865–881：支持 `gateway_profile` 的 provider 裸启动选 AIH Server 池，宿主 `set-default` 不应劫持它；显式账号、`accountRef`、默认档、跨 provider relay 必须分别保留。无 gateway profile 的 provider 有自己的默认/健康账号回退路径。

## 3. D 声明的全部顶层命令及别名

D:39–317 共 **25 个规范名、6 个别名（31 个 token）**。此表已覆盖这些名字；provider 名、动态/内部入口另列第 4 节。标记：**读**＝读为主但不保证零缓存写入；**写**＝配置/数据改变；**执行**＝进程、网络或会话操作，可能产生费用。没有 Go 根命令不是缺陷，Node 可以是正确 owner。

| 根命令（别名） | 实际可执行入口 / Go 接管条件 | 必须拆分的叶子、保留意图与风险 |
|---|---|---|
| `ls`（`list`） | E:144 `tryRunGoGlobalLs` 将 `list` 规范为 `ls` → G:87 `runGlobalAccountList`；其他形态 R:75 → `lib/cli/services/profile/ls-request.js` / `listProfiles` | 全量、按 id、`--scope`、provider 通配/子串、帮助；读，不能因换 owner 漏账号 |
| `resume` | R:262 → `lib/cli/commands/resume/router.js:290` `runResumeCommand`；无 Go 根选择器分支 | 查询/过滤、JSON 预览、交互选择、取消、续接；读/执行 |
| `ss`（`sessions`） | E:34 `tryRunGoGlobalSessions` → G:91 → `cmd/aih/global_sessions.go:24`；未接管形态 R:83 → `lib/cli/services/ai-cli/persistent-session-list.js:2268` | 裸 picker/非 TTY 列表、按名进入、list/detail 别名、refresh、帮助；缓存/attach/关闭须另审。D 的 `--history` 不成立，见 F07 |
| `usage` | R:159 → `lib/cli/services/usage/model-accounting.js:312`；数字目标另见第 4 节 | `stats`（`summary`）、`models`（`cost-by-model/by-model`）、`sessions`、`session-detail`（`session`）、`scan`、`recalculate-costs`；读/索引与成本写入 |
| `update` | R:186 → `lib/cli/bootstrap/update-wiring.js` → `lib/cli/services/update/self-update.js` `runUpdateCommand` | check、dry-run、实际更新、force；网络/安装写入 |
| `server`（`serve/daemon`） | R:412 → `lib/server/entry.js` → `lib/server/command-handler.js:134`；不是 G 的根命令 | `start/restart/stop/status/serve`；`add/ls(list)/use/remove(rm)`；`config show/get/set/list`（`lib/server/server-config-command.js:534`）；`autostart install/uninstall(remove)/status`；`env`；`sync-codex(sync_codex)`。分别涉及读、配置、凭据同步、服务生命周期 |
| `desktop` | R:294 → `lib/cli/commands/desktop-router.js:99` | 默认/status、JSON、帮助；canonical/影子副本/运行版本只读检查，不等于启动桌面 |
| `edge` | R:304 → `lib/cli/commands/edge-router.js:105` | status；plan/apply × `frp/nginx/caddy`；**remove 目前只接受 frp**；plan/dry-run 与真实写配置/重载分开，见 F06 |
| `claim` | R:334 → `lib/cli/services/claim/claim-command.js:241` | `qoder/qodercn/zcode/all`、账号选择、dry-run、真实领取；会调用活动接口，非纯额度查询 |
| `harness` | R:273 → `lib/cli/commands/harness/router.js:189`；目录来自 `lib/harness/catalog.js` | list、`pi/dsh/dsh-tui` × provider/account/model/model-alias、原生参数；执行/推理 |
| `shell` | R:348 → `lib/cli/commands/shell-router.js:245` | `status/plan/apply/remove/snippet`、`typo list/forget`；源码另有 `doctor`。四 shell、rc 指定、组件开关、dry-run、JSON 分别登记；本页不接管主会话修复 |
| `agent` | R:235 → `lib/cli/commands/agent-router.js:159` | `adapters(list)/capabilities/probe`；声明能力、选择适配器与真实可用性不可混称 |
| `peer` | R:244 → `lib/cli/commands/peer-router.js:228` | `list(ls)/send/inbox/read/reply/flush/channels(providers)`；各通道/投递模式、等待、dry-run、失败分别审；发送可能驱动另一会话 |
| `export` | R:407 → `lib/cli/commands/backup/router.js:467` → `runExport` | 全量/选择器/输出文件；导出含明文凭据，不能当普通诊断 |
| `import` | 同上 → `runImport:159` | AIH 原生 JSON 文件、多个文件、dry-run、身份合并/失败；写账号，不能据旧文案承诺 zip/目录 |
| `backup` | R:407 → `lib/cli/commands/backup/router.js:432,467` | `add/list(ls)/remove(rm)/enable/disable/run/status/test/restore/config/show`；本地/远程、增量/full、dry-run 分开；SSH/备份/恢复不是只读 |
| `provider` | R:217 → `lib/cli/services/provider-resource-command.js:16` | `ls/capabilities/doctor`；目录及资源边界，不是某个 provider 的原生启动 |
| `native` | R:221 强制第二词 `plugin` → `lib/cli/services/native-plugin-command.js` | `plugin list/install/enable/disable/remove/inspect/project/doctor`；原生投影，不与 AIH 插件包混并 |
| `mcp` | R:226 → `lib/cli/services/mcp-command.js:44` | `list/add/test/tools/call/enable/disable/remove/doctor`；test/tools/call 会运行 stdio server，停用投影也可诊断，不是安全静态检查 |
| `skill` | R:230 → `lib/cli/services/skill-command.js` `runSkillCommand` | `list/install/enable/disable/remove/doctor`；provider/all-supported、投影与删除分别审 |
| `plugin` | R:284 → `lib/plugins/control/cli.js:151` | `validate/pack/keygen/trust/untrust/trusted/install/list(status)/enable/disable/uninstall/call/doctor`；信任根/签名/实例/贡献项执行各有风险 |
| `ssh` | R:190 → `lib/cli/services/ssh-clipboard/ssh-command.js:136` | 帮助、SSH 参数/连接、图片粘贴包装；连接和剪贴板副作用需真实验收 |
| `ssh-clipboard` | R:208 → `lib/cli/services/ssh-clipboard/terminal-probe.js:445` | `probe`、普通诊断/真实 paste-event、超时、帮助；交互终端操作 |
| `clip-agent` | R:199 → `lib/cli/services/ssh-clipboard/clip-agent.js:122` | `start`、监听/终止、帮助；会启动本机剪贴板代理 |
| `help`（`--help/-h`，空参数） | R:12,48 → `showHelp`；Go 直调 G:78,180,318 使用自己的帮助 | 根帮助、provider 帮助与原生帮助分别验收；不能由帮助文本推导实际支持 |

## 4. 声明表之外的真实入口

| 入口 / 分类 | 实际来源与处理 | 库存处理 |
|---|---|---|
| `account`（公开 Go 命令组） | E:475 `tryRunGoAccountCommand` → G:83 → `cmd/aih/account.go:45` | D 未列出。必须拆 `add --from-env`、`import <provider>`/`import --artifact-file`、`list/show/enable/disable/delete --yes`、`credential update --from-env`、`default show/set/clear`、`models list/refresh/set-policy`、`usage show/refresh`。各子路由为 `cmd/aih/account_*.go`；E 注释提到的 `transfer` 不在实际 switch，不能登记成已实现 |
| `pi/dsh/dsh-tui`（直接 harness 入口） | R:431 → P:440 `isExternalHarness` → `runExternalHarnessCommand`；`lib/harness/catalog.js:10,40,81` | 不只是 `aih harness <id>` 的子命令；直接形式的账号、resume/fork、透传应独立核对。D 顶层未收录 |
| `<数字账号>`、`usage <数字账号>`（条件简写） | R:27–37、363–377 `resolveUniqueCliForAccountId` | 仅数字在受支持 CLI 中唯一匹配才展开；冲突/不存在不得静默猜 provider。不是无限多个顶层命令 |
| `<provider模式> ls` | R:387–398 / E:699 → `lib/cli/services/profile/ls-request.js`；使用 `listAccountProviders`，不局限原生 CLI provider | 子串/带引号的通配符（含只有账号的 provider）是入口语法；不能仅统计固定名字 |
| `workbuddy/workbuddycn`（条件兼容入口） | E:711 家族快路径包含二者；G 用 `codebuddyfamilystorage.IsFamilyProvider`；合同 `clients.cli=false`，Node `isSupportedAiCli` 不接受普通启动 | 是部分形态可达，不是完整 CLI 支持，也不能因 D 无候选判定全部不存在；见下节 |
| `zcode-url`、`zcode-scheme` | R:314,324 → `lib/cli/commands/zcode-url-router.js:92` / `zcode-scheme-router.js:93` | URL 回调接收/归属判断/转桌面；scheme 的 `status/install/uninstall`（macOS gate）。前者是系统回调，不必都展示成普通用户命令 |
| `proxy`（退役兼容入口） | R:121：报已替换，exit 1，提示 `server/serve` | 必须保留明确拒绝，不称为 server 别名 |
| `__complete/__suggest/__learn`（内部） | E:1103 → `lib/cli/complete/index.js` | 补全、建议、学习三个叶子；不应为了补齐列表直接公开给普通补全 |
| `__background run`、`__ssh_mcp__`、`__remote_ws__`、`__usage-probe`（内部） | R:94–158 → 后台 supervisor、SSH MCP loop、`lib/server/ssh-remote-supervisor.js`、额度探针 | 参数校验、启动/退出、协议/凭据边界各自登记；未执行。不是“隐藏所以缺失” |

## 5. Provider 顶层与动作所有权

### 5.1 Provider 名单和公开入口选择

名单来源：`lib/cli/services/ai-cli/provider-registry.js:46` 读取 `contracts/providers/manifest.json` 的 `clients.cli && cli`；人工定义归 `core/providers/builtins.go`。当前 D 可见 **14 个 CLI provider**，未发现 provider 名别名声明；`qodercn/codebuddycn` 是独立身份，不应改成另一个名字的 alias。

| provider（已穷举） | 启动形态 / 实际入口 | 限定动作与发现边界 |
|---|---|---|
| `codex` | 常规公开启动进 P → PTY；不是 E 的通用数字启动集合 | E:218/270/316/396 分别接管 mobile、effort/policy、home、历史；通用 ls/usage 等另走 E:568 |
| `claude` | 常规公开启动进 P → PTY | version/历史/通用管理有 Go 转发；不能把 G 的直调能力视作公开 wrapper 已全切换 |
| `agy` | E:432–470：显式数字账号且无阻断动作 → Go `app.Run`；否则 P | E:522 有 login；D 因空 `loginArgs` 隐藏 login，见 F10 |
| `gemini` | 同上 | 不在 E 的 Go login 集合，普通 login 留 Node |
| `opencode` | 同上 | Go set-default 只接数字形态；unset-default 明确保留 Node 网关恢复（E:592–600） |
| `grok` | 同上 | login/历史有 Go 转发；会话参数对齐见 F04 |
| `qoder` | 同上 | login/历史/set-default 有条件 Go 转发；fork 身份组合见 F04 |
| `qodercn` | 同上 | 与 qoder 共用实现不等于合并账号身份 |
| `kimi` | 同上 | login 有 Go；不在 E:653 的历史转发集合，不能据其他 provider 推断 |
| `kiro` | 同上 | login 有 Go；P:1889 另保留 `--device-code/--refresh-token` 登录；统一 resume/fork 不能冒充 TUI 能力 |
| `zcode` | 同上 | 不在 E:522 Go login 集合；协议回调独立于 CLI login |
| `cline` | 同上 | login/历史有 Go；精确会话 ID 原生参数是 Node 策略的 `--id`，见 F04 |
| `codebuddy` | E 家族：session 动词、sessions、login、管理、restart、数字启动 → 各自 Go 分支 | `applyGoFamilyEgressGuard`（E:728）可把需代理/绑定的启动交回 Node；不能跳过出口绑定。login 在执行路由存在但被 D 隐藏 |
| `codebuddycn` | 同上 | 独立站点、共享会话布局不意味着任意跨站替换 |
| `workbuddy/workbuddycn`（D 不可见） | 同一家族 Go 条件分支；Node 常规 fallback 在 P:576 拒绝 | 合同有意 `clients.cli=false`。实际形态支持与产品是否公开，须另裁定，不默认添加 CLI 支持 |

通用 Go 管理转发由 E:568–650 的**参数形状白名单**决定：`ls [id]`、`usage [id] [--refresh/--no-cache]`、`terminal-icon(s)`、`auto-switch`、`delete/deleteall(delete-all)`；set/unset-default 还受 provider 白名单限制。需要管理面的形态缺 management key 可回 Node。family 管理另见 E:1021–1058；其 `isList` 算出后没有进入最终放行条件，不能按注释认定 family `ls` 被此分支接管。

### 5.2 动作与叶子合同

| 动作 / 别名 | 源码可达路径 | 必须独立盘点的叶子与风险 |
|---|---|---|
| 裸启动、数字账号、`accountRef`、`.aih-server`、原生参数 | P:865–881、1791–1855、1935 起；G:215–258 / `internal/host/aihcli` | 池模式、固定账号、跨 provider、健康回退/账号不存在、headless/PTY、会话标签、退出；执行/可能推理，不在本轮运行 |
| `ls` | R 的 provider-scope 规划、E 通用/全局列表、G `runProviderList` | 全部/指定账号/模式匹配/输出完成；读 |
| `sessions` | P:1045；family E:921 → `cmd/aih/provider_sessions_list.go`；历史 E:396,657 → `cmd/aih/provider_sessions.go` | **`sessions [账号id]` 是持久会话范围**；`sessions --history [--limit N]` 是原生历史。进入/关闭/详情与列表分开，不能把账号 ID 与原生 session ID 混用 |
| `resume/fork` | `lib/cli/services/ai-cli/provider-resume-verb.js:56` → `lib/runtime/provider-resume.js:325,391`；Go `cmd/aih/resume_account.go:27,255` | 有/无 session ID、账号在前、能力拒绝、原始参数；只改统一动词，不改原生会话身份。当前两实现不等价，F04 |
| `login` | P:1886；E:525/983 → G:168 → `cmd/aih/provider_login.go:20` | 新账号、no-browser、API key、Kiro 特例、取消/失败；凭据写入/可能启动原生程序，F05/F10 |
| `detect` | P:915 → `lib/account/host-account-detectors.js`；family G:134 → `cmd/aih/provider_detect.go` | 注册表能力 gate、发现、身份去重、账号登记；**不是只读扫描**。Node 检查入口 provider 后调用全 detector 集合，范围也需保留/确认 |
| `import/export` | 只在动作紧跟 provider 时由 R:380–384 注入 `__provider__` → backup/router | AIH 原生 JSON、provider 过滤、选择账号、dry-run、凭据导出；账号在前不是同一语法，F08 |
| `usage`（Node 另有 `--usage/stats`） | P:691、1358、1947；E 通用管理 → `cmd/aih/provider_usage.go` | 全账号/单账号、refresh/no-cache、preflight、`-j <并发数>`；可能查询上游/更新缓存，非纯成本报表 |
| `auto-switch` | P:1313；G:142 → `cmd/aih/provider_autoswitch.go` | `on/off/status`（Go 另接受 show）、remaining 阈值；**全局** `config:usage`，不因写在 provider 后就变成每 provider 配置 |
| `home`、`version` | P:1021/1033/1261；G → `cmd/aih/provider_info.go` | home 默认/指定账号/网关诊断；version 查询实际原生程序。`--version` 是原生参数，不是 AIH `version` 的机械别名 |
| `terminal-icon/terminal-icons` | P:969；G:123 → `cmd/aih/provider_terminalicon.go` | 输出片段、iTerm2/Linux/Windows Terminal 安装、all/JSON/帮助（该文件:203–220）；配置写入与平台能力分别审 |
| `set-default/unset-default` | P:1428–1699；G:171 → `cmd/aih/provider_default.go` | 数字账号/网关档、宿主同步、clear/restore、restart/force-quit；写配置/可能重启桌面。gateway provider 的 unset 在 Node 可恢复网关，不只是清指针 |
| `delete/deleteall/delete-all` | P 的 DELETE 集合；G:128–132 → `cmd/aih/provider_delete.go` | 单个/集合/范围/全部、投影清理、失败与确认；破坏性操作不得为核对执行 |
| Codex `set-mobile/unset-mobile` | E:218 → G:95 → `cmd/aih/provider_mobile.go`；P:1700/1755 有 fallback | ChatGPT OAuth 校验、App 账号指针、runtime reload；写入/桌面副作用 |
| Codex `effort/policy` | E:270 → G:98–103 → `cmd/aih/provider_effort.go:12` / `provider_policy.go:32`；policy 有 P fallback | effort 的 show、强度、fast on/off；policy 的 show/set 三种 sandbox。是 AIH 配置入口，不能宣称原生 TUI 有 `/effort` |
| `help/--help/-h`、原生 `--` | P:906/1274；G:180–214 | AIH 帮助、原生帮助、原生保留字透传分别验收；不能笼统使用 `动作 --help` 当无副作用探针 |
| 旧动作 `auto/count/cleanup/up/down` | P:696、1861、1941 | 已明确拒绝；不是补全漏项，不恢复成隐式行为 |

### 5.3 账号位置与 `--`：不能假设可交换

| 输入形状 | 当前源码行为 / 合同边界 |
|---|---|
| `aih <p> usage <账号>` / `<p> <账号> usage` | Node 有两个分支；前者可能先被 Go 接管，后者一般留 Node。`home` 也有双位置处理（G:148 / P:1021,1033） |
| `aih <p> resume <session>` / `<p> <账号> resume <session>` | 第一种的动词后参数是 **session**，不是账号；第二种才钉选账号。fork 同理，但能力处理有 F04 差异 |
| `aih <p> sessions <账号>` | 实际过滤账号；C:40,442 却按 session ID 补全，见 F03 |
| `aih <p> <账号> delete/login/set-default/sessions/...` | C:447–454 给全部动作候选；P 数字分支并未实现通用重排，仅专门处理 usage（home/resume 更早处理），其余可进入原生透传。`accountRef` 分支 P:1795 更是直接启动，不保证与数字语法等价 |
| `aih <p> -- <原生参数>` / `<p> <账号> -- <原生参数>` | 意图是仅移除 AIH 分隔符，保留账号及参数，之后不再解释 AIH 动作/选项。当前实现违反这一边界，详见 F02；不能承诺已正确逃生 |
| `aih <p> relay ...` | G 的用法声明与 Go launch intent 有 relay 模式；E 的普通公开启动不因该单词自动切 Go，P 可能按原生参数透传。公开 wrapper 与直接 Go 的最终等价性未追完，列入 U02，不宣称可用或删除 |

## 6. 已确认源码差异（均未运行复现）

以下给的是排查样例和最小修复边界，**不是执行授权**。账号/会话仅为占位，不可照抄在已登录环境中试跑。

| ID / 优先审查 | 确认差异与证据 | 后续最小工作包 / 验收边界 |
|---|---|---|
| F01 可发现性 | D 的 25 根命令没有公开 `account`、直接 `pi/dsh/dsh-tui`；R/P/E 实际有入口（第 4 节）。`shell doctor` 在 shell-router:191,295 存在，D:158–165 未列 | 区分公开/系统回调/内部/退役再补入口映射；不能把全部隐藏命令一律公开。shell 与主会话协调，提交前重读其快照 |
| F02 P1 候选：逃生门/账号 | `provider-resume-verb.js:49–53` 将 `<p> <账号> -- ...` 变成 `[p,...后缀]`，丢账号；P:603 在处理 `--` 前摘取 session flags，循环 P:140–168 不停止于 `--`；P:673 的 escaped 只挡 resume/fork 等个别逻辑，`<p> -- ls` 仍可命中 P:945。Go marker helper 保留账号（resume_account.go:74），但 family 在 G:109 删 marker 后继续跑 G:123–178 的管理动作；E:768 还跨 `--` 查 restart flags | 对两种账号形态统一分隔符所有权，禁止 escape 后管理动作/会话旗标劫持；真实验收前先由主会话裁定修改边界。未观察到实际串号、删除或重启 |
| F03 P1/P2 候选：动作位置 | C:447–454 在数字/accountRef 后补全部 provider 动作；P:1938–1970 仅额外处理 usage，accountRef P:1795–1838 直接启动；`<p> <账号> delete` 不等价于 `<p> delete <账号>`。C:40,442 给 `sessions` 原生 session ID，但 P:1098–1110 / `provider_sessions_list.go:46–57` 要数字账号；C:37 还给 deleteall 账号候选 | 先明确逐动作支持次序，再收窄候选或实现有意的解析，不能全局交换 token。验收需记录最后选中的账号、动作 owner、是否启动原生 CLI |
| F04 P1 候选：原生会话翻译 | E:432–450 会把非家族 `<p> <账号> resume/fork` 送 Go；`resume_account.go:309–310` 对任意显式 session 都拼 `--resume`，而 Node 策略是 agy `--conversation`、opencode `--session`、cline `--id`（`lib/runtime/provider-resume.js:93–209`），合同 `nativeBoundary.sessions.flags` 也不同。Go 无 ID 只认 `--continue`，Node gemini 为 `--resume latest`；Go fork 仅认 `--fork-session` 且直接附 rest（:303–307），与 opencode `--fork`、qoder 的 `--resume <id> --fork-session` 不一致。family Go 明拒 fork（:46），Node 策略却声明 fork（provider-resume.js:233），合同未声明该 flag | 优先集中会话策略，不把某一家旗标泛化。区分已确认翻译冲突和原生版本支持未知；kimi/kiro 显式 session 在 Go 也会被拼 `--resume`，不能据此宣称支持。按 provider/版本分别恢复/分叉真实会话验收，不能用推理成功代替身份正确 |
| F05 P1 候选：登录分派 | E:525–531 接受 `<p> login --no-browser` 并 spawn Go；`provider_login.go:31` 也接受该 flag，但 G:168 仅 `len(arguments)==2` 才进入 login。带 flag 的三个 token 绕过登录 handler，进入启动分派 | 修正在 router/参数边界而非改登录语义；需要核对最终 argv、账号注册、浏览器行为、退出码。最终运行结果未验证 |
| F06 P2 候选：edge 子动作 | D:580 为 `edge remove` 声明 `frp/nginx/caddy`，`edge-router.js:158–162` 只执行 frp；D:577 给 status 类型候选，handler:124–126 无过滤直接全量 status | 对齐声明与实际能力；不要以补全修复名义增加 nginx/caddy 删除。检查提示/退出码，不能只看 exit 0 |
| F07 P2 候选：全局历史 | D:57 把 `--history` 放在全局 ss；E:34 不接管它，Node `persistent-session-list.js:2097–2109` 拒绝未知 dash 参数。原生历史只在 provider sessions 分支 | 把全局活跃会话与 provider 原生历史分清；验证候选、帮助和错误恢复，不把全局历史当已支持 |
| F08 P2 候选：导入文案/选项 | D:442 写“目录/zip/JSON”，D:485 给 import `-j`；R:380 路由到 backup，`backup/router.js:159–173` 仅按 UTF-8 文件读入 AIH 原生格式，只摘 `--dry-run`，`-j` 会成为文件 token | 保留原生 JSON/身份合并；旧格式支持需单独确认，不凭历史 helper 的存在宣称可达，不顺便扩展导入器 |
| F09 P2 候选：`-j` 语义 | D:366 把 `-j` 描述为 JSON；P:727–740 实际 `usage -j <正整数>` 是并发 jobs | 使用动作作用域说明，不改旧 flag 的含义；JSON 支持须逐叶子确认 |
| F10 发现/支持范围冲突 | D:548–554 按 loginArgs 非空显示 login，所以 agy/codebuddy/codebuddycn 无 login 候选；E:522/983 和 G:168 有专用登录路由。family E:1026 算出 isList，但 E:1058 不含它，实际继续其他 Node/列表路径；与“固定 Go”的注释不一致 | 登录能力由真实 capability/路由确认，空原生 loginArgs 不等于无 AIH 登录。family ls 先确认实际数据源与行为再决定是否转 Go；不声称其列表必然失败 |

## 7. 未决支持与后续真实验收（不与 F 表混计）

| ID | 未证明什么 | 下一步所需证据 / 禁止的推论 |
|---|---|---|
| U01 二进制/制品 | 当前安装的 aih、aih-go 是否对应此源码；各平台是否包含它 | 主会话读取安装路径、构建标识/制品清单后再选安全 help。`scripts/package/bundle.js:255–267` 的 copyGoCore 只保留 server 并排除其他二进制，是需追查的交付线索；未审完整打包链，不能断言已发布包缺 CLI |
| U02 Go 直调 vs wrapper | G 支持的 provider action、relay、help 不一定由 E 对应形态接管；管理 key/出口策略会改变 owner | 按“公开 argv → 命中转发条件 → 最终 handler/argv → 实际账号/模式”记录。Go `list` 无根别名分支，公开 `list` 由 E/R 规范；这不是整体 CLI 不支持 list |
| U03 真实上游支持 | 原生版本的 resume/fork、登录、CLI 安装与权限、desktop/plugin/MCP/skill 能力 | 先核版本和官方 help，再按授权在真实隔离账号/会话上验收；合同 flag、注释中的历史实测、handler 存在都不是本轮运行证据 |
| U04 只读与副作用 | “list/status/doctor/help” 是否完全无写入/无网络 | 逐路径审初始化：`lib/cli/app.js:150` 有 process lease；`cmd/aih/global_sessions.go:65–67` 写会话缓存；部分列表有恢复/回收/补算。故本轮不运行这些命令，不能标成安全零副作用 |
| U05 默认与跨账号 | Node/Go 的宿主默认、gateway 默认、unset 恢复、健康回退、家族跨站、accountRef 是否一致 | 在用户授权下记录实际账号/配置前后差异和撤销步骤；严禁用真删除、默认账号切换或推理来探测路由 |
| U06 shell 与交付时效 | 主会话仍修改 shell/complete/runtime，以上行号和 F01 等可能继续变化 | 本页只交付快照；后续修复者重新读取 D/E/R/G/C/P，更新对应行状态与证据，不把源码修复自动升级为真实验收 |

后续叶子账至少补齐：原始意图来源、参数变体、实际 owner/依赖、状态机、读写/费用风险、不可破坏行为、真实验收记录（stdout/stderr/退出码/账号与会话身份）、失败恢复/回退、负责人及编辑边界。本页只提供入口映射和审查队列，不代替这些记录。

**复核方式：self_review（静态逐项对照），无独立 reviewer 或运行验收。没有执行修复，也没有扩大主会话的文件修改范围。**
