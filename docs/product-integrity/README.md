# 产品完整性优化执行账

目标：按 `docs/superpowers/plans/2026-11-14-product-integrity-optimization.md` 完成全部 M0–M5。用户已授权全部范围；本账只记录实际进展，不缩小目标，不把声明当作验收。

## 当前阶段

| 阶段 | 状态 | 证据边界 |
|---|---|---|
| M0 全功能总账 | 进行中 | 已采集入口/合同快照；还需路由交叉核对、叶子操作/初衷/归属与动态入口补齐 |
| M1 CLI TAB 样板 | 进行中 | 已真实复现并修复一批路径补全及 rc 生命周期问题；尚未完成全矩阵/Windows |
| M2 原生适配与生命周期 | 源码边界审查进行中 | runtime-protocol-map 覆盖 16 Provider/14 CLI，11 项静态差异；待真实验证，不定制官方客户端 |
| M3 账号/推理主链路 | 未完整审查 | 多处有并行会话修改；不能擅自接管或覆盖 |
| M4 管理/扩展功能 | 未完整审查 | 22 个 feature 目录只是入口线索；不能代替页面/业务验收 |
| M5 整体验收 | 未开始 | 依赖前述工作、真实跨平台/长运行/升级恢复 |

## 总账与可重采集性

执行 `go run ./cmd/route-entry-inventory > /tmp/aih-route-entry-inventory.json`，再 `node scripts/product-inventory/index.js --go-ast /tmp/aih-route-entry-inventory.json`；两者只读取代码/合同并输出 JSON，不启动服务、不读取凭据。省略 --go-ast 时显式记录覆盖缺口。三部分职责：CLI 声明采集、Web route AST 采集、合同与已有 HTTP 源码扫描器合并。

`entry-inventory-2026-11-15.json`：2,400 条证据行（CLI 949 / API 1307 / Provider 能力 96 / Web route 26 / feature 目录 22；包含已集成的 Go AST 注册候选）。11-14 初版误将同一路径的 `/studio` 分组和重定向合并为一条，现改用 AST 层级身份保留两条；旧快照仅作历史，不作覆盖分母。这是审查候选，不是已验证功能的计数。API 合同和源码证据保留各自身份，后续人工关联；不通过草率去重抹掉差异。所有条目默认 unreviewed/not_verified，生成器不覆盖人工验收记录。

未决：Node/Go CLI 路由与声明一致性；UI 内部操作、native/安装/备份/动态路由；每条用户初衷和验收证据。一个目录不能代表其中所有功能。

## 文件边界

首批可写为 inventory/docs 与 shell；后续已按重查工作树边界扩展到 native-escape/session-control、Provider session合同/Node-Go消费者、pipe生命周期及Server凭据组合。具体路径与证据分别记在 native-cli-findings、session-contract、credential-composition；不得将这些allowlist泛化为其他peer文件。

启动时已有几十个脏路径（账号/模型认证、Go 网关/WebUI、CLI effort 等）属于并行工作；已重新检查 staged 为空、仅 main 工作区。不 stage/commit/push，不创建分支，不 reset/revert。

## 裁定

- 用户已批准完整计划，继续所有阶段，不再逐阶段要求“是否继续”；破坏性或安全敏感操作仍单独授权。
- AGENTS 明确禁止新增测试用例，因此用实际 shell/CLI/filesystem 操作与证据记录，不新增测试文件；语法检查只算静态证据。
- 不修改当前用户真实 rc/profile；安装卸载全部使用隔离 HOME/AIH_HOST_HOME/AIH_HOME_DIR 和临时 rc。
- 旧版 snippet 曾被多个自定义 rc 共享，无法证明无人引用就不删除；升级后按 rc 路径确定独立 artifact，卸载只删自身 artifact。遗留共享文件显式返回 retainedSharedSnippet。
- 使用计划执行 skill 的独立 reviewer 做只读审查；不授权其改共享文件/建分支/提交。
- 保留计划“无部署”的边界：源码可用与当前宿主已应用是两回事，最终需单独确认真实用户 shell 集成升级。

## 2026-11-15 继续进展

- CLI 映射：`cli-contract-map.md` 已定位 25 根命令/6 别名/14 CLI provider，10 项源码差异、6 未决；不等于真实路由验收。
- Web 映射：`web-feature-map.md` 覆盖 26 路由记录、22 feature 目录、258 操作映射，2 个预览导入/导出合同冲突；未做页面/业务验收。
- M1 已追加 feature 选项保存/显式恢复、真实 doctor 语法检查、旧版路径引用升级、无尾换行往返保留、CLI 参数缺值保护。
- 独立 review 的 EOF 拼接/Bash 引号注入/inline 账号与 config 值位问题已逐项修复并补真实验证，见 findings；review 已对这四个报告项定点关闭，不代表 M1 完成。
- 历史读取改为最近行数+字节上限；真实 34.8 MB 隔离 history 中候选相同，单次 RSS 270 MB → 55 MB，后续 30 次 warm p95 42.09ms；不是冷启动或 UI 全链路。
- 并行迁移会话文档见 `docs/migration/2026-11-14-node-go-execution-ledger.md`，其 W0–W6、源码和提交不冒充本计划完成。当时不接管其在途账号、server生命周期和协议文件；后续已提交且干净的凭据组合根另开局部工作包，详见后文，不覆盖peer修改。

## 待集成的跨线发现（不擅改并行代码）

CLI map F02–F05 涉及 Node/Go 原生 `--`、账号位置、resume/fork、login --no-browser。相关文件正由迁移/运行时会话维护；后续先核对新 HEAD 的修复状态，再按 provider/真实原生实例验收，不能用静态差异冒充现存事故。Web preview 导入/导出有两处高置信度合同冲突，需恢复其原始迁移意图后修，不把已退役格式重新引入正式路径。

- `runtime-protocol-map.md` 已交付 16 Provider / 14 CLI 的 canonical/native 映射与 11 项静态风险；与迁移会话新增的 Go runtime 实现交叉阅读，但不冒充已完成实际业务验收。

- 主会话实际运行已提交的 `cmd/route-entry-inventory` 并接入总账（847条、8个unknown），没有复制第二套Go parser；最终组合仍保留11个覆盖/解析未决项。数目增长代表发现路径更完整，不代表已实现功能增长。
- 当前运行态回归：2026-11-15 `/readyz` 200 ready=true；标准模型 gpt-6.1-sol 梯度存在，Codex客户端投影为空。磁盘server SHA与run identity一致，但dirty投影源码仍正确；待查构建来源/进程缓存，不自动重启并行共享服务。

### 本批证据快照

当前实现已形成 SH-001 至 SH-017 复现/修复记录，并修正 fish 历史顺序。阶段仍在进行中；Windows/PowerShell 运行环境与 Edge 支持连接不齐，M2/M3 原生与账号真实业务、M4/M5 全域及长运行仍未验收。没有写测试用例，没有替换官方客户端，没有修改宿主 shell 配置，没有提交推送部署。CLI 源码变化只在新生成片段上生效，宿主需后续受控 apply。

### 运行态与工作会话边界

本轮创建的5个真实shell PTY已发送 Ctrl-C/exit 并确认终止；不留下后台验证进程。只结束自身工具会话，不按进程名批量终止。临时证据目录保留，不删除用户/并行文件。末次 git diff --cached --stat 为空，全仓 diff --check 通过。未提交实现，避免夹带并行共享索引。

后续安全可推进项：补齐账号生命周期/插件/远端/安装子账；复现CLI合同map中可安全执行的read-only形态；PowerShell解释器下载两次官方GitHub连接超时，未安装/改环境；等待可用平台而不把它作为所有工作停顿理由。仍有大量源码/本机可验证路径可继续，所以目标保持 active，不标 blocked。

## 后续批次（2026-11-15）

- 账号源码审查已交付 `account-lifecycle-map.md`：16 Provider、30叶子、9项静态缺口。涉及refresh singleflight跨实例/后处理、导入导出和删除宿主同步；不据源码结论直接运行收费或修改真实凭据。
- Node原生逃生门已真实修复并验官方Codex只读帮助/参数错误，见 `native-cli-findings-2026-11-15.md`；Go与bin前门仍有单独边界缺口，不能标全provider通过。

### 当前批次事实（2026-11-15 01时）

- Node原生逃生门修复通过官方CLI帮助/错误验证；Go补齐marker前模式识别与login带参数分派，临时构建隔离验证；bin家族restart不再扫描原生后缀。
- 会话resume/fork形态统一进入既有Go Provider合同，Node/Go消费模板并校验声明，不复制字符串策略；64形态投影一致，29次官方帮助通过，其余明确拒绝或未实机。既有会话恢复/分叉的对话连续性仍待验收。
- 源码模型梯度修复已在临时端口真实Server验证，公共实例仍需受控构建发布，未擅自替换共享构件。
- 管道提前关闭触发EPIPE已实测复现与修复，head帮助退出141且无栈，完整帮助exit0；长流/取消/认证收尾还需继续。

### M3凭据装配局部修复

Server inference现在注入既有管理Resolver，singleflight/suppression/re-key/刷新后投影callback属于同一实例；独立嵌入runtime的fallback仍保留。只改3个组合文件、不修改刷新策略。实际临时编译Server/空HOME/端口0：health200、ready200但false、模型空列表、SIGTERM exit0；证明装配可启动，不证明OAuth轮换或所有业务完成。独立审查已定点通过；并补了re-key的旧候选失效边界，但实际OAuth/re-key仍未验证，跨进程协调不在此修复的保证内。证据：shared-credentials-composition-2026-11-15.json。

总账重采集后条目数会随修复声明/新入口变化，旧记录不作为验收分母；功能删减未作为优化手段，仅去掉了指向错误参数/不支持操作的补全建议。

凭据复用/re-key边界与明确未证项见 `credential-composition-2026-11-15.md`；Node/Go session合同与pipe生命周期见 `session-contract-2026-11-15.md`。这些都是局部检查点，M0–M5目标未缩小或标完成。

### 验收状态不能混同

此批仅到局部源码+本机官方help+隔离Server组成闭环。实际账号pin/长会话resume-fork/OAuth轮换、Windows/Linux、Edge视觉与所有扩展域仍缺实证；没有把模板一致或ready健康替代业务成功。共享main持续推进并带peer未提交修改，暂存区复核为空，自己的变更未提交/推送/部署。下一继续点是剩余功能域子账与逐项安全复现，不宣称“一次性全部完成”。

本批新增变更摘要：原生逃生门/parser适配器、共享session命令合同、pipe生命周期、Server resolver复用及re-key边界；各有独立只读review和可执行范围内的真实证据。尚未写入当前用户shell/替换共享CLI或Server构件，因而工作区能力与运行中旧产物不能混称。

账号导出/导入 G04/G09 的业务修改尚未开始：需要同一事务保留disabled与完整原生身份artifact，不能用导入后补一次disable制造短暂启用窗口，也不能伪造OAuth身份通过验收。下一批继续沿真实格式/隔离账本推进，不把静态问题直接记为已修复。

静态总账补齐仍在推进：扩展/远端/安装后端子账由独立受限写集worker输出。长任务不以“工具还在跑”代替验证，后续读取该agent状态与产物再集成。

实际临时Server与原生help子进程已退出，未保留本批验证服务；OAuth/disabled import仍未执行真实账号写入。全仓diff检查通过、staged为空。未将审查发现、临时构件与公共运行态混为同一交付。

### M3导入停用意图

G09已真实复现并修复、独立定点源码审查通过：初始down进入同一注册事务，新账号从首次SQL/路由发布就是停用；重复导入不覆盖现有启停。真实隔离Server/SQLite四状态及重启保留通过，原始证据与范围见 import-initial-state。OAuth与其他导出格式未因此被宣称完成。

### M4扩展/安装

`extension-remote-install-map.md`已完成38条后端/OS映射、11项静态发现，运行态未验证。G07/G08已由主会话实际临时目录复现：遗漏Go CLI、无归属卸载误删；当前修复/边界见package-install-findings，POSIX真实安全路径与旧安装保留升级通过，Windows仅源码/编码证据，整包release尚未构建。

隔离验证保护复核：符号链接安装目标的uninstall直接拒绝，外部sentinel及链接均保留；未知目录的legacy迁移必须显式preserve-existing且保留旧目录。未在真实安装位置运行。PKG四项审查问题已定点源码复核关闭，不据POSIX几条路径宣称全安装链安全。

最新确定完成的局部真实路径：disabled bundle首次导入/相反状态重复导入/重启不翻转；原生CLI帮助与marker参数分界；POSIX有归属安装/再安装/保留legacy升级/卸载、外来链接/目录保护（含空格单引号路径）。仍未整体完成的项均留在各子账，未执行production deploy、账号认证轮换或费用请求。

扩展子账的SFTP覆写/备份一致性/远端路径边界仍待独立真实传输验证：本机存在sftp-server二进制，但发现的sshd属于其他会话，未使用/改动其配置或密钥。不会拿模拟协议或删除目标文件的重试当作修复闭环。

收尾核验保持边界：Go CLI / Server临时构件编译通过；契约生成check通过；本批改动JS语法和全仓diff whitespace检查通过，staged为空。账户初始停用/原生帮助/短管道/安装器临时目录仅按各自证据范围计完成。其他协议/视觉/跨平台/授权配置变更未自动执行，目标保持active。

最近检查点：原生逃生门/共享session合同/pipe生命周期、Resolver复用与有界re-key、初始停用导入、必需Go组件打包与安装归属保护均有独立定点审查和相应本机证据。各项未证矩阵保持开放，未关闭总目标。SFTP数据保护仍停在已确认源码机制/本地原生sftp-server可用性，下一批按实际协议验证后实施。

SFTP新增真实证据：直接连接本机原生sftp-server（无需SSH密钥）普通rename覆盖返回4，posix-rename扩展成功；原生进程拒绝rename时，旧backup的“rename失败→unlink目标→rename”算法实操导致旧文件丢失。这是协议原语/旧算法复现，非完整backup认证链；未更改其他会话sshd，待实施安全替换器。

### SFTP当前数据保护检查点

旧backup rename失败后删目标的算法已用真实OpenSSH拒绝请求复现丢文件。当前共享适配器优先posix-rename、只在明确不支持时尝试v3 rename，错误不删目标；产品workspace路径真实成功/拒绝两支通过，Go仅编译。无原子扩展服务器的完整覆写兼容仍待恢复策略，不将此安全拦截替代完整目标。见sftp-replacement报告。

SFTP主路径追加独占临时写（wx）并把初次write放入cleanup范围；真实OpenSSH重查最终只剩target、内容LATEST。临时进程均退出。Windows无扩展替换与Go真实SSH仍列未验收，不用编译结果代替。

## 恢复执行（2026-11-15 下午）

用户通知16MiB入站和schema31单库切换已由恢复会话完成；本会话不重复合库/回退/重启网关。原Goal仍是全M0–M5。本次从SFTP lifecycle断点继续，仅读git/worktree核对，使用早前本会话创建的loopback OpenSSH服务和临时密钥；没有连接/改其他会话的sshd或Colima服务。

## 2026-11-15 本轮真实闭环与剩余边界

- 用户追加的窄终端 `aih ls` 已纳入原 M0–M5（不是替代 Goal）。Go 共享 terminalui 修复 raw-mode 换行、显示列宽、ANSI/字素折行及 resize 物理行失效；80/60 列、宽→窄→宽、中文/长账号/长模型、筛选清空、退出码、轮播及静态输出均有真实 PTY 记录。源码 checkpoint `404373c46`，标准入口证据 `e1116d3af`。只原子重建 CLI aih-go，未更新/重启共享 server。见 `ls-terminal-2026-11-15.md`。
- SFTP 原断点的 Go SSH lifecycle/v3 fallback 实测已在 `sftp-go-lifecycle-2026-11-15.json`；旧初版“Go只编译”不是当前结论，sftp-replacement 文档已补时间边界。Lorentz 关闭 unknown applied 省略语义的源码审查。非原子恢复不等于任意外部 writer CAS。
- Node remote-tools 直连 MCP→隔离配置→真实连接池→自有 OpenSSH 已验收 required string version、new-only、过期版本与 edit。Go 先前实测保留，未重复宣称为新验证。HTTP forwarding 仍只有源码门禁证据。
- 新发现并真实复现 Go 超过 512 KiB 文件的静默截断版本导致 edit 丢尾：修复后超限明确 file_too_large，524,317/524,289 字节保持原样，524,288 字节仍可编辑，小文件链路回归通过。源码/临时构件已验收，**未部署共享 server**。详见 `remote-tools-version-2026-11-15.md` 与 large-file JSON。
- 未关闭：G03 外部 writer 原子 CAS、G04 symlink/root containment、G06 manifest/restore 一致性、真实 OAuth/re-key、Windows运行矩阵、真实管理页面/Edge、全功能叶子复核和M5长运行。原Goal保持active；局部修复不代表全部完成。

### G04 继续：远端真实路径边界（2026-11-15）

Go/Node 在自有隔离 OpenSSH 真实复现外链读写越出 workspace；已用共享脚本合同和 remotepath adapter 接入 Go tools、Go WebUI 文件读及 Node exec/SFTP。外链拒绝，内部/root link保留，root绑定贯穿edit和retry，literal/空白路径/SFTP代次实际验证，证据见 `remote-path-2026-11-15.md`。这是 observed-path containment，不是原子sandbox；Windows实际运行、TOCTOU、全目录/搜索特殊名称显示与WAN性能仍开放。未重启/更新共享服务，原Goal不缩减。

### G06 首个保护检查点：恢复前完整校验

真实策略/SSH复现“旧manifest不变但对象已被新内容覆盖”以及“对象换accountRef仍dry-run成功”。已给现有v1 restore增加原始bytes/UTF8/单账号schema/provider/ref/record hash全批预检；missing/corrupt不调用importer，CLI逐ref显示原因，importer invalid/failed不再报总成功。见 `backup-restore-integrity-2026-11-15.md/json`。对象不可变与v2命名空间发布、skipped/tombstone、多writer、旧版互读仍待继续，不能把拒绝损坏恢复算作完整备份一致性完成。

### G06 v2 不可变对象与发布/恢复协议

Go scheduler 与 Node CLI 已接独立v2仓库：实际字节摘要寻址、no-overwrite对象发布、共享JCS格式/上限、固定连接代次的整轮协作锁、不可变manifest snapshot与发布intent、显式可续接恢复。真实Go/Node互写、对象上传后中断保留旧快照、skipped/墓碑、v3-only与manifest缺席间隙恢复、并发恢复、旧格式迁移及full重传校验已有记录，见 `backup-v2-2026-11-15.md`。共享服务未部署；Windows真机、断电持久性、WAN性能/增长、源数值精度及非协作writer仍开放，不宣称M0–M5完成。
