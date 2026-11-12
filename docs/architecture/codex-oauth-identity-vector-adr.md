# ADR：OAuth 身份向量与 Go 对齐（Codex / Claude / AGY）

> 文件名保留 `codex-oauth-identity-vector-adr.md` 是历史原因：Codex 是触发这份决策的案例，
> 已有链接都指向它。文档范围后来扩到 Go 侧已实现身份派生的**全部三个 Provider**
> （`core/accounts/` 下只有 `codex`、`claude`、`agy`），因为它们是同一类问题的同一批核对。

- **状态**：Codex 已实施（Implemented）。Node 已切到 `user_id` 向量；rekey 的账本、dry-run 与
  apply 均已落地并测试；**对真实数据的 apply 仍待操作者复核账本后执行**。
  Claude 的三个分歧已修并钉住；AGY 的校验强度已对齐，但其「以邮箱为身份」本身仍是待裁决的
  §8.1 例外（见文末）。
- **日期**：2026-09-16
- **依据**：`product-direction-node-go-2026-08-15.md` §8.1「身份与迁移」
- **触发**：`go-node-parity-matrix.md` 把 Codex 那条列为「唯一需要决策的项」；
  用户 2026-09-16 选择「写 ADR + 显式 rekey」，随后要求「直接闭环」。

## 背景

两端 `accountRef` 的派生算法**逐字节一致**：

```text
accountRef = "acct_" + sha256("unique:" + identitySeed)[:20]   // 十六进制
```

差异只在 `identitySeed`：

| 端 | 身份向量 | 实现 |
| --- | --- | --- |
| Go | `oauth:codex:<user_id>` | `core/accounts/codex/account_profile.go:121`（`oauthIdentitySeed`） |
| Node | `oauth:codex:<email>` | `lib/account/account-identity.js:425`、`lib/account/transfer-core.js:117`、`lib/server/codex-app-server-account-identity.js:56` 与 `:91` |

后果：同一个 Codex 账号在两端得到**不同的 `accountRef`**。跨端同步、导入导出、WebUI 默认账号、
launch profile 目录名、持久会话登记和使用量归属都会因此对不上。

## 决策

**统一到 `user_id`。Go 侧不改，Node 侧改。**

## 判据

不是「跟 Go 走」——§8.1 已经写死了这条约束，而 Node 现行的 email 向量**两条都违反**：

1. §8.1：「`accountRef` 是持久账号主键，创建后**不因邮箱变化**而改变。」
   以 email 为身份字段意味着邮箱一变 `accountRef` 就变，直接违反。
2. §8.1：「OAuth 使用版本化的 Provider 专属身份策略，**稳定字段必须存在**；缺失时返回
   `identity_unverifiable`，**不得回退邮箱**、目录名或随机值。」
   Node 的 email 是**主字段**，不只是回退，违反程度更重。
3. §8.1 末段已经点名否定过这条旧规则：「这里刻意不沿用『OAuth 恒等于 `provider + email`』
   的旧规则：仅按邮箱会错误合并真实不同的账号。」

### 一条比「email 会变」更严重的证据

Node 的 email 取值链（`lib/account/transfer-core.js:119-128`）**优先读存储字段**：

```text
payload.email → nestedAuth.email → credentials.email → config.email
→ meta.email → metadata.email → id_token.email → access_token.email
```

前六个都是**本地存储的邮箱**，只有最后两个才解 JWT。也就是说 Node 的 `accountRef`
可能**不由上游事实决定**：一条凭据记录的 `email` 字段过期、被手改、或由旧版本写入成别的值，
同一个账号就会派生出不同的 `accountRef`。这不是「email 可变」的推论，是取值链本身的性质。

### 这条不是「Node 拿不到稳定字段」

Node **已经**从 JWT 解出了稳定字段，只是身份没用它们——`lib/account/codex-auth-metadata.js:68-69`：

```js
chatgptUserId: String(authClaim.chatgpt_user_id || authJson.chatgpt_user_id || '').trim(),
userId: String(authClaim.user_id || '').trim(),
```

所以改动量小，且不需要新增 JWT 解析。

## 具体改动点

### Go（不改）

- `core/accounts/codex/account_profile.go:121` — `oauthIdentitySeed`，向量 `oauth:codex:<user_id>`。
- `core/accounts/codex/jwt.go:63` — 取值链 `chatgpt_user_id` → `user_id` → `sub`。
- `core/accounts/codex/jwt.go:302` — `isIdentityComponent`：拒绝空/空白、含 `:`、含
  `utf8.RuneError`、含控制字符。**非法即 `identity_unverifiable`，不回退邮箱。**
- `core/accounts/codex/oauth.go:90` — 唯一使用点。

### Node（已改）

**身份向量构造**，四处必须同时改，漏一处就会出现「同一个账号两个 `accountRef`」：

| 位置 | 改动 |
| --- | --- |
| `lib/account/codex-auth-metadata.js` | 新增 `buildCodexOAuthIdentitySeed` / `resolveCodexIdentityUserId` / `isCodexIdentityComponent`（唯一实现） |
| `lib/account/account-identity.js` | codex 分支走新向量，且必须放在通用 email 分支**之前** |
| `lib/account/transfer-core.js` | `buildOAuthIdentity` 对 codex 直接返回新向量 |
| `lib/server/codex-app-server-account-identity.js` | 期望身份用新向量；app-server 自报的**邮箱**改为与凭据邮箱直接比对，不再绕身份哈希 |

**第五处（实现时才暴露出来的）**：`lib/account/standard-transfer.js` 的
`buildFlatAccountExportFileName` 原本要求 `buildOAuthIdentity('codex', auth)` 非空——那对
codex 等价于「邮箱存在」。身份换成 user_id 后，这条闸门会**误封**凭据里没有 id_token 的账号，
用户连备份都做不了。已改为：codex 的导出标签优先用邮箱、缺失时回落到 `accountRef` 后缀，
不再复算身份向量——导出是「搬走一个已注册账号」，它的稳定身份就是 `accountRef`；
「身份不可派生」该由 rekey 工具报告，不该由导出拒绝。

**app-server 自报邮箱那一处值得单独记**：`account/read` 只会自报邮箱，所以它和身份向量必须
分开——否则身份改成 user_id 之后，这道校验闸门会对**每个**账号恒失败。改动前的
`sha256('oauth:codex:' + email)` 两边对比等价于直接比邮箱，因此改成直接比邮箱在语义上是等价的，
只是把「这个进程是不是那个账号」与「账号身份怎么派生」解耦了。顺带删掉了因此变成死代码的
`sameHash`（邮箱不是秘密，常量时间比较没有收益）。

## Rekey 程序

§8.1 要求「必须生成显式映射账本：`old_account_ref -> account_ref + resolution`」。

### 已落地的工具

- **共享身份向量模块**：`lib/account/codex-auth-metadata.js` 的
  `buildCodexOAuthIdentitySeed` / `resolveCodexIdentityUserId`，复刻 Go 的取值链与校验
  （`chatgpt_user_id` → `user_id` → `sub`；拒绝含 `:`、控制字符、U+FFFD、trim 后为空）。
- **跨语言钉住**：`contracts/codex-oauth-identity.json` 是两端共读的 15 条向量，
  由 `test/codex-oauth-identity-vector.test.js` 与
  `core/accounts/codex/oauth_identity_contract_test.go` 各自跑一遍。种子差一个字符会直接
  失败，而不是静默铸出第二个账号。
- **账本 + dry-run + apply**：`lib/cli/services/account/codex-identity-rekey.js`，驱动脚本
  `scripts/codex-identity-rekey.js`。默认 dry-run，只写账本、不动账号；`--apply` 需要
  `--confirm-apply`，且账本有任意阻塞项就拒绝执行。

定性不靠猜凭据形状，而是**直接复算两条向量**（拿凭据里的邮箱复算旧 ref、拿稳定 user_id
复算新 ref），再与落库的 `accountRef` 比。四种结果：`already_current` / `migrate` /
`conflict` / `unverifiable`（外加 `unrecognized`，用于既不属于任何已知向量的账号）。

重写**按构造完整**：`apply` 枚举 SQLite schema，重写每一个名为 `account_ref` 的列，
而不是靠手工维护的表清单——新增一张带该列的表会自动进入重写范围，不会静默留下过期引用。
`account_cli_aliases.account_ref` 是 `account_refs` 的外键且没有 `ON UPDATE CASCADE`，
所以 `PRAGMA foreign_keys` 必须在 `BEGIN` **之前**关闭（它在事务内是 no-op），提交前再跑
一次 `foreign_key_check` 兜底。

### 操作顺序（不可交换）

1. `node scripts/codex-identity-rekey.js` —— 只读，产出账本到
   `<ai-home>/migration/codex-identity-ledger.json`。
2. **人工复核账本**，逐条裁决冲突。
3. `node scripts/codex-identity-rekey.js --apply --confirm-apply --ledger <path>`。

**仍待操作者执行的**：第 3 步针对真实数据。仓库里没有真实数据，盲目跑一遍正是 §8.1 禁止的
「静默改变既有 accountRef」，所以工具把这一步留给复核过账本的人。

### 唯一不可逆的部分

**合并方向会反转。** email 向量下，「同一个 `user_id`、不同 email」的凭据会被拆成两个账号；
`user_id` 向量下它们会**合并成一个**。§8.1 说「仅按邮箱会错误合并真实不同的账号」——
换成 `user_id` 后，风险变成反方向的「错误合并同一用户的多条记录」。

因此工具把它判为 `conflict` 并**拒绝 apply**，绝不自动合并；`unverifiable` 与
`unrecognized` 同样阻塞执行，因为部分迁移会把账号体系留在「一部分旧 ref、一部分新 ref」
的分裂状态，比不迁移更糟。

### 已知的未覆盖项

`aih.db`（Go 侧的账号库）不在本工具的写入范围内：它由 Go 拥有，重写它属于 Go 的迁移职责。
Node 侧先迁完再对齐 Go，顺序不能反——反了会让 Go 按旧 ref 找不到已迁移的账号。

## 影响面

所有已存在的 Codex OAuth 账号 `accountRef` 都会变。引用它的地方必须在同一窗口内重写：

- WebUI 默认账号 / 移动端默认（`provider_defaults`）
- launch profile 目录名（`getProfileDir('codex', accountRef)`）
- 持久会话登记（`persistent_session`）
- 使用量归属与额度快照
- Node 侧 `lib/server/account-ref-store.js` 的映射

## 本 ADR 不授权的事

- **不授权直接在生产上执行 rekey**。执行需要单独的排期与 dry-run 结果。
- 不授权改 Claude 的**向量**（已是 `account_uuid`，合规）。本批只修了它的**归一化与校验**，
  因为那是「同一份 UUID 得到两个 accountRef」的直接原因。
- 不授权把 AGY 的邮箱向量换成别的字段——没有更稳定的字段可用；那条需要先有上游证据，
  见上文的「待裁决的 §8.1 例外」。
- 不授权顺手改 email 在**导入关联与冲突提示**里的用法——§8.1 明确保留：
  「规范化邮箱只用于导入关联与冲突提示」。
- 不授权引入「按邮箱回退」的兜底：缺失稳定字段就报 `identity_unverifiable`。

## 同批核对：Claude 与 AGY

Codex 修完后，同一类问题在 Go 侧仅有的另外两个 Provider 上继续核对。两个都是**实测**得出结论，
不是读源码推断——这一步很关键，我第一次对 Claude 的假设（「Node 优先用邮箱」）就是错的。

### Claude：向量本身是对的，**归一化**错了（已修）

§8.1 的表格规定 Claude OAuth 用 `account_uuid`，两端都照做了。但**同一份 UUID 会被归一化成
不同结果**，所以同一个账号在两端仍会派生出不同的 `accountRef`。三处分歧，实测确认：

| 输入 | Go | Node（改前） | Node（改后） |
| --- | --- | --- | --- |
| `1FB09D73-…`（大写） | 小写 → 同一个 ref | **保留大写 → 不同的 ref** | 小写 |
| `" uuid "`（带空白） | 拒绝 | trim 后接受 | 拒绝 |
| `not-a-uuid` | 拒绝 | 接受 → 铸出假身份 | 拒绝 |

第一行是最严重的：它不是「坏输入被接受」，而是**好输入得到两个账号**。

另外关掉了一条**潜伏**分歧：Node 的通用 email 分支排在 uuid 分支之前，所以当凭据里带
`claudeAiOauth.email` 时 Node 会走邮箱向量。仓库自己写凭据时把邮箱放在
`account.emailAddress`，所以这条路径在生产里够不到——但它够得到，而且一旦够到就违反 §8.1。
已把 claude 分支提到 email 分支之前，并且**不回退邮箱**（缺 UUID 即 `identity_unverifiable`）。

### AGY：邮箱就是身份，是待裁决的 §8.1 例外

AGY 的原生 `oauthToken` 文档里**没有** user id 或 uuid，只有邮箱。所以它不是「选错了字段」，
而是**没有更稳定的字段可选**。两端一致（都是 `oauth:agy:<email>`），所以这不是对齐 bug。

真正的分歧在**校验强度**：Go 的 `normalizeEmail` 会拒绝非邮箱形状的值，Node 原先只做
trim + lowercase，于是能铸出 `oauth:agy:no-at-sign` 这种 Go 直接拒绝的种子——即
「Node 能建、Go 永远寻址不到」的账号。已对齐，并且**逐条实测**过 Go 的行为：

- Go 的规则实际是 RFC 5322 的 dot-atom 加上 `mail.ParseAddress` 的宽松处；
- 接受 `user@localhost`（不要求域名有点）、`user+tag@…`、`user@[127.0.0.1]`（地址字面量）；
- 拒绝 `a:b@…`、`a..b@…`、`.a@…`、`a.@…`、`"a b"@…`、`a@c.com.`、`@…`、`a@`。

Node 侧现在用 dot-atom + 地址字面量镜像这套规则，19 条实测向量全部一致。
**残留**：Go 的解析器还接受极少数真实登录不可能产生的形态（例如带转义字符的 quoted local part）。
两边不一致时 Node 选择**拒绝**——失败方向是关闭的（拒绝铸身份），而不是开放的（编一个 Go
不会产生的身份）。

### 为什么 AGY 的例外要单独裁决

§8.1 第一条要求「`accountRef` 创建后不因**邮箱变化**而改变」，而 AGY 的身份**就是**邮箱，
邮箱一变 ref 就变。这是已知的、无法在现有上游字段下消除的张力。它需要的是
「上游是否提供更稳定字段」的证据，而不是一次重构——所以这里如实记录，不擅自改。

### 三份契约

| 契约 | 用途 |
| --- | --- |
| `contracts/codex-oauth-identity.json` | Codex 的 15 条向量（claim 顺序、trim、各拒绝分支、**邮箱永不成身份**、**只认 ID Token**） |
| `contracts/claude-oauth-identity.json` | Claude 的 10 条向量（大小写、未 trim、UUID 形状） |
| `contracts/agy-oauth-identity.json` | AGY 的 17 条向量（邮箱形状校验强度） |

三份都由 Node 与 Go 各自的测试读同一文件。共用的原语在
`lib/account/identity-components.js`——**只有一份实现**，因为「Go 的 TrimSpace 与 JS 的 `\s`
不是同一套空白集」这种细节，抄第二遍就一定会漂。

## 参考

- `docs/architecture/product-direction-node-go-2026-08-15.md` §8.1
- `README.md`「导入 / 导出去重规则」
- `docs/architecture/codex-native-credential-sync.md`
- `docs/architecture/go-node-parity-matrix.md`「唯一需要决策的项」
