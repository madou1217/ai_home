# M0 / M3：账号全生命周期源码审计图

## 1. 交付边界与证据等级

本页是已批准 [product-integrity M0–M5 计划](../superpowers/plans/2026-11-14-product-integrity-optimization.md#L122) 的 **M0 账号域补充账**，不是 M3 验收报告，也不表示全计划完成。范围是导入、登录作业、身份登记/去重、默认与绑定、凭据来源/投影、续期并发、启停/删除、额度与模型刷新。

- **唯一可写路径**：`docs/product-integrity/account-lifecycle-map.md`；初查不存在，使用排他创建，未覆盖既有文档。
- **实际动作**：读取仓库源码、计划、Git 状态/差异元数据，计算源码 SHA-256，复核本页链接与范围。
- **没有做**：新增或运行测试、构建/执行应用模块、启动 CLI/浏览器、访问 HTTP/上游、推理、配置修改、数据库/凭据/日志读取、分支/worktree 创建、Git 暂存/提交/推送/改写历史。源码内的 DB/凭据路径仅用于说明合同，没有打开对应运行文件。
- **证据 S**：可由指定源码分支、调用点或装配直接确认；**证据 U**：真实运行、故障概率、部署采用情况尚未验证。所有下述业务旅程目前只有 S/U，不得登记为“真实通过”。源码注释里的历史事故也不是本次运行证据。
- **评审意图**：本次没有调用 reviewer subagent/native review；使用明确的 `self_review → plan_check`，逐项反查装配与反例。无实施、发布或高风险操作需要 bypass。
- **避免重复**：执行器接收选定身份、canonical/native 协议交接见 [runtime-protocol-map](runtime-protocol-map.md)；命令/help/补全和默认账号命令入口见 [cli-contract-map](cli-contract-map.md)；页面总账见 [web-feature-map](web-feature-map.md)。本页不重画这些地图。

### 1.1 源码快照与并行归属

| 项目 | 本次记录 |
|---|---|
| 初查时间 | 2026-11-15 00:55:46 +08:00（Asia/Shanghai） |
| 初查 HEAD | `4595baa21895a80c16da4c57955657711d531ed4` |
| 内存源码基线 | 2026-11-15 00:56:53 +08:00；5,110 个受选源码/文档文件的路径与 SHA-256，只保存在本次工具进程内 |
| 文档落笔时间 / HEAD | `2026-11-15T01:07:16+08:00` / `57eb265dfe6689f9b3a5ce13ab8524ee298f315b` |
| 期间共享 HEAD 推进 | 观察到 `5bab26a0a`（WebUI terminal capabilities）和 `57eb265df`（CLI lifecycle 文档）；均非本次提交，不撤回、不吸收为本次产物 |
| 索引 | 初查 `git diff --cached --stat` 为空；结束再核对。空索引不等于工作区干净 |
| 哈希含义 | §9 为当前工作树源码指纹，不以 HEAD 代替 dirty 内容；哈希数量不是已审计叶子数，也不是运行版本证明 |

| 边界 | 当前归属 / 冲突处置 |
|---|---|
| 本文 | 本次唯一文档写入；不改 README、计划、inventory JSON 或其它地图 |
| 账号业务核心 | `application/accountauth`、`accountcredentials`、`accounts`、相关 `internal/adapters/account*`、Node 账号模块和 facade 是只读证据；检查时无这些路径的已跟踪 dirty 差异。**这不授予后续实现所有权** |
| 入口/鉴权 peer 工作 | `internal/transport/http/frontdoorapi/handler.go`、`webuimanagementapi/handler.go`、`webuiauth/{gate,require}.go`、`webuicontrolplaneapi/{endpoints,handler}.go`、bootstrap、publicalias、account-rules/upstream-mapping handlers 有既有改动；control-plane cache/remote-proxy 等有未跟踪文件。实际页面可达性受这条工作线影响，不能拿本文替 peer 验收 |
| 原生/CLI peer 工作 | `cmd/aih/run.go`、`go.mod`、Codex gateway 新文件、模型投影、shell-router/completion/shell snippets 等存在既有改动；open-app CLI 文件期间被 peer 提交。只读观察，不调整、暂存或回退 |
| 文档 peer 工作 | 计划与其它 product-integrity 地图/证据文件初查未跟踪；同目录不代表归本次所有 |
| 合并/实施门槛 | 未识别具体 peer 会话所有者，记为“共享 peer，待协调”，不猜测姓名/归属。修复之前需重新看状态、文件哈希、装配 owner；尤其 composition、两库同步和公共 WebUI 边界不得抢改 |

## 2. 恢复的初衷与不可破坏合同

“原始意图”来自已存在的计划、领域合同和明确设计注释；不是将当前实现缺口反过来合理化。历史 AGY 身份修复线索仅用于定位，下面结论均重新落到当前源码。

| ID | 原意 / 不变量 | 当前可追溯来源 |
|---|---|---|
| I-01 | 用户账号身份不能等同于 CLI 数字别名、邮箱展示名、token 或当前凭据指纹。相同稳定身份去重，不能用一个临时编号补造身份 | [reference.go](../../core/accounts/reference.go#L29)、[registrar.go](../../application/accounts/registrar.go#L31)、[account-identity.js](../../lib/account/account-identity.js#L100) |
| I-02 | OAuth 完成必须是“换码 → 可验证身份/凭据 → 账号提交”，不是收到 token 就宣布成功；重复回调不得重复交换/登记，重登必须匹配目标 | [accountauth/service.go](../../application/accountauth/service.go#L477)、[reauthentication.go](../../application/accounts/reauthentication.go#L40)、[native-auth-projection.js](../../lib/account/native-auth-projection.js#L550) |
| I-03 | 一个账号的凭据只有明确的代次胜者；过期续期、401 恢复、模型/额度探测不能覆盖新凭据或消费同一轮换令牌多次 | [W4 原计划](../superpowers/plans/2026-11-14-node-go-next-development-plan.md#L136)、[resolver 依赖合同](../../application/accountcredentials/resolver.go#L89)、[credential_snapshot.go](../../application/accounts/credential_snapshot.go#L83) |
| I-04 | 静态 key / base URL 轮换保留已登记 AccountRef；传递 `CredentialBinding`，不能从新 key 重新推导业务主键；真正稳定身份变化走显式 re-key | [credential.go](../../application/accounts/credential.go#L32)、[static_credential_rotation.go](../../application/accounts/static_credential_rotation.go#L205)、[rekey.go](../../application/accounts/rekey.go) |
| I-05 | 账本、原生客户端可变凭据与运行投影各有 owner；保留原生登录/升级与宿主配置，不拿陈旧投影覆盖较新原生凭据，不跨账号/realm 搬 token | [provider-storage-policy.js](../../lib/runtime/provider-storage-policy.js)、[native-auth-projection.js](../../lib/account/native-auth-projection.js#L338)、[codebuddy_policy.go](../../internal/adapters/accounts/nativeaccount/codebuddy_policy.go) |
| I-06 | 用户停用 ≠ auth-invalid / quota-block / cooldown；删除不可被自动宿主扫描复活。清理只能针对目标账号，默认与宿主授权失败必须可观察 | [management.go](../../application/accounts/management.go#L190)、[deletion.go](../../application/accounts/deletion.go#L273)、[registration tombstone guard](../../lib/account/account-registration.js#L110) |
| I-07 | 模型/额度保留 last-known-good；上游失败不是“没有模型/没有额度”。凭据代次失配不能写回旧探测事实，人工模型策略不能被自动发现抹掉 | [model_management.go](../../application/accounts/model_management.go#L267)、[model_auth_recovery.go](../../application/accounts/model_auth_recovery.go)、[accountusage/service.go](../../application/accountusage/service.go#L332) |
| I-08 | 默认关系写入、宿主落点和运行时生效不是一个原子动作；没有宿主写入能力不能先宣称切换/回收全成功 | [W3 原计划](../superpowers/plans/2026-11-14-node-go-next-development-plan.md#L127)、[deletionhost/service.go](../../internal/adapters/deletionhost/service.go#L146)、[webuisetdefaultapi](../../internal/transport/http/webuisetdefaultapi/handler.go) |
| I-09 | 认证/导入可以含敏感输入，公开账号/Job DTO 不可回显 token、授权码、PKCE。授权 URL/设备码是有意交付的临时授权信息，不应笼统称所有 Job 字段“无授权信息” | [accountauth/model.go](../../application/accountauth/model.go)、[job_store.go](../../application/accountauth/job_store.go)、[native import errors](../../internal/transport/http/accountsapi/native_import.go#L145) |

## 3. 账本、身份与投影：当前不是单库单写入者

```text
Web 正式服务 / CLI/native import / host observation
  ├─ Go management 或 WebUI adapter → AccountImporter / Registrar / Reauthenticator
  │    → nativeaccount Decoder + core/accounts identity
  │    → sqliteaccount (aih.db: accounts + credentials + profiles + defaults)
  │    → lifecycle decorators → model/usage queues → version-checked snapshots
  └─ Node native/CLI/plugin auth → native-auth-projection + account-registration
       → app-state.db (account_refs + cli_account_aliases + credentials/env/nativeAuth)
       ↔ go-account-sync (ref links + translation + generation arbitration)
       ↔ Go ledger

ledger / versioned native live store → disposable account auth projection
                                   → explicit host-default / native credential projection
```

源码依据：[Go register transaction](../../internal/adapters/accounts/sqliteaccount/registration_store.go#L17)、[Node DB name](../../lib/server/app-state-store.js#L7)、[Node credential schema](../../lib/server/account-credential-store.js#L13)、[sync mediator](../../lib/server/go-account-sync.js#L3)。本图不是“这台机器已经同时运行两库同步”的声明。

### 3.1 身份、绑定和默认的四个不同对象

1. `AccountRef`：`unique:<identitySeed>` 的稳定公开哈希引用；`CLIAccountID` 是 Provider 内别名。Go `RegisterNew` 在事务内分配别名、写账号/凭据/可选资料；Node `registerAccountIdentity` 支持旧种子规则命中既有 ref、显式别名冲突检查、墓碑语义。二者不能靠数字 ID 对账。
2. `CredentialRef` / `CredentialSnapshot.UpdatedAt`：当前凭据查重与 CAS 版本；`CredentialBinding` 显式绑定 AccountRef + Provider + 当前凭据。静态轮换后 ref 保持不变，binding 不要求从新密钥重新派生同一个 ref。
3. Node↔Go ref links：由 [go-account-sync](../../lib/server/go-account-sync.js#L772) 和 [accountrefmap](../../internal/adapters/accountrefmap/links.go) 维护。Go/Node 使用相同 ref 外形不意味着同值；旧身份兼容、ZCode 区域与静态 URL 变化都不能靠字符串猜测。缺映射时 resolver 的 identity fallback 是行为，不是已证明两侧同账号。
4. 默认：Go `account_defaults` 校验 Provider、enabled、credential；Node 有 `account:default:<provider>` 与独立的 `provider:default:<provider>`（AIH Server profile）。宿主 auth/config 投影是后续 I/O；清空默认不等于删除凭据，停用不等于自动选择替代默认。来源：[provider_defaults.go](../../application/accounts/provider_defaults.go)、[SQLite default store](../../internal/adapters/accounts/sqliteaccount/provider_default_store.go)、[Node default store](../../lib/account/default-account-store.js)。默认后的执行身份交接只链接 runtime/CLI map。

### 3.2 凭据来源和写回仲裁

| 来源 | 代码内数据合同与 owner | 不可混淆的边界 |
|---|---|---|
| 显式静态输入 | [WebUI `HandleStaticAccount/buildStaticCredential`](../../internal/transport/http/webuiaccountauthapi/handler.go#L313)；Codex/Claude 强类型，其它允许的静态模式走 `StaticAPIKeyAuth`，Gemini 另有 Vertex | WebUI 的广泛支持不等于通用 management POST / bundle import 同覆盖，见 G-05 |
| 显式原生导入 | [native_import.go](../../internal/transport/http/accountsapi/native_import.go#L98) → Decoder；Codex `auth_json`，Claude `credentials_json + global_config_json`，其余 `native_auth_json` | 只接收规定 envelope，重复/额外字段拒绝；不能把 envelope 当可互换别名 |
| 宿主登录态 / plugin / CLI | [auth-sources.js](../../lib/account/auth-sources.js)、[host-auth-import.js](../../lib/account/host-auth-import.js)、[host-auth-scan.js](../../lib/account/host-auth-scan.js)、[nativeartifact reader](../../internal/adapters/accounts/nativeartifact)；Provider 凭据注册表决定原生槽位和身份 | 自动观察须尊重删除墓碑；显式用户导入另有恢复意图。宿主扫描不是从进程通用 env 随意收集 key |
| Node 账号库 | `env_json` 与 `native_auth_json` 分开及各自更新时间；`compareAndSwapAccountNativeAuth` 同时比较旧 JSON 与版本 | `writeAccountNativeAuth/upsertCredentialPart` 也仍存在无 CAS 写法，不能一概称全部写入都是 CAS |
| Go 账号库 | [credential_store.go](../../internal/adapters/accounts/sqliteaccount/credential_store.go#L182) CAS `WHERE account_ref AND updated_at_ms`；静态 rotate / reauth / rekey 各有用例 | CAS 防本地陈旧覆盖，不等于在发上游轮换请求前已取得全局刷新权 |
| 两库对账 | `reconcileOnce` 先拉 Go 严格更新代次到 Node（CAS），再按内容指纹推 Node→Go；随后启停/default/policy/state、删除已链接消失账号、收养可逆 Go-only 类型 | 有旧链接删除和重复静态 key guard，但无两库分布式事务。未支持的形态显式 `unsupported/goOnly`；需观察错误/收敛，不可把周期同步当瞬时一致 |
| 原生运行投影 | `materializeProviderAuth/captureProviderAuth` + [storage policy](../../lib/runtime/provider-storage-policy.js)；通常由账本投影，ZCode `liveStore` 用 mtime/可读性保留较新客户端原地续期数据并只补缺键 | Cline 只提取自身槽位，避免复制整库其它厂商密钥；CodeBuddy 家族先校验 issuer/subject/realm；投影路径隔离不代表已验证磁盘权限/Keychain 状态 |

## 4. 16 种 Provider 与认证形态覆盖矩阵

权威集合：[core/providers/builtins.go](../../core/providers/builtins.go) → [生成 manifest](../../contracts/providers/manifest.json)；Node [provider-catalog.js](../../lib/provider-catalog.js#L3) 读取此合同。不是从旧 `provider-catalog-data.json` 数条目猜支持范围。`nativeaccount.NewDecoder` 当前明确注册 **16** 个类型，Node [provider-credentials registry](../../lib/account/provider-credentials/index.js) 也覆盖这些类型。

列说明：**D** = Go `application/accountauth` 直接 OAuth 作业；**C** = 官方 CLI/宿主认证链（可包含 Go login-job broker，非 D）；**S** = 静态输入；**G-refresh** = Go 续期策略已装配；**static strategy** = 仅允许取凭据、不做续期，不是“永不过期”。这些都是源码能力，不能推导当前上游协议仍有效。

| Provider | 入口/认证形态 | 稳定身份与 native 来源（均为源码形状，不含实值） | 续期 owner / 限制 |
|---|---|---|---|
| `codex` | D 浏览器；声明的 device mode 走 C 分支；S API key | OAuth 用户 `userID/sub`，workspace/account_id 不替代用户身份；`auth_json` → authfile；Node `provider-credentials/codex.js` | G-refresh `codexoauth`；Node `codex-token-refresh` 及 CLI usage lock 仍有入口；不是全局唯一 flight |
| `claude` | D 浏览器；S API key / auth-token；领域另区分不可刷新的长效 OAuth token | OAuth account UUID；原生 credentials + global oauthAccount/profile 必须同身份；`claudeoauth` / `claude/nativeauth` | G-refresh `claudeoauth` 只处理可刷新 OAuth；Node helper 仍保留；不可把长期 token 当 refresh token |
| `gemini` | S API key / Vertex；旧 OAuth 可导入。**新 Google browser login 在当前合同/handler 显式禁用**，不在此判断外部停用原因 | `googleAccounts.active` 的规范邮箱 + `oauthCreds`；Vertex 用独立项目/位置/凭据类型 | G-refresh `geminioauth` 经 tokenrefresh；强制 Go 归属/委托豁免；静态模式不刷 OAuth |
| `agy` | D `aih-google-oauth`；C `native-cli` | 规范 email 是身份，token 之外必须有 email；typed AGY OAuth / `native_auth_json`，投影含 email 与 OAuth artifacts | G-refresh `agyoauth`，账号级 egress；Go 强制拥有；管理 resolver 另写 AGY auth projection/默认宿主，推理 resolver 未装同样钩子（G-02） |
| `opencode` | D `opencode:device`；S API key | native `auth` grants，subject/metadata accountID，规范化 grant 集；device artifact 确实有 access/refresh/expires | 当前 composition **没有 opencode refresh strategy**；模型预刷新特殊兼容为使用原快照。原生客户端可能续期，但独立 Go 自动续期 owner 未落实（G-06） |
| `grok` | C browser login；S xAI key | profile/user ID 集合及 token；[grok policy](../../internal/adapters/accounts/nativeaccount/grok_policy.go) | G-refresh `grokoauth` + tokenrefresh；Node Grok helper 仍存在，不能照注释说所有 Node 实现已删除 |
| `qoder` | C browser；S PAT（也有 native PAT 表达） | opaque user artifact 的可验证 uid 或 PAT 身份；[qoder policy](../../internal/adapters/accounts/nativeaccount/qoder_policy.go)、`qodercred` 解码边界 | Go static strategy；厂商 CLI/宿主续期与观察，不在 Go 伪造 OAuth refresh |
| `qodercn` | C CN browser；S PAT | 同 Qoder policy，但 Provider/site 是身份边界，不与 global 合并 | Go static strategy；与 qoder 分别登记 |
| `kimi` | C Kimi Code 登录（底层 device 授权）；S Moonshot key | credentials JWT/subject 一致性；独立 deviceId 元数据；[subject policy](../../internal/adapters/accounts/nativeaccount/subject_policy.go#L10) | G-refresh `kimioauth`；Node Kimi helper 有 account-keyed promise + CAS；Desktop QR/session 是独立宿主会话，不等同 Code OAuth 完成 |
| `kiro` | D Builder ID / social device；D 手工 refresh-token | [kiro policy](../../internal/adapters/accounts/nativeaccount/kiro_policy.go)：GetUsageLimits subject + endpoint + tokenBinding evidence，不用刷新令牌/邮箱代替用户身份；原生 auth/CLI DB 在 adapter 边界 | G-refresh `kirooauth`，Go 强制拥有；native artifact代次仲裁；本页未读取任何 Kiro DB 或粘贴真实令牌 |
| `zcode` | D zai/bigmodel CLI-flow 与 custom-scheme；S Z.ai key | 解密后的 credential 文档，ZCode user ID 与 z.ai 数字 ID 分开；[subject policy](../../internal/adapters/accounts/nativeaccount/subject_policy.go#L28)，Node regional seed 需要 ref map | Go static strategy；ZCode 原生 liveStore 续期，投影不得覆盖新文件；不是 Go token-refresh daemon 已完成该类型续期 |
| `codebuddy` | C global browser / 可用 Go CLI login broker；S key | [family policy](../../internal/adapters/accounts/nativeaccount/codebuddy_policy.go)：access/refresh subject = uid，issuer/domain/Provider realm 一致；原生 credential codec | Go static strategy；官方客户端/宿主原生更新链 |
| `codebuddycn` | C CN browser / broker；S key | 同 family policy，CN realm 独立，不用 global token 填入 CN | Go static strategy |
| `workbuddy` | C global browser / broker；S key | 同 family policy，但 WorkBuddy global issuer / 原生 credential layout 独立 | Go static strategy |
| `workbuddycn` | C CN browser / broker；S key | 同 family policy，WorkBuddy CN issuer / layout 独立 | Go static strategy |
| `cline` | C Cline Pass；S Cline key | 仅 Cline slot 的 WorkOS access token subject；[cline policy](../../internal/adapters/accounts/nativeaccount/cline_policy.go)，不导入整份 providers.json 中其它厂商密钥 | G-refresh `clineoauth` + tokenrefresh；新登录不是 D registry 中的直接 OAuth Provider |

共同来源：[Go direct jobs 装配](../../internal/host/aihserver/composition.go#L1243)、[刷新策略装配](../../internal/host/aihserver/composition.go#L640)、[Node mode/strategy 分流](../../lib/server/web-account-auth.js#L1407)、[native decoder registry](../../internal/adapters/accounts/nativeaccount/decoder.go#L39)、[native identity 值](../../core/accounts/native_identity.go)。认证声明 ≠ 某个 endpoint 的可接受形态；各入口差异必须保留在账上。

**类型轴不要混用**：Provider、持久凭据的 auth-kind/auth-mode、用户 enabled、运行阻塞、Auth Job status 与 UI `oauth_pending` 是不同事实。[ResolveOauthPendingState](../../core/accounts/oauth_pending.go#L34) 只推导“已创建但未配置 OAuth”的展示 pending/stale，不是另一种可用于刷新/推理的凭据，也不等于仍存在可完成的 OAuth flow。

**模型 / 额度的类型覆盖另算**：Go [modelProviderModules](../../internal/host/aihserver/model_providers.go#L55) 展开 family/Qoder 后涵盖 16 个 Provider；[usageProviderModules](../../internal/host/aihserver/usage_providers.go#L56) 涵盖除 OpenCode 外的 15 个。策略存在不保证该类型每种凭据形态可采集，也不代表真实账号有额度或模型权限。`quota_usage` 声明、展示文档、路由可用事实和已注册策略不能互相代替。

## 5. 叶子功能调用图与失败边界

风险标记：**R** 只读快照；**W** 持久写入；**H** 宿主文件/进程副作用；**N** 网络授权/探测。这里只标将来执行该叶子的性质，本轮一项也未调用。

### 5.1 导入、授权、登记与身份更新

| 叶子 ID | 用户动作 → 叶函数 / 存储边界 | 成功与失败合同；当前证据 |
|---|---|---|
| ALC-01 | S 新增 → `webuiaccountauthapi.HandleStaticAccount/buildStaticCredential` → `AccountImporter.Import` → `Registrar.Register` → `Store.RegisterNew` | W；无 OAuth 交换；provider/mode/baseURL 明确校验。通用管理静态工厂更窄，见 G-05 |
| ALC-02 | 显式 artifact 导入 → `accountsapi.handleNativeImport/decodeNativeAccount/importAccount` → `Decoder.Decode` → `AccountImporter.Import` | W；每 Provider 独立 envelope，首次 201 / 既有 200；不相信输入 accountRef/CLI ID 自报身份 |
| ALC-03 | AIH bundle 导入 → `webuiaccountimportapi.serveStart` → job engine → `AccountsHandler.ImportAihAccounts/importAihAccount/importCredentialForEntry` | W；异步 202 只是作业创建；逐条 created/updated/failed/skipped。Codex/Claude native envelope 与 env 类型缺口见 G-04/G-05；导入 down 状态未恢复见 G-09 |
| ALC-04 | 宿主扫描/本机导入 → `host-auth-scan/import` / Go `HandleLocalImport` → source-specific adapter → native registration | R→W，可能 N/H；用户显式导入与自动观察分开，后者尊重墓碑；sourceId 不能成为任意路径入口 |
| ALC-05 | OAuth start → `accountauth.Service.Start` → Provider `Begin/BeginWithOptions` → pending + activeJobs | N/W；每 Provider 一个活动 Job、全局容量/TTL 有界；state/PKCE/flow 内存保存。并发 Begin 前后有两次容量检查，但不等于跨进程唯一 Job |
| ALC-06 | browser callback → `Complete/CompleteByState` → claim → `flow.Exchange` → `finishClaimWithClaims` → Decode → Register/Reauthenticate | N/W；重复完成等待/回放同一 Job 终态，不重跑交换；不因“收到了 token”直接标 completed |
| ALC-07 | device / paste-token → `pollDeviceJob` / `CompleteWithArtifacts` → 同一 finish 链 | N/W；设备轮询按 flow interval、pending/slow-down/终态；Kiro paste 不是通用任意 Provider token 注入 |
| ALC-08 | cancel/read/restart → `Cancel/GetJob/Rehydrate` + `JobStore` | pending 可取消，processing 不伪装撤销已提交账号；重启把无私有 flow 的 pending/processing 标 expired；公开快照持久化 best-effort，不是交易日志 |
| ALC-09 | C/native/plugin auth → Node `startOauthJob/startGoCliLoginJob/startNativeOauthJob` → `registerProviderAuthProjection` → `registerAccountIdentity` + credential write | N/H/W；官方登录能力与 D 不等价；Go-only 流程缺 Go 时 fail closed；Node 登记/凭据分事务风险见 G-03 |
| ALC-10 | 同身份导入 → `AccountImporter.Import` conflict branch → existing static 幂等 / refreshable/native reauth | W；校验 existing ref/provider；可刷新导入重试有界（32）；generation 无法排序不盲写。不是全量 replace |
| ALC-11 | 指定账号重新认证 → `Reauthenticator.ValidateTarget/Reauthenticate` → `NewReauthentication/ShouldReplaceCredential` → SQLite reauth | W；保持目标身份，不把另一个用户静默塞进旧账号；成功后 model/usage 装饰器换代重排 |
| ALC-12 | 静态编辑/换 key → `StaticCredentialRotator.Edit/Rotate` → versioned rotation store | W；保留 AccountRef / CLI alias / 已有成功模型；当前 key fingerprint 可以变，不能重新登记成“新账号” |
| ALC-13 | 刷新中稳定身份变化 → `Resolver.refreshSnapshot` → `ReKeyStore.ReKeyAccount` → reindex + projection rename / account egress binding move | W/H；只有证明 Go 拥有且注入 ReKeyStore 才允许；不是所有 refresh 都能改 ref。两 resolver 装配不同见 G-02 |
| ALC-14 | 导出 → `ExportAccountCollection/exportAccountEntry/exportStaticEnv` | R 但输出敏感凭据，不能为“只读审计”擅自执行；本轮只比较代码形状。当前导入/导出并不全类型闭环 |

补充函数来源：[account_import.go](../../application/accounts/account_import.go)、[auth service](../../application/accountauth/service.go)、[reauthentication.go](../../application/accounts/reauthentication.go)、[static rotation](../../application/accounts/static_credential_rotation.go)、[SQLite rekey](../../internal/adapters/accounts/sqliteaccount/rekey_store.go)、[AIH import](../../internal/transport/http/accountsapi/aih_accounts_import.go)、[AIH export](../../internal/transport/http/accountsapi/aih_accounts_export.go)。

### 5.2 默认、凭据续期与投影

| 叶子 ID | 链路 | 需要保留的边界 |
|---|---|---|
| ALC-15 | `ProviderDefaults.Get/Set/Clear` → `Store.SetProviderDefault`；WebUI set/clear-default → Go adapter → native host landing | W/H；SQL 默认关系的 BEGIN IMMEDIATE、目标校验/幂等，不覆盖宿主副作用失败；CLI map 管入口合同 |
| ALC-16 | `Resolver.Resolve/ResolveCredentialBinding/ResolveObservedCredentialBinding` → `readResolutionState` → due/ownership/suppression → flight → refresh | R→N/W；返回 binding/观察版本；未登记策略不是静态凭据“自动支持” |
| ALC-17 | `ForceRefreshCredentialBindingIfCurrent` → flight 内二次代次校验 → `refreshSnapshot` / 最新 snapshot | N/W；明确 401 拒绝代次不能走普通预刷新的旧 token 降级；不能把 no-op flight 当已恢复 |
| ALC-18 | `tokenrefreshdaemon.Start/Trigger/executeCycle` → enabled+credential+due 筛选 → refresher | N/W；daemon 有 runGate/worker 边界，disabled/delegated 会跳过；Node daemon 只 host-sync/self-heal + Go trigger，不证明所有 Node 调用点已迁完 |
| ALC-19 | Node `refresh*AccessToken` → provider endpoint → `compareAndSwapAccountNativeAuth` / native writeback | N/W/H；Codex/Claude/Grok account-object promise，Kimi account-keyed promise；CLI `withAuthRefreshLock` 只锁对应文件路径，非 Go 共享锁 |
| ALC-20 | `materializeProviderAuth/captureProviderAuth`；AGY `OnCredentialRefreshed` → `agyprojection.Write` / default-host sync | H/W；磁盘投影不是账本事务一部分；回调失败不回滚 credential，必须另记恢复；ZCode liveStore、family issuer、Cline slot 的保真规则不能被通用 copy 覆盖 |
| ALC-21 | `createGoAccountSync.reconcileOnce` → pull CAS / translate push / status+defaults / delete linked / adopt | W；有单实例 running promise；没有与 Go resolver/其它进程共享的 OAuth flight；不可绕过 API 直接写 aih.db 期待内存路由立刻更新 |

### 5.3 启停、删除、额度与模型刷新

| 叶子 ID | 链路 | 成功/失败与恢复边界 |
|---|---|---|
| ALC-22 | management enable/disable → `Management.SetAccountEnabled` → `Store.SetEnabled` → routing index；启用后 `scheduleModelRefresh` | W；enabled 是用户状态，CAS 更新时间；只有 false→true 才调度。WebUI status 另走直存储入口，见 G-07 |
| ALC-23 | WebUI status → `webuiaccountstatusapi.ServeHTTP` → Node-style projection → Store.SetEnabled → optional host grant revoke | W/H；事实写失败尝试回滚 projection；停用后回收结果单独返回。没有修改默认身份，也不能承诺取消全部既有推理 |
| ALC-24 | 删除 → `Deleter.DeleteAccountWithOptions` → occupancy inspect/release → host grant → prepare → Store.DeleteAccount → ForgetAccount / default landing | W/H；无 force 遇占用返回 blocker；force 属后续单独授权。部分宿主副作用在 DB commit 前，故失败不代表全无副作用 |
| ALC-25 | deletion preparation → `PrepareAccountDeletion` → reconcileCredential/resources → safe projection removal；SQLite tombstone + delete | W/H；防符号链接越界、先收敛较新原生数据，用户资源与 disposable auth 分开；删除后清理不得重新造账号 |
| ALC-26 | Node delete → `createAccountRemovalService` → runtime/projection/resource cleanup → `deleteAccountRef` | W/H；BEGIN IMMEDIATE 中 retired/deleted/key-hash tombstone + delete；成功后发布 lifecycle event。两库一致依赖 mapped delete/adoption guard，不是全局原子删除 |
| ALC-27 | usage read/refresh → `Service.GetUsage/RefreshUsage` → credentialSnapshots → strategy.FetchUsage → version-guarded persist → document → runtime projection | R / N/W；只读列表不等于主动探测；失败保留旧快照。normalized usage、展示 document、runtime projection 是多个阶段，不应称三者单事务 |
| ALC-28 | model list/refresh/policy → `ModelManagement.RefreshAccountModelSnapshot` → credential refresh → `discoverWithCredentialRecovery` → `ReplaceDiscoveredModelsIfCredentialVersion` → probe | R / N/W；401 至多恢复一次；失败不清旧模型；success probe 和目录使用相同 credential generation；人工策略独立保留 |
| ALC-29 | register/reauth/rotate/enable 后异步 refresh → model / usage lifecycle decorators → provider queues；sweep / route-miss / initial-recovery 亦可触发 | N/W；入队不是完成；支持集合、backoff/timeout、旧任务取消、credential generation 必须同时成立；列表不能被隐式 N+1 探测拖住 |
| ALC-30 | delete / new generation → model coordinator.ForgetAccount、usage.ForgetAccount、runtime.ForgetAccount、resolver.ForgetAccount | W（派生状态）；model/usage 取消/隔离旧代次；credential resolver 的 Forget **只清 suppression**，不取消 OAuth flight；不能由名称推断全部网络任务已终止 |

来源：[deletion.go](../../application/accounts/deletion.go#L287)、[deletionprojection](../../internal/adapters/accounts/deletionprojection/preparer.go#L89)、[SQLite delete](../../internal/adapters/accounts/sqliteaccount/deletion_store.go#L20)、[Node removal](../../lib/account/account-removal.js)、[Node ref delete](../../lib/server/account-ref-store.js#L357)、[usage service](../../application/accountusage/service.go#L332)、[usage coordinator](../../application/accountusage/coordinator.go)、[usage lifecycle](../../application/accountusage/lifecycle.go)、[model lifecycle](../../application/accounts/model_refresh_lifecycle.go)、[model coordinator](../../application/accounts/model_refresh_coordinator.go#L155)、[model sweep](../../application/accounts/model_refresh_sweep.go)、[route-miss refresh](../../application/accounts/route_miss_model_refresh.go)、[initial recovery](../../application/accounts/initial_model_refresh_recovery.go)。

## 6. 并发与生命周期合同的具体边界

### 6.1 Go refresh：已经存在的保护，不应再造一套

- Resolver 在自身实例中按 AccountRef 合并请求；follower 可独立取消；leader 的取消/超时若被健康 follower 继承，最多独立再进入一次 flight。provider adapters 只换令牌，不持有同一份跨 resolver flight。[resolver.go](../../application/accountcredentials/resolver.go#L622)
- CAS 前后有当前版本重读；普通预刷新失败只有在错误可降级且 token **未过期**时才可用当前代次。401 恢复使用 `ForceRefreshCredentialBindingIfCurrent`，flight 内再次比代次；同代 no-op 不算恢复。[force_refresh.go](../../application/accountcredentials/force_refresh.go)
- suppression 绑定 credential generation；不可把旧 grant 的永久拒绝附着到新凭据。CAS 败方只能接受严格更新版本，不能重放已拒绝的 grant。[resolver.go](../../application/accountcredentials/resolver.go#L644)
- refresh delegation、OwnsRefresh、策略豁免分开：composition 对 AGY/Kiro/Gemini 强制 Go ownership；gemini/grok/cline 的 tokenrefresh 策略声明委托豁免；Qoder 双区/family 四支/ZCode 静态策略不发 OAuth 请求。实际 delegation 配置本轮没有读取。
- **保护不是全局锁**：管理/usage/model resolver 与 inference resolver 是不同实例；Node helper、文件锁、原生客户端也在别的锁域。CAS 在上游交换**之后**执行，不能倒推上游 grant 只被消费一次（G-01）。

### 6.2 Auth Job 与账号提交不是同一笔持久事务

`pending → processing → completed/failed`；pending 另可 cancelled/expired。callback claim 防同一内存 Job 重入，completed 回放已有 ref/id。私有 flow 不持久化，`Rehydrate` 令重启遗留 pending/processing 过期。

`persistJobLocked` 先 publish，再 best-effort `UpsertJob(context.Background())`，失败只记录诊断；账号数据库提交和 Job public snapshot 不在同一事务。[service.go:477–532, 874–910](../../application/accountauth/service.go#L477) 因而“Job 当前返回 completed”与“重启后一定能回放 completed”不是同一保证。保持现有错误可观察语义，下一步验证不能通过损坏真实凭据/数据库来制造失败。

### 6.3 删除和模型/额度代次

- DB tombstone + account delete 同事务；额外显式删 credential，不只依赖 foreign-key PRAGMA。并不意味着本地投影、host grant、default landing、两库 sync 同事务。[deletion_store.go](../../internal/adapters/accounts/sqliteaccount/deletion_store.go)
- model Forget 移除 pending task 并 cancel；usage Forget 增加 generation 并与 runtime projection 锁配合；迟到旧结果不得重新投影当前账号。[model coordinator](../../application/accounts/model_refresh_coordinator.go#L210)、[usage flight](../../application/accountusage/service.go#L684)
- credential resolver Forget 只清抑制。已发起 OAuth 网络请求可能继续；已删行使普通 CAS 失败，但同身份快速重建、re-key、另一 resolver 和 Node 同步交错仍待真实验证。**不宣称已经观察到复活、串号或丢凭据**。
- WebUI 删除 composition 的 `GatewaySync: nil` 是明确的宿主落点能力缺口，返回 `host_sync_unavailable`，不得把“DB 已删除”报告成“默认原生授权已经全清理”（G-08）。

## 7. Web 服务 facade 的准确映射

[正式 `services/api.ts`](../../web/src/services/api.ts#L458) 与 [account-management facade](../../web/src/services/account-management/facade.ts) **不是同一个 `accountsAPI` 实例**。前者仍被正常账号功能引用；[AccountsGoPreview](../../web/src/pages/AccountsGoPreview.tsx#L53) 使用 preview facade。不是找到新目录就可以宣布页面迁完。

| 操作 | 正式 Web facade → 服务边界 | Go preview facade → Management API |
|---|---|---|
| list/watch | `/v0/webui/accounts`、`/watch`；共享 SSE/public WebUI projection，Node/Go frontdoor wiring 依宿主装配 | `list/loadSnapshot` → `client.listAllAccounts` keyset + 两 Provider defaults；`AccountWatchCoordinator` 合并读取 |
| add | `/v0/webui/accounts/add`；Node `tryGoAddAccount/importStaticAccountViaGo` 或 Go public-add adapter；静态与直接 OAuth/原生作业分流 | `add`：仅 Codex/Claude；browser → `/v1/management/account-auth-jobs`；静态 → `/v1/management/accounts`；拒绝 device/Vertex |
| auth jobs / reauth | `getAddJob/cancel/completeBrowserCallback/local-import` 与 reauth；兼容路由、Go job tracker/ref 映射要一起核对 | `getOAuthJob/cancelOAuthJob/completeOAuthJob`；reauth 带 `target_account_ref`；已完成 job 才触发刷新快照 |
| import/export | `/webui/accounts/import` → Go `webuiaccountimportapi` → `ImportAihAccounts`；批量 summary 与逐条结果 | `import` 经 import-policy/native import；不是对 16 类型全面替换正式导入 |
| enabled / edit | `/accounts/{provider}/{ref}/status` / `update` → Go WebUI adapter；status 当前直接 Store.SetEnabled | `updateStatus` → PATCH `/accounts/{ref}` → `Management.SetAccountEnabled`；credential rotate 走单独 client method |
| delete | public account delete → Go WebUI Deleter，带占用/force/宿主结果 | `delete` 合并同页重复 promise → DELETE `/accounts/{ref}`；通用接口不授权 force |
| default | `set-default/clear-default` → Go WebUI host-aware adapter，Node 可附桌面 runtime reload | PUT/DELETE `/account-defaults/{provider}`，仅默认关系；不可视为与宿主 auth/config 同义 |
| usage / models | explicit refresh-usage / refresh job；真实 job 完成与持久快照分开 | `refreshUsage` 同步 POST usage/refresh；模型展开才读，refresh 同步返回持久结果，policy PATCH |

源码：[client paths/methods](../../web/src/services/account-management/client.ts#L37)、[decoders](../../web/src/services/account-management/decoders.ts#L97)、[types](../../web/src/services/account-management/types.ts#L3)、[Node WebUI account routes](../../lib/server/webui-account-routes.js)、[Go bridge](../../lib/server/webui-account-go-reauth.js)、[Go route assembly](../../internal/host/aihserver/webuiroutes.go#L875)。public alias 重写与完整入口拓扑只链接其它地图，本文不复制。

**确认的 scope 限制，不误报 bug**：preview `ManagedProvider = codex | claude`；`decodeAccountPage` 安全过滤其它 Provider，而不是把它们错误转换成 Codex/Claude，也不是遇到它们必然整页失败。该 preview 不证明正式账号页遗漏 14 种类型；所有真实渲染/入口采用情况均 U。

## 8. 静态缺口、运行未验证与下一步

### 8.1 已确认静态缺口（并非运行事故结论）

优先级按潜在影响排队；所有条目均未修改实现、未真实复现。没有建立 P0 数据丢失/凭据泄漏运行证据，不能据此断言全系统没有 P0。

| ID / 优先级 | 确认的源码差异与因果 | 不能越界宣称的部分 / 建议 owner |
|---|---|---|
| **G-01 / P1** | [composition:741](../../internal/host/aihserver/composition.go#L741) 与 [inferenceruntime:132](../../internal/host/inferenceruntime/runtime.go#L132) 分别 `NewResolver`，每实例有自己的 active map/suppression。共享策略集合不是共享 flight；Node helpers/CLI file lock 也未共用该 map。上游交换先于 SQL CAS，所以保护不足以证明跨 usage/model/inference/Node 的单消费者刷新 | 无真实并发/轮换失败证据；先协调 composition + resolver owner，再验证共享/委托策略，不自行加第三套锁 |
| **G-02 / P1** | 管理 resolver 注入 `OnCredentialRefreshed`、`OnAccountReKeyed`、`ReKeyStore`；推理 resolver 装配只有 Store/Strategies/Clock/delegation/ownership。AGY 刷新成功后的原生投影/默认宿主同步及身份 re-key 能力因此按入口不同；无 hook 的 CAS 成功不能触发管理 resolver 的 hook | 未证明正在运行的原生客户端拿旧 token；需逐入口证明最终投影，不以另一周期同步“可能会补”代替保证 |
| **G-03 / P1** | Node [registerProviderAuthProjection:641](../../lib/account/native-auth-projection.js#L641) 先完成 `registerAccountIdentity` 自有事务，再独立 `writeAccountNativeAuth`；不是 Go `RegisterNew` 的账号+凭据原子事务。中间异常可留下已登记却无凭据的账号；一般 native 覆写还存在非 CAS 分支 | 尚无磁盘/SQLite 失败复现；不要在共享库故障注入。owner：Node native registration / credential store |
| **G-04 / P1** | [AIH exporter](../../internal/transport/http/accountsapi/aih_accounts_export.go#L149) 导出 Codex `nativeAuth.auth`、Claude `nativeAuth.credentials`；[batch import:159](../../internal/transport/http/accountsapi/aih_accounts_import.go#L159) 无条件包 `native_auth_json`。但 [decoder:180](../../internal/adapters/accounts/nativeaccount/decoder.go#L180) 对 Codex 要 `auth_json`、Claude 要 `credentials_json + global_config_json`，严格 envelope 会拒绝。Claude 导出还没有该全局 identity/profile artifact，不能只改字段名就宣称闭环 | 源码层 round-trip 合同不成立，未执行导出/导入；独立 `/account-imports` 和 Node translator 的正确 envelope 不受这条推断牵连。owner：bundle exporter/importer + native codec |
| **G-09 / P1** | [导出状态](../../internal/transport/http/accountsapi/aih_accounts_export.go#L233) 明确把 disabled 写成 `status: down`；[importAihAccount](../../internal/transport/http/accountsapi/aih_accounts_import.go#L120) 却只派生 credential/profile 并 Import，未使用输入 `Status`。[NewAccount](../../core/accounts/account.go#L62) 默认 enabled=true。因此**可成功解码的条目在目标首次登记时**不会保留导出的停用状态（即便 G-04 的 native 格式问题不涉及该条目） | 未实际导入，也未观察自动请求；此结论不适用于仍存在且已停用的幂等目标。先确认迁移是否应保留用户禁用意图，不能擅自把修复实现为全量覆盖现有状态。owner：bundle import / lifecycle |
| **G-05 / P2** | [WebUI static creator](../../internal/transport/http/webuiaccountauthapi/handler.go#L465) 可构造通用 `StaticAPIKeyAuth`；[management factory](../../internal/transport/http/accountsapi/credential_factory.go#L53) 只提供 Codex/Claude key（另有 Gemini Vertex），[AIH import env switch](../../internal/transport/http/accountsapi/aih_accounts_import.go#L175)、[exportStaticEnv](../../internal/transport/http/accountsapi/aih_accounts_export.go#L196)、[Node translator](../../lib/account/go-bridge/go-import-translator.js#L186) 未覆盖同一通用静态集合。新建支持不能推出迁移/导出/同步也支持 | 不笼统说某 Provider 全部不可用；逐 provider × auth-kind 记录 unsupported/skipped。owner：静态 adapter/transfer boundary |
| **G-06 / P2（无人续期时升 P1）** | OpenCode device [buildArtifacts](../../internal/adapters/accountauth/opencodeoauth/flow.go#L308) 保存 refresh/expires；composition refresh 集合没有 OpenCode。[credentialSnapshots.RefreshCredential](../../internal/host/aihserver/credential_snapshots.go#L37) 遇 `ErrRefreshStrategyNotFound` 返回原快照，故模型不会仅因缺策略直接失败，但也不会在此续期；强制认证恢复仍报策略缺失 | 原生客户端是否负责、Go-only 长时间无人启动时是否过期均 U；不能宣称 OpenCode 模型刷新一律 500，也不能把带 refresh token 的 OAuth 统称静态 |
| **G-07 / P2** | [Management.SetAccountEnabled](../../application/accounts/management.go#L194) 的 false→true 会 schedule 模型刷新；[WebUI wiring:498](../../internal/host/aihserver/webuiroutes.go#L498) 给 status handler 注入 `dependencies.Store`，[handler:208](../../internal/transport/http/webuiaccountstatusapi/handler.go#L208) 直接 SetEnabled；Store 只 CAS/更新路由。正式 WebUI status 未经过应用层 enable-refresh 装饰 | 不能说模型永远不更新：后台 sweep/route-miss 仍可能恢复；未测到用户等待时长。owner：status adapter / lifecycle application |
| **G-08 / P2（宿主授权残留需单独评估）** | [deletion composition:980](../../internal/host/aihserver/composition.go#L980) 的 GatewaySync 为 nil，default landing 显式 `host_sync_unavailable`；host grant 目前仅 Codex 声明。数据库删除、默认落点、宿主授权撤回不是同一个成功结果 | 未观察宿主残留或凭据泄露；用户收到删除成功仍须分别看到 cleanup/default outcome。owner：deletionhost / host-default，不能私自改宿主配置补齐 |

**不能因审计而退化的已有保护**：不要弱化 `missing_stable_identity`，不要绕过 NativeGeneration 比较/SQL CAS，不要为了 G-04 接受任意 envelope，不要把所有原生凭据当通用 JSON 复制，不要通过删掉其它 Provider 让 preview/导入“通过”。

### 8.2 尚未验证，不能计入完成的事项

| 未决项 | 已有 S 证据与 U 边界 |
|---|---|
| 每类型真实登录 / 同身份再导入 / reauth | 16 decoder 与 6 direct-job 注册已确认；真实供应商 callback、权限、认证策略版本、CLI 安装状态、每种原生源可用性均未验证 |
| 共享刷新权 / 默认 delegation | 可读装配已确认；未读运行配置，不知道当前 Node/Go/原生客户端实际活跃组合。不能由 Node daemon 的 `oauthRefreshOwnedBy: go` 推导所有 helper 无调用 |
| Job crash/cancel/重复 callback | 内存 claim、公开持久化、restart expiry 源码已确认；账号提交后 Job persist 失败、processing 取消、设备轮询断线的真实可观察状态未验收 |
| re-key / rotate 与模型/usage/delete 交错 | 相关版本检查/Forget 代码已读；高并发是否收敛、是否有原生投影残留、CLI alias/default/link 是否全迁未实测 |
| 停用 / 删除 / 重新显式导入 | enabled、占用、tombstone、资源 reconcile 代码已读；实际进程/Keychain/文件清理/两库收敛未观察，不能声称“不复活”已验收 |
| usage 与 model snapshot | 有 credential CAS、失败保旧、有限重试；真实数值/过期/队列积压/取消/错误分类、display document 与路由事实一致未验证 |
| 正式页面与 preview | client/facade 调用已定位；共享 frontdoor/auth/control-plane 在 peer 修改中，真实页面接线与操作后刷新未验证；本次未开浏览器 |
| 凭据安全 | 不输出 token/授权码、限定 native slot 等静态规则已确认；实际文件 mode、备份/Keychain、存储加密、日志脱敏与主机权限不是本次证据范围 |

### 8.3 优先级排序的下一步安全验证包

以下是**后续提案**，不是本次执行授权；继续文档/源码核对可保持只读。涉及真实账号/持久化/上游的每项先说明最终状态与影响，另取明确许可；不新增测试用例，不触碰生产推理或共享配置。

| 顺序 | 最小安全动作 / 先决条件 | 应得到的证据与停止条件 |
|---|---|---|
| V-00（先做） | 重新计算 §9 指纹、核对 peer 的 composition/transport/transfer 所有权；只读比对 G-01/G-02/G-04/G-07/G-09 调用图 | 当前 source owner 与拟改文件 allowlist；有重叠即协调，不边写边抢路径 |
| V-01（P1 import） | 先只读逐字段比较 Codex/Claude exporter ↔ batch importer ↔ native decoder；再申请独立非共享环境的真实、已脱敏授权材料流转，不在本次导出凭据 | 新建/重复导入/错误材料的逐条结果、稳定 ref/alias、停用意图和未误报成功；区分首次导入与现存目标；Claude 必须证明身份材料可恢复。只验证 HTTP 200 不够 |
| V-02（P1 refresh） | 先提出“一个刷新 owner/协调入口”的边界方案，覆盖两个 Go resolver、Node helper、CLI 文件锁；随后在获批账号自然到期窗口做小规模真实 usage/model 并发操作，无推理、无破坏 token | 仅计数/代次/错误码：上游 refresh 次数、CAS 胜者、follower 取消、新代次身份；不能记录 token。出现多次消费或非预期身份立刻停止 |
| V-03（P1 projection/registration） | 只读列出每入口 credential commit→projection→sync 链及 Node 原子边界；后续使用获批账号的真实登录/刷新核对投影代次与目标身份 | 同一账号在账本、Node link、原生投影的非敏感版本一致；不直接打开 live credential 文件来“人工看 token”；失败要能精确区分账号提交/投影未完成 |
| V-04（P2 lifecycle） | 对 status/default/delete 先做业务副作用清单；获批后才启用/停用/清默认/删除指定可恢复账号，不使用 force、不杀共享进程 | 启用后确有 model job；停用保留凭据但退出候选；删除 occupancy/tombstone/default/host outcome 分别可见；确认最终状态再收尾 |
| V-05（P2 coverage） | 只读补完 16 Provider × auth-kind × create/native/bundle/export/sync 矩阵；优先通用 static 与 OpenCode device token owner | 明确“支持/显式拒绝/缺 owner”，不自动修改声明/启用已禁用 Gemini browser flow；未来只在获批真实入口核验 |
| V-06（M3/M4，后续许可） | 在源码归属稳定后复用受支持的后台 Edge 连接检查正式页和 preview 操作；无需推理；连接不可用明确阻塞，不换浏览器/不使用 AppleScript | 操作→job 终态→同一账号 snapshot→模型/usage 结果；视觉检查只覆盖实际页面，不拿源码/构建代替 |

本次收尾门槛只是：**本文存在、来源可追踪、16 类型未被误归为一种身份/续期实现、静态缺口与 U 分离、唯一写路径保持不变**。M3 的真实授权/续期/恢复/删除闭环及 M0 其它域仍未完成。

## 9. 当前源码指纹（SHA-256）

以下只读取仓库内源码；不散列 live credential store/log。目录聚合算法：选择 `.go/.js/.ts/.tsx/.sql/.json` 源码，排除 `_test.go`、`.test.`、`.spec.`、`node_modules`；按 repo-relative path 排序，对 UTF-8 `path + NUL + sha256(file) + LF` 串再次 SHA-256。聚合是定位后续 drift 的工具，不表示目录每个文件都完成审计。

采集时间：`2026-11-15T01:09:52+08:00`；HEAD：`57eb265dfe6689f9b3a5ce13ab8524ee298f315b`。

| 源码组 | 文件数 | 当前聚合 SHA-256 |
|---|---:|---|
| Provider 合同 | 2 | `1f40d172f8318a18ce5245de44520b6ba07ab23cd11d82668fea23c1d3fb8c16` |
| Go auth jobs | 4 | `cf747588c9caa4769d5c42f19e030f0f45757af33acb8213e4363afa87adae65` |
| Go credential resolver | 3 | `990c476a375a55d4c9ef2c79d3359617f4e5a61a36f09a0443c88bef061cb49c` |
| Go account lifecycle | 27 | `650a2ef062e06cdf88568c25be86748a3d31a6186751f866abe737fb87c5286c` |
| Go usage lifecycle | 6 | `6ed4c5510ad9b2dd5cccd09a11d8fdea896f6ab9d3d0d5a362b8bb8b957790bf` |
| Go identity / credential domain | 35 | `58655de5dc27ba91f6adb6d05a65af453c68d89b97fb6f68687045be2eac99f5` |
| Account adapters | 175 | `9aedc0c29e8c80846c927385c58d1de786009d5bcc74283345abd096cc7ee80e` |
| Go composition / host default | 105 | `0f2e580b4542ef8b084b24bf6e7994287750bfbf05444a211bc5832a2e9363a5` |
| Refresh daemon | 4 | `8e7ad26cb0b0432ff706b62c406ce16f17bd3d711f472cd1c565f6940826c5f7` |
| Go management / WebUI account transport | 79 | `62b823429df5471cb4d3f35d5a2f2315ead8be59841de9a56fe1d89f5e11965c` |
| Node account domain / adapters | 205 | `915dada03b84abc12ff04761670a0f8a432459a7f0cf51d09db7aa4e7ad0f604` |
| Node server / account compatibility | 762 | `fd549b22d5b7c0977cbbdcf4780893f04ca9c1ee54d0fb3b31667232a51070f2` |
| Node native artifact policy | 2 | `0ddec0c48e8d5eb0c1035b8ee01394d4529748c9455abb43f50cb832590b1a0a` |
| Web account facades | 16 | `1b1f04db18b69d80de7ef20bf51f2da6ae203390bdb01ae6a000fb4c3dc50112` |

关键因果文件（上述聚合的可单独复查锚点）：

| 文件 | 当前 SHA-256 |
|---|---|
| `internal/host/aihserver/composition.go` | `0a1ab54dff4254acd020bea4fc760fda0c297f32f2f87137962032bd0b208c6a` |
| `internal/host/inferenceruntime/runtime.go` | `246e28611e6756de1df105c7aaf6e5379e6ff647d32172a84e480d45004512e9` |
| `internal/host/aihserver/credential_snapshots.go` | `2dc31757714e35a95910598cd4d31d0245d9a2e62a90e405084b3c6b2f11f7ed` |
| `internal/host/aihserver/webuiroutes.go` | `a160713e484ca0d709ea1a4336be62683015650e4688780b4a0d59e343dac5ca` |
| `application/accountcredentials/resolver.go` | `e2a6968616e2ccdaefe3cb8967d935bb101064382eadb93b8dbea16db81ce3b9` |
| `application/accountcredentials/force_refresh.go` | `4f3e241dbfaed8468a8e5865fd28c8879a3d02d3f0c04411e5366ab4aa83a9d8` |
| `application/accountauth/service.go` | `92ed696b09603dfe31fee83d5c353d9084604d3119ce3d1d8f0e50bb1a1890a0` |
| `core/accounts/account.go` | `c142a9634ae44d81f7ac2234bc26362a54ad89ba7f0b6c83b3449d7683dc601b` |
| `application/accounts/account_import.go` | `4e2474d1330b9740097bc917bc9316661c4e9b94aa66cb6d6ceaf46dfdc54971` |
| `application/accounts/management.go` | `37c5daf344005e62e1cf14f144619ccbc243a2f0489e9efd751a5c6c91276cbc` |
| `application/accounts/deletion.go` | `0666ad54218c903bd06d1fb4e3f64d49357dc7859c1985203f3256e20f4f714e` |
| `internal/adapters/accounts/nativeaccount/decoder.go` | `4f4fc4a7083e1dfcc0a752f7f230919fcd218a6b4a2c6295c22d57cd77094631` |
| `internal/adapters/accounts/sqliteaccount/credential_store.go` | `863fe734c33e387dbadde26ff1b147398af14848bc613d7cc6c347455b264d58` |
| `internal/transport/http/accountsapi/aih_accounts_import.go` | `7266a5ceeecd906ef2c7ccf803b05cb19edbee6745fa1997b92d2208cc8edc12` |
| `internal/transport/http/accountsapi/aih_accounts_export.go` | `0136d765313255604ab29645f59a8860a797e518e5b9ded068d67b247f307c8d` |
| `internal/transport/http/webuiaccountauthapi/handler.go` | `e658dff6dad8ab552183c514a9a9346b3bbfd15979afb5f0ba68b3fc350eba35` |
| `internal/transport/http/webuiaccountstatusapi/handler.go` | `a449fcd363b786e636f5afbf48a2c2d95e2977e378afb9370694e71fa8db1fd4` |
| `lib/account/native-auth-projection.js` | `6d9947bb5ca8e69adf4ab9ca994cda60df45c29d28c7be25a29581bdc7f907f4` |
| `lib/account/account-registration.js` | `66d6bae2833f954e99a169e870f45860c6de2bc9a7ee0fc15f264e2138e1babb` |
| `lib/server/account-credential-store.js` | `f5f0a44ec86e636144bde9bfafd37a682d69ba93744284c5dbc5fdbc6f999908` |
| `lib/server/go-account-sync.js` | `f9ea71dfd9c96c6a057ad5b254dfba31af060ea42fbfa76ca3a4eff38e33dee4` |
| `lib/account/go-bridge/go-import-translator.js` | `fff9c2958dfe99ce7ee4a244cc8d25018d827e19d2b5100482162d7a84113751` |
| `lib/server/token-refresh-daemon.js` | `00b08e0c18118fbcd671a35c641d7bf93510d66086ebf55fb721acfaf8f252e7` |
| `web/src/services/api.ts` | `f3b3b7c6ae1269b253d273ff295d18fda580b0f346abf43dcfece5ce9a8b3b69` |
| `web/src/services/account-management/facade.ts` | `9e9b905599b0282590584ffbaba0068baa4f455c298f23a7c8db2ff2bdf70b10` |
| `web/src/services/account-management/decoders.ts` | `28e5d8534785315c952a19de1aa6e55c16044287a51cd6c3be22c967ce937946` |

## 10. 本次文档复核记录

- 复核时间：`2026-11-15T01:09:52+08:00`；共享 HEAD：`57eb265dfe6689f9b3a5ce13ab8524ee298f315b`。
- 本地链接目标与行号范围逐一检查；16 Provider 行完整、ALC-01 至 ALC-30 无重复；G-01 至 G-09 均为静态缺口/能力边界，未把 U 标为真实完成。
- 14 组源码聚合和 26 个关键因果文件单独 SHA-256 已复核；账号关键文件没有漂移。`Go composition / host default` 聚合因 peer 更新下列 host.go 而刷新，不能把该组当整段时间冻结快照。
- `git diff --cached --stat` 末查为空；账号核心、管理/推理装配、Node 账号模块及 facade 的已跟踪路径 `git diff --name-only` 无差异（该命令不包含下列 peer host/CLI 路径）；本文仍未跟踪、未暂存。工作区其它既有/新增变化均不归本次交付。
- 对本文执行 `git diff --no-index --check -- /dev/null docs/product-integrity/account-lifecycle-map.md`：无 whitespace 诊断；exit 1 是新增文件的 no-index 差异状态，不冒称产品测试通过。另做文档 trailing-whitespace 与本地引用检查。
- 仅本文写入；未编辑实现、计划、其它地图、测试或配置，未调用运行态 API/凭据/日志。内存指纹工具只存源码哈希，不产生旁路证据文件。

### 10.1 审计期间实际观察到的 peer 漂移

初始 5,110 文件基线比对发现下面三项已有文件内容变化；另外两项为末查新增的 peer 源码（不在初始逐文件基线）。这不是本次更改清单，也不根据同目录推定 owner。host.go 的 `PatchHost` 新内容涉及 TOML parsed spans/原生 endpoint 处理，仍属并行宿主默认工作线；本文没有执行它，也没有把它算作 G-08 宿主 GatewaySync 已接线。

| peer 路径 | 初始 SHA-256 / 基线状态 | 末次观察 SHA-256 |
|---|---|---|
| `internal/host/aihdefault/content/codex/host.go` | `25bb488b7ba4272be20a57c3a0af3da7ad49cfaa175dd2d6d5e47bd9b726ee16` | `dddf9eb21a992e3f39d237fd552101a6630ed689879328b7a8ac82983d1c9010` |
| `lib/cli/commands/ai-cli/router.js` | `93c9d5a51d077fc0676eaf2eceff3ff51dcb153fc66759239ce5dea92474538d` | `30a8f87ba4bb34d617824bac008d8ea6a2fa5f6b9bf2cc7ed43262c0f129756c` |
| `lib/cli/services/ai-cli/provider-resume-verb.js` | `51329aa79be1c7be3aab24d265614b419606bb4a236719c008b389f22bbd6515` | `2a380932e2bb111cc1ea27a5203d7970e4ef8d9665b62251e9a7d16ab2c2f9cf` |
| `internal/runtime/providerconfigs/toml_statements.go` | 初始基线之外，新出现 | `7763720841cc9fd1af78bd0baecfbfded2c3c5b83b543d6cd31cb502eecbb281` |
| `lib/cli/services/ai-cli/native-escape.js` | 初始基线之外，新出现 | `72268e37c62611af6b8d48c4470a51d3710123c270cd4e4524783711ff12041a` |

边界结论：共享源树仍在移动；后续实施/真实验收必须重新确认这些哈希和 owner。本次没有改动或回退上述任何 peer 文件。
