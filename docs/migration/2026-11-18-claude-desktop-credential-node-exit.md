# Claude Desktop credential helper：Go 工程检查点

状态：`GO_HELPER_CHECKPOINT`。工具箱的新配置和有 ownership receipt 的既有配置完成 Go helper 闭环；无 receipt 的旧 Node 配置仍被安全拒绝。本检查点不代表全部 Desktop 已安装用户升级完成，也不授权发布。

批准：`pm-d680f0a7dd40c322599fa4fc9115e3e4`，原线程 `01a1e527-e164-73c0-9229-f3a4c6d953a1` 已用 `aih peer read` 读取；不是把 native 队列 pending 当执行。后续范围裁定 `pm-b4fcce720bebd38080eb4c60bc8b2460` 已读取，明确先完成原五生产路径，不扩大到 preparer。

## 实现范围

仅五个生产路径及本证据文档：

- `cmd/aih/run.go`：注册私有 `__claude-desktop-credential` 命令，先于 provider/server composition 分发。
- `cmd/aih/claude_desktop_credential.go`：严格 `--ai-home-dir <absolute>` 参数、10 秒取消边界和唯一 stdout JSON；错误非零且 stdout 空。
- `internal/runtime/claudedesktopcredential/resolve.go`：仅读 canonical `aih.db` 的 `app_kv/config:server.apiKey`；使用 `appstate.ReadKV` 的 `mode=ro`、`query_only`、`businessdb.CheckReady`，不创建或迁移数据库，不读旧 JSON，不用 management key、环境密钥或默认值。
- `internal/runtime/claudedesktopcredential/command.go`：只读检查 Go buildinfo 的 cmd/aih program path、宿主 OS/arch、执行权限和私有命令标记；按当前 CLI、同目录、包布局、PATH 选取 native helper，不执行候选探测。显式无效 helper 不回落。
- `internal/runtime/toolkit/apps/open.go`：配置 native helper 和私有命令参数，继续调用原 `claudedesktopconfig.Prepare`。

`claudedesktopconfig/{prepare,plan,publication,types}.go` 与 `configsnapshot/lock.go` 的 SHA256 均与工作前一致。锁、ownership receipts、请求签名、前后像、版本保留、journal 和恢复规则未改。没有修改测试、分支、worktree、HUD、Chat、protocol、terminal 或安装逻辑。

## 真实构件与命令

生产构建均 exit 0：

```sh
go build -trimpath -o <evidence-root>/artifacts/aih-go ./cmd/aih
go build -trimpath -o <evidence-root>/artifacts/aih-server ./cmd/aih-server
```

Go CLI SHA256：`b53d1ee712f91e76910cbeeb69b7e61be94f087c4181c3e25f69a254a89e2fc2`。

Go Server SHA256：`b84af713be62e248f0299ccbfea2bcfa4604512801cabdfc1287fc78d8f1d27f`。只构建，未运行、安装或替换共享服务。

证据根：`/Users/model/.ai_home/run/claude-desktop-credential-20261118-01a1e527`。`artifacts/desktop-prepare` 是仓库外的临时命令驱动，只调用真实生产 `apps.PrepareClaudeDesktopGateway`；没有模拟配置事务，也没有新增仓库测试文件。

对真实业务数据库以 SQLite `mode=ro + query_only=ON + backup` 建立私有一致副本，保留 `app-state.db` 的 cutover seal 供原 gate 验证。副本位于 private HOME、目录 0700、数据库 0600。源码数据库未写入；全部缺密钥与坏数据变体仅改变自有 APFS 副本。stdout 捕获只在内存比较，仅保存键名/匹配布尔，从未记录 token 或 management key 正文。

实际 helper 调用：

```text
<artifact>/aih-go __claude-desktop-credential --ai-home-dir <private-HOME>/.ai_home
```

成功 stdout 合同为一行 `{"token":"<redacted>"}` 加换行；stderr 空；token 与 canonical 副本一致。PATH 为空且设置环境假密钥，确认不取环境值。`__claude-desktop-config` 通过 stdin 使用原配置事务，实际返回 `api_configured`；生成 entry 的 helper 正是该 Go 构件与上述 args，随后按生成配置执行成功。

## 已完成的真实验证

- 新建私有 profile：真实 toolkit Prepare 成功。再次 Prepare，以及实际 `aih-go __claude-desktop-config` 均 no-op；配置字节、inode、mtime 保持不变。
- 有 receipt 的旧 Node helper profile：使用原 Go 配置命令创建实际旧配置，再由真实 toolkit 切为 Go；产生新 entry ID，旧 entry 字节完整保留。旧 Node helper 没有执行。
- 无 receipt 的旧 Node profile：原事务返回 `desktop_entry_ownership_conflict`，所有已存在配置字节保持不变，未伪建 receipt、未预调用 Node 写配置。
- 19 个真实失败变体全部非零、stdout 空：缺/空/null/非字符串密钥、控制字符、仅 management key、数组、坏 JSON、重复键、尾随 JSON、超长文档、缺记录、缺数据库、相对 scope、缺/错误/多余参数、未完成迁移、损坏数据库。
- 原生定位：新 CLI 接受，旧 CLI、server、Node、脚本包装器、缺失显式路径拒绝；无效显式 helper 在创建 profile 前失败。
- helper 自身在 macOS sandbox `deny network*`、`deny process-fork`、`deny file-write*` 下读取稳定真实副本成功；resolver 同样不启动 probe child。
- 另以普通父进程子调用执行生成 helper 命令，网络禁用、PATH 为空，合同成功。这是正常 helper child 调用，不能冒称真实 Desktop 或父进程 no-fork。

证据：`real-ro-snapshot.json`、`os-readonly-nofork.json`、`failure-commands.json`、`generated-config-commands.json`、`generated-helper-child.json`、`native-helper-resolution.json`、`legacy-profile-boundary.json`、`current-source-artifacts.json`，均在 `evidence/`。

验收驱动限制如实分列：私有 SQL 修改需保留原 `updated_at NOT NULL`；修改后需关闭/checkpoint writer。失败变体允许 SQLite 初始化 WAL shared-memory sidecars，数据库仍 `mode=ro/query_only`。禁止所有文件写入的严格成功证据单独来自稳定副本，没有为验收放宽生产只读代码。Go 编译器会把纯字符串比较优化为分块，初版静态命令标记不可见；参数错误输出引用完整私有命令后已重新构建并验收，不依赖启动探测。

## 独立 review 与未完成边界

独立 reviewer `01a1eae6-b648-7243-be77-cca6f2005f03` 发现一项 P2：无 receipt 的旧 Node profile 无法由现有严格 legacy matcher 接管。已实证并向监督报告；监督 `pm-b4fcce72` 接受它作为此五路径工程检查点的显式未完成边界，禁止宣称旧安装升级完成或发布。最终独立复核未发现此批准范围内新增 P1/P2 阻断，当前 source/artifact SHA 匹配；回执为 `evidence/independent-review.json`。

以下仍未迁出本 scope：

- `lib/cli/services/ai-cli/claude-desktop-inference.js` 的旧 Node adapter/helper 配置。
- `internal/transport/http/webuiopenappapi/desktop_providers.go` 的旧独立配置 writer（仍写 Node helper）。

真实 Claude Desktop GUI、真实账户登录/模型发现/推理、现有正式 profile 切换、跨平台运行均未验。macOS 候选构件与私有目录实跑不能替代这些证据。没有启动 GUI、修改真实用户配置/凭据、共享重启、正式安装或发布。

## 下一最小 scope 的只读建议（未实施）

历史 `ff93cfa48^` 的 `lib/cli/services/ai-cli/claude-desktop-inference.js` 与旧 toolkit 生成器都产生以下完整 API entry：固定 `inferenceProvider=gateway`、`inferenceCredentialKind=helper-script`、`inferenceGatewayAuthScheme=bearer`、`modelDiscoveryEnabled=true`，配绝对 Node executable、绝对包内 `bin/claude-desktop-credential.js` 和 `--ai-home-dir <同一AIH根>`。旧形态共有七键，不接受多余字段；未使用 args 的直接 shebang 形态不纳入本最小建议。

后续建议在 `claudedesktopconfig/plan.go` 的 `knownLegacy` 中扩展一个严格旧形态判定：仅 mode=api、desired args 正好为新私有命令及绝对 AIH 根时适用；旧 args 恰好三个元素，第二项是 `--ai-home-dir`，第三项经规范化绑定同一 AIH 根；脚本必须是解析后的已知包内脚本，旧 helper 必须是规范化绝对 node/node.exe 原生路径；固定字段和 URL 全量校验。随后仍由原 buildPlan 在锁内完成 receipt 与新版本写入，不在 helper/resolver 中伪建 receipt。

可验证证据应是：canonical profile 位置与 AIH 根绑定、已知发行包脚本路径/来源、完整 legacy entry 精确内容。显示名或上述字段本身不是不可伪造的所有权凭据；若来源不明确，只能继续拒绝，不能凭文件名给任意 profile 背书。要把“已知包内脚本来源”传到 preparer，可能还需额外可信 Options 字段或复用包定位证据，必须先由监督确认具体 hunk 与写集。当前不修改 `plan.go`/`types.go`，也不降低已有安全门。

## 暂存区、源码及私有副本

共享原 35 项 staged binary diff SHA256 在检查点前保持 `7402eec47cc99a9c5b3a1160454fbe7b0c4ad989bdfb873248621d35303b51be`。只以本人显式 pathspec 提交；提交前后另核实际 stat/内容。

敏感私有根 realpath：`/Users/model/.ai_home/run/claude-desktop-credential-20261118-01a1e527/private`。受控命令已终态，尚未删除；需要原监督针对该确切路径另行批准 cleanup，不套用其他会话清理授权。证据和构件在并列目录保留。
