# 账号身份闭环：生产验收与历史评审核对

日期：2026-09-18。生产执行版本：`e8f42f2015346536d178fb1fac6b328789e6619e`。

本文记录已经执行的结果，不把历史报告中的 TODO 自动当成当前缺陷，也不把账号域验收
扩张成所有 Provider 的在线推理、HarmonyOS UI 重设计或 Node→Go 正式入口切流完成。

## 1. 真实生产迁移已完成

本次不是只运行模拟数据或副本。停止前确认 HTTP 推理队列、WebUI active runs 和任务列表
均为空；生成新的真实计划，通过原有跨进程独占锁和原生数据库占用检查后执行。

| 验收项 | 生产结果 |
|---|---|
| 迁移对象 | 4 个既有身份：2 个 Codex、2 个 Grok；冲突 0 |
| 主库引用更新 | 45,888 行；不是新增账号，也不是调用次数 |
| 账号图 | 本次新计划迁移前 32、迁移后 32；保留 4 个原数字别名、Provider 与创建时间 |
| 数据库范围 | 29 张表；提交后完整逻辑指纹与预期一致，排除的仅是本次提交标记 |
| 用量记录 | 770,475 条，迁移前后相同 |
| 聊天事件 | 151,562 条，迁移前后相同 |
| 文件与地址 | 6 个配置文件、10 处路径移动；2 个原生 SQLite、3 条 rollout 路径 |
| 原生会话读回 | 3 条路径命中预期行数，并能实际打开对应文件；不输出会话正文 |
| 完整性 | SQLite `quick_check=ok`；外键违规 0；旧账号身份记录 0 |
| 后续重新规划 | 待迁移身份 0、阻塞 0；维护门禁已释放 |
| 服务恢复 | `/readyz` 就绪；运行时账号池从 25 恢复为 25；Server 配置哈希未变 |
| 宿主 Codex 配置 | 默认 `model_provider=openai`；`model_providers.aih_server` 定义仍存在 |
| Go 账号库 | 只读核对 `aih.db` 的 `accounts` 仍为 0；无需迁移现有 Go 账号，未复制 Node 账号或切流 |

前一晚副本有 29 个账号，本次新计划已有 32 个，不能把两个不同时刻的快照相减并归因给迁移。
同样，数据库账号总数和可进入 Server 运行时池的账号数不是同一个统计口径。

服务恢复后的延迟只读核对也通过：Codex 8 个记录中 3 个 OAuth 为 `already_current`、
5 个 API Key 为 `not_applicable`；Grok 2 个均为 `already_current`。没有因后台恢复重新生成旧身份。

本次事务编号为 `93749a1e-4586-485a-9d12-ed6f5b0a8377`。原始计划和主库、原生库、
配置备份及持久日志保留在本机 `~/.ai_home/migration/` 的 owner-only 目录中，不提交到 GitHub。
恢复只接受已确认摘要与已知前后状态；生产开始产生新写入后，旧备份不被当作可无条件覆盖的快照。

生产执行保留成功的新状态，**没有为了演示回滚而回退生产账号**。此前完整真实数据副本已完成
迁移→回滚，重新生成的主库、文件、原生库计划摘要与初始摘要完全一致。

## 2. 维护过程中保留了什么

首次占用检查发现旧前台 AIH 包装进程长期持有数据库连接。没有杀原生任务、关闭 tmux server
或重建会话：先确认同一 exact session 的替代客户端已连接，再只脱离旧前台客户端。
四个原生 pane 的 session ID、PID 与存活状态保持不变。替代连接使用系统 Terminal，
不是宣称原 Warp 前台窗口外观完全未变。

重复进入的前台客户端同样只在已有替代连接、原生 pane 身份不变时脱离。长时间只读规划前
先取得现有真实独占租约，规划完成后同步交给同一生产迁移服务重新取得租约；竞争仍由 OS 锁
决定，不传测试 `assertQuiet`，不关闭占用检查，不使用强制迁移开关。

前一轮还检查过三个账户级后台 Codex engine：无 attached client、无 loaded thread、无
已建立 TCP 连接，才对 exact owned PID 发 SIGTERM。本次成功执行未再终止任何原生 backend。
停服、验证与恢复总计约 259 秒；这不是零停机承诺。

两个先前尝试分别被真实占用和过期计划保护拒绝，并恢复了服务。最终修复是明确区分
受迁移影响的权威事实和其他账号的派生活跃观测，而不是清空观测文件来凑一致性。
详细机制见 [native-store closure](account-maintenance-native-closure.md)。

## 3. 对照补充的三份历史材料

### 3.1 CodeBuddy 家族「额度探测闭环」评审

该报告自述 HEAD 为 `dd90ee4d`，是历史材料；其百分比和上游 HTTP 实测不作为本次实时额度。

| 原材料中的项目 | 当前代码/证据 | 裁决 |
|---|---|---|
| 独立国内发行件写 `Tencent-Cloud.coding-copilot.info` 却无法捕获 | `29795c88` 的 realm、subject、domain 校验；主凭据文件之外发现国内 standalone 文件；捕获、注册、物化、跨分发件续期有测试 | 已实现，旧 TODO 已过期 |
| App 新登录凭据反向同步 | 同主体按 credential-origin 时间及 CAS 采纳；不同人、不同国际 realm 不合并，旧/歧义凭据不覆盖 | 已实现 |
| 家族详细 `usage` 只打印 JSON | `credit-format.js` 已输出账户聚合及每包明细；缺字段显示 unknown，不补 100% | CodeBuddy 四支已实现；不是所有未知快照自动格式化 |
| 四支额度探针与 trusted 闸门 | 同一 `codebuddy_credit_balance` 与 source；aggregate/detail 分工保留；运行时池没有家族槽位仍可出现在账号列表 | 当前合同与相关回归通过；本轮未再次请求真实上游余额 |
| WorkBuddy 新会话 / `codebuddy --serve` | 当前合同仍是桌面创建；CodeBuddy CLI 续聊与 WorkBuddy desktop-only 边界不合并 | 保持明确产品边界，不假报新 API 已集成 |
| `provider-usage-policies` 与 Go Preview | 不为补齐表格而把未知投影伪造成可用额度；保留现有调度/Preview边界 | 不作越界功能扩张 |

本轮重新运行 `codebuddy-credential-source`、`codebuddy-quota-probe`、`usage.credit-format`、
`webui-account-live`：**75/75 通过**。这些是当前代码、合成凭据与临时数据库的验收，
不复用旧报告中的真实 16.67% 或国内余额来冒充实时结果。

### 3.2 Codex/Claude/AGY OAuth 身份对齐报告

| 原材料中的项目 | 当前结论 |
|---|---|
| R7/T1：真实 Codex rekey 待授权 | 已在生产完成；同时完成有明确账本的 Grok 迁移 |
| T2/T5：Grok 优先级及 Provider 参数化 | 已交付并执行；不是静默修改既有身份 |
| T6：Kimi/ZCode/CodeBuddy 的邮箱或 token 兜底 | 已以稳定主体策略替换；不可核验时拒绝，不制造轮换账号 |
| R9/T7：其余 Go Provider 尚未实现 | `957ecc02` 已覆盖全部 15 个具体标识的原生账号域；共享契约和 SQLite 注册、读回、续期、篡改测试通过 |
| R8/T4：现有 Go `aih.db` 迁移 | 本机 Go 账号数为 0，明确不适用；不通过双写或导入生产 Node 数据制造一个“完成” |
| Kiro 取证 | 已有固定协议来源、token-bound identity evidence、取消及代次检查；合成原生 SQLite/传输测试通过。**本轮没有当前 Kiro 在线账号的实测证明** |

Go 账号域已实现不代表正式 Node CLI、9527 网关或默认 WebUI 已切到 Go。已交付范围和
明确限制以 [extended Go native accounts](extended-go-native-accounts.md) 为准。

### 3.3 功能矩阵与依赖策略

原材料是有日期的功能基线。当前矩阵需要保留正式 Node、隔离 Go Preview、可读历史、
原生创建与外部 runtime 之间的区别。本次只更新已核实的账号迁移结果与家族额度列，
不把所有 `受限`、`实验` 或 `未迁移` 一律改成完成。

关于旧报告的 `smol-toml` 锁漂移，进一步核对发现：`11def7c1` 已明确移除根与 Web 锁文件，
`.gitignore` 要求各客户端本地生成，CI 改为 `npm install`。因此本机遗留旧锁缺依赖，
**不等于当前仓库漏提交了一个必须跟踪的锁**。

本机遗留锁在隔离目录通过离线 `npm install --package-lock-only --ignore-scripts` 更新，
只有根声明与 `smol-toml@1.3.1` 条目变化；随后离线 `npm ci --ignore-scripts` 从空目录安装
96 个包并验证 TOML 可解析、models 包仍为 0.0.71。生成结果只修正本地忽略文件，未重新跟踪锁。

额外的“仅 manifest、没有锁、完全离线安装”尝试因缺少 registry 元数据缓存而返回
`ENOTCACHED`，不伪装成成功。干净 GitHub checkout 的正式 `npm install` 和完整测试已经通过。
未提交强制 lockfile 的实验测试，也未把 CI 改回与现有决策冲突的 `npm ci`。

## 4. 可复核的代码与验证

- `2edc4417`：原生 SQLite participant、备份、提交标记恢复、精确路径策略与公开维护命令。
- `e8f42f20`：无关活跃观测范围、策略版本化、旧日志严格兼容。
- 后者精确 staged tree `4053d2aa653aa42fce928767fed817951a6f4ac6` 的隔离 Node22 全量：
  **7,506 项；7,461 通过、0 失败、45 项明确跳过**。
- 同一范围的原生/恢复专项 **77/77**，Node26 策略专项 **7/7**。
- `e8f42f20` 的 GitHub 完整 CI：[`35295861536`](https://github.com/madou1217/ai_home/actions/runs/35295861536) 通过；Web lint/build：[`35295861589`](https://github.com/madou1217/ai_home/actions/runs/35295861589) 通过。

本轮不新增生产代码依赖或切换 Provider 协议。独立原生 reviewer 的调用此前因账号额度返回
错误，未产出审查报告；因此记录为显式授权下的自审、反例、故障注入和真实数据验收，
而不是冒充独立审查通过。

| 文件/模块 | 模式 | 用途 | 验证 |
|---|---|---|---|
| `rekey-native-participant` | Saga participant + compensation | 原生 SQLite 与主库/文件的分步提交及恢复 | 丢失提交确认、二次中断、关闭失败测试；真实副本及生产读回 |
| `rekey-live-observation-policy` | Scoped Strategy | 无关派生观测不阻塞目标身份事务，目标引用仍严格 | 旧/新/转义身份、未知字段、元数据、旧日志兼容测试 |
| `rekey-consistency` | 独立校验适配器 | 比较完整前后事实，不只看成功返回或行数 | 主库指纹、原生读回、外键与数字别名验证 |
| 本轮文档核对 | 无新模式 | 文档纠偏不需要新增框架或重复实现 | 历史提交、现有测试、安装策略与实际回执交叉核对 |


## 5. 收尾实测发现并修复：未知额度误判耗尽

通过公开 `evaluateProviderModelUsage` 边界复现：Codex、Claude、Gemini、AGY、Kimi
快照条目 `remainingPct: null` 都被提前执行 `Number(null)` 转成 0，结果为 `exhausted`，
使模型账号索引把尚无额度证据的候选账号排除。此前测试覆盖“没有对应桶”，未覆盖“有桶但值为空”。

修复复用 `provider-usage-policy.js` 的数值归一化边界，策略读取桶与账号摘要时不再提前强转。
空值、空串、布尔值和容器不能证明耗尽；真实数字 0 和数值字符串 `"0"` 仍然耗尽，
数值字符串兼容及原有范围裁剪不变。未知桶不会把同模型的已知健康桶拖成零；另有真实零桶仍阻止路由。
这不绕过独立的账号启停、凭据无效或实际上游限额状态。

新增 `test/provider-usage-unknown.test.js` 的 19 项用例在旧代码上 14 项失败，修复后
19/19 通过；包含两种真实模型索引入口的 unknown/zero 分离，不只测试私有帮助函数。
加上原有策略及索引测试，Node22 定向 33/33 通过；Node26 新增用例 19/19 通过。
Go 侧已有显式 `AvailabilityUnknown` 和“只有 exhausted 才生成 quota block”的独立合同，
不把 Node 的动态类型补丁复制进 Go 账号库。

模式：`provider-usage-policy.normalizeRemainingPct -> shared normalization boundary ->`
在类型信息丢失之前保留 unknown，策略层复用而不重复实现 -> 五 Provider、摘要回退、
混合桶及两种模型索引的反例和正向用例。没有新增依赖或改变额度上游接口。
