# ADR：Codex OAuth 身份向量统一到 `user_id`

- **状态**：决策已定（Accepted）。**rekey 未执行**，需按 §「Rekey 程序」排期。
- **日期**：2026-09-16
- **依据**：`product-direction-node-go-2026-08-15.md` §8.1「身份与迁移」
- **触发**：`go-node-parity-matrix.md` 把这条列为「唯一需要决策的项」；用户 2026-09-16 选择
  「写 ADR + 显式 rekey」。

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

### Node（改）

**身份向量构造**，四处必须同时改，漏一处就会出现「同一个账号两个 `accountRef`」：

| 位置 | 现状 |
| --- | --- |
| `lib/account/account-identity.js:425` | 通用 `oauth:${provider}:${email}`（codex 走这条） |
| `lib/account/transfer-core.js:117-129` | `extractOAuthEmail` 的 codex 分支 |
| `lib/server/codex-app-server-account-identity.js:56` | 期望身份的 `identitySeed` |
| `lib/server/codex-app-server-account-identity.js:91` | app-server 自报身份的 `actualIdentityHash` |

**claim 提取**（`lib/account/codex-auth-metadata.js:68-69`）需与 Go 对齐两处：

- 补 `sub` 回退（Go 的第三级，Node 现在没有）。
- `userId` 现在**只从 `authClaim` 读**，而 `chatgptUserId` 同时读 `authClaim` 和 `authJson`。
  Go 的取值链在两类 claim 上是统一的，Node 需补齐。

**校验**：Node 需要 `isIdentityComponent` 的等价物（现有 `normalizeEmail` 只做
`trim().toLowerCase()`，不拒绝 `:`/控制字符）。缺失或非法一律 `identity_unverifiable`。

## Rekey 程序

§8.1 要求「必须生成显式映射账本：`old_account_ref -> account_ref + resolution`」。
**该账本目前在仓库里只以散文形式存在，没有任何实现**，因此它是本 ADR 的前置交付物。

落地顺序（不可交换）：

1. **先建账本**，单向，格式 `old_account_ref -> new_account_ref + resolution`。
2. 对每个 Codex OAuth 账号，用其**当前凭据**同时算出 old（email 向量）与 new（user_id 向量）。
3. **三态裁决**：
   - `new` 不存在 → 迁移。
   - `new` 已存在且指向同一个 old → 无需动作。
   - `new` 已存在但对应**另一个** old → 冲突，**逐条人工裁决，不自动合并**。
4. 禁止：双写、回读 fallback、影子账号表（§8.1 明文）。
5. 回滚：账本保留 old 向量，可按 ledger 反向重放。

### 唯一不可逆的部分

**合并方向会反转。** email 向量下，「同一个 `user_id`、不同 email」的凭据会被拆成两个账号；
`user_id` 向量下它们会**合并成一个**。§8.1 说「仅按邮箱会错误合并真实不同的账号」——
换成 `user_id` 后，风险变成反方向的「错误合并同一用户的多条记录」。

因此第 3 步的冲突分支**必须人工确认**，这是整条迁移里唯一不能自动化的地方。
迁移前必须先跑一次 dry-run，把冲突清单列出来。

## 影响面

所有已存在的 Codex OAuth 账号 `accountRef` 都会变。引用它的地方必须在同一窗口内重写：

- WebUI 默认账号 / 移动端默认（`provider_defaults`）
- launch profile 目录名（`getProfileDir('codex', accountRef)`）
- 持久会话登记（`persistent_session`）
- 使用量归属与额度快照
- Node 侧 `lib/server/account-ref-store.js` 的映射

## 本 ADR 不授权的事

- **不授权直接在生产上执行 rekey**。执行需要单独的排期与 dry-run 结果。
- 不授权同时改 Claude 的身份向量（已是 `account_uuid`，合规）。
- 不授权顺手改 email 在**导入关联与冲突提示**里的用法——§8.1 明确保留：
  「规范化邮箱只用于导入关联与冲突提示」。
- 不授权引入「按邮箱回退」的兜底：缺失稳定字段就报 `identity_unverifiable`。

## 参考

- `docs/architecture/product-direction-node-go-2026-08-15.md` §8.1
- `README.md`「导入 / 导出去重规则」
- `docs/architecture/codex-native-credential-sync.md`
- `docs/architecture/go-node-parity-matrix.md`「唯一需要决策的项」
