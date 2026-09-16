# Provider review 交付记录 — 2026-09-16

## 本次已实现并验证

本记录对应 `codebuddy-family-quota-loop-review.md` 与 `oauth-identity-alignment-review.md`
中的具体审查缺陷，不把两个文档列出的 Go 全域扩展或破坏性真实账号迁移自动计为已执行。

### A. CodeBuddy / WorkBuddy 原生凭据与余额链路

- 四个产品/站点的主认证文件按已知 issuer、domain、uid/sub 校验。文件名不决定地区。
  国内独立 CLI 的 `Tencent-Cloud.coding-copilot.info` 现在可被捕获；国际同名文件不能误入 CN。
- `.info` 完整性/大小/符号链接/读前后状态均有检查。校验是本地来源一致性检查，
  **不是 JWT 签名验证**；上游仍负责认证。
- iat 优先、双方可比 lastRefreshTime 次之；文件 mtime 不决定凭据新旧。
  身份或签发方不同不互换，时间相同但令牌不同不猜测覆盖。
- 复用既有账号引用并 CAS 写入；独立 App 更新经 Server 生命周期回收，既有同授权 CN
  产品账号同步更新。国际 CodeBuddy/WorkBuddy 即使 uid 相同也保留各自授权。
- 捕获、注册、投影、宿主同步、后台观察与额度读取接线完成。账号在 DB 已有可验证凭据时，
  不再要求先启动一次 CLI。删除标记阻止自动重新登记；更新通知失败会重试。
- 10085 WAF 403 不再标为认证失效。配额返回期间凭据发生变化则拒绝发布旧结果。
- 多包汇总要求每个维度完整，缺字段或混合单位保持 unknown；不把一个包的余额除以
  另一个包的总额。付费徽章要求 IsPaidUser=true。CLI usage 输出格式化总量和明细。

### B. WorkBuddy 新建 / 续聊

- macOS 仅从所选 WorkBuddy 桌面发行版的内嵌 CLI 启动，验证 product.json 的 authentication.id。
  不用 PATH 上另一个产品的 CodeBuddy 偷换，未安装对应 App 时返回明确缺失错误。
- 原生新建与 exact resume 已接入现有 Node native-session 链路；保留产品历史软链接和账号 HOME 隔离。
  四个家族成员的 stream-json 现在进入解析器，避免被通用空分支丢弃。
- WebUI 后端普通消息进入 headless 流，而非误开交互终端。未给 WorkBuddy 声明独立可安装 CLI。
- 官方 `--serve` / ACP 评估：已安装 bundle 声明 REST/HTTP-SSE 与 ACP stdio；
  本机隔离启动的 ACP initialize 返回协议1、loadSession/image/mcp能力。
  仅带模拟无效凭据的 session/new 未完成，因此不把该实验称为真实服务端会话成功。
  本次选择复用已有 --print 子进程通道，不新增长驻开放端口，不使用 --auth none，
  不自实现/绕过 sidecar bootstrap。REST/ACP 不是本次生产数据面。
- 真实子进程/临时文件的生产 runner 夹具已验证两站各自 new → 流式结果 → 读取历史 → 同ID resume；
  子进程是明确标注的测试实现，**不是供应商真实在线推理验收**。

### C. Codex rekey 安全

- 账本版本2：包括源数据库账号/凭据指纹，重新计算统计，不信任手改 summary。
- 规划器只读数据库；既有目标身份先参与占用检查，API-key 标为不适用。
- 事务中复核映射、凭据版本与别名；改变后拒绝旧账本。外键延期到提交前检查，
  唯一键冲突、JSON键冲突、未处理引用均导致整事务回滚。
- 精确标量、结构化JSON值/键、app_kv命名空间键覆盖；不把自由文本路径盲目替换。
- 根 hook 配置、运行目录和路径中的旧账号引用属于阻塞项；不虚称仅改数据库即可完成迁移。
- dry-run 账本权限0600、原子写入。真实数据已 dry-run：8个Codex，1已新向量、5 API-key不适用、
  2可迁移、0身份冲突；存在外部运行引用与嵌入式路径，**未对生产执行 apply**。
- 修正 pending OAuth 成功测试夹具：使用已上线的稳定 user_id，而非仅 email；原有成功/原子性断言不变。

## 验证

- `node --test test/codex-identity-rekey.test.js test/codex-rekey-safety.test.js test/pty-runtime.test.js`：194/194。
- CodeBuddy凭据/配额/原生投影/宿主/后台相关：137/137。
- native-session / WorkBuddy / provider runtime相关：137/137；生产子进程链路追加2/2。
- Node 22.16.0 完整 `npm test`：7325项，7281通过，0失败，44跳过。
- Web `bun test web/src`：524通过、0失败；没有修改web源码。
- models SDK离线一致性检查通过；Go core/providers、providerlaunch、providercli三包通过。
- 远程CI结果在最终交付状态中记录，不把跳过的native smoke说成运行成功。

## 尚不能自动执行的操作，不以代码交付代替数据审批

- 真实rekey必须先处置账本所列活动/外部引用，给出停写、备份和映射计划；不能为清空TODO破坏旧线程。
- Kiro本机两处已知原生存储均不存在，AIH账号库也没有Kiro账号；无真实材料可证明新的稳定身份字段。
  不编造JWT字段或把旋转token哈希重新命名为稳定身份。
- Grok真实载荷同时存在user_id/principal_id/email；原规格已知优先级问题属独立身份版本迁移，
  本次不在后台凭据修复里静默改写现存Grok账号引用。
- 其余9个Provider的Go完整账号域属于原评审明确标注的范围扩张，Go aih.db也仍由Go迁移链拥有。
  本次没有切换正式CLI/Web/Server ownership，也没有创建虚假Go provider空实现。

## 模块、边界与审查

- codebuddy-credential-source → 策略/纯校验函数 → 一个来源归属/新旧比较口径 → 文件与身份回归。
- codebuddy-credential-sync → 观察者 + CAS → 回收外部变化而不覆盖新版本 → 实际SQLite/删除/通知重试回归。
- native-session/workbuddy-native-cli → 既有适配器 + 工厂解析 → 复用原生管线且固定发行版 → 子进程与流式回归。
- codex-rekey-storage/rekey → 计划-应用分离 + 事务 → 拒绝过期或不完整迁移 → 账本篡改/冲突/回滚测试。

使用已有SQLite、Provider目录、投影机制，无新依赖，无影子账号表，不改人工启停与全局默认。
当前没有独立reviewer；采用有负向与端到端夹具的自审，用户已授权限定范围修复和提交推送。
