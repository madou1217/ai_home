# OAuth 身份向量规格（Node 为参考实现）

> 2026-09-16 修订：Grok 已改为稳定 ID 集合向量，不再让邮箱优先，也不以令牌降级创建账号。
> `scripts/oauth-identity-rekey.js --provider grok` 提供显式 v2 账本与事务迁移；
> 原生重登按实际身份匹配并沿用旧引用，不在后台静默 rekey。
> 历史分析保留在下文；当前可执行合同见 `test/grok-stable-identity.test.js`，
> 全部交付状态见 [交付记录](../maintenance/provider-review-delivery-20260916.md)。

> 这份文档存在的原因很具体：**Go 目前只为 `codex`、`claude`、`agy` 三个 Provider 实现了身份派生**
> （`core/accounts/` 下只有这三个包）。其余 Provider 的向量**只存在于 Node**。
> Go 以后实现它们时，必须逐字节照抄；否则就会重演「同一个上游账号在两端铸出两个 `accountRef`」——
> 这正是 Codex 那条 ADR 要解决的病。
>
> 表里的每一行都是**实测**得到的（喂真实形状的凭据给 `resolveNativeAuthIdentitySeed` 打印结果），
> 不是读源码推断。理由见 ADR「方法论」一节：读源码推断在本轮已经错过一次。

## 通用规则（§8.1）

1. `accountRef` = `acct_` + `sha256('unique:' + seed)[:20]`，两端必须逐字节一致。
2. 稳定字段必须存在；**缺失时返回 `identity_unverifiable`，不得回退邮箱**。
3. **凭据轮换不得改变 `accountRef`**。
4. 邮箱只用于导入关联与冲突提示。

## 已实现（Go + Node 都有）

| Provider | 向量 | 稳定字段 | 契约 |
| --- | --- | --- | --- |
| `codex` | `oauth:codex:<user_id>` | ID Token：`chatgpt_user_id` → `user_id` → `sub` | `contracts/codex-oauth-identity.json` |
| `claude` | `oauth:claude:uuid:<account_uuid>` | `claudeAiOauth.account.uuid` | `contracts/claude-oauth-identity.json` |
| `agy` | `oauth:agy:<email>` | 邮箱（无更稳定字段） | `contracts/agy-oauth-identity.json` |
| 任意 | `api_key:<provider>:<baseUrl>:<fingerprint>` | baseUrl + key 指纹 | — |
| 任意 | `auth_token:<provider>:<baseUrl>:<hash>` | baseUrl + token 指纹 | — |

## 未实现（只有 Node）

以下向量由 Node 定义。Go 实现时必须照抄前缀、取值链与哈希截断长度。

| Provider | 向量 | 取值链 | §8.1 |
| --- | --- | --- | --- |
| `gemini` | `oauth:gemini:<email>` | `googleAccounts.active`（邮箱） | ⚠️ 邮箱即身份 |
| `opencode` | `oauth:opencode:auth:<sha256(条目)[:16]>` | 每个子 Provider 的 `email`→`account_id`→`id`→`username`，排序后拼接 | ✅ |
| `grok` | `oauth:grok:auth:<sha256(身份集)[:16]>` | 每条 profile：**`email` 优先**，其次 `user_id`/`principal_id` | ❌ 见下 |
| `kimi` | `oauth:kimi:user:<hash(subject)>`，回退 `oauth:kimi:token:<hash(token)>` | `user_id`/`userId`/`sub` → JWT `sub` → token | ⚠️ token 回退会随轮换改变 |
| `kiro` | `oauth:kiro:token:<hash(refresh_token\|\|access_token)>` | 只有 token | ❌ 见下 |
| `zcode` | `oauth:zcode:user:<hash(id\|email\|jwt sub)>`，回退 `oauth:zcode:token:<hash>` | `oauth:zai:user_info` 的 `user_id` → `email` → JWT `sub` → token | ⚠️ 邮箱回退 + token 回退 |
| `codebuddy` / `codebuddycn` / 同族 | `oauth:<provider>:user:<hash(subject)>`，回退 `oauth:<provider>:<email>`，再回退 `oauth:<provider>:token:<hash>` | `user_id`/`uid`/`sub` → JWT `sub` → `email` → `account_id` → token | ⚠️ 邮箱回退 + token 回退 |
| `qoder` / `qodercn` | 由 `resolveQoderNativeAuthPayload` 专门解析；PAT-only 时 `api_key:<provider>:pat:<sha256(pat)[:16]>` | — | 未实测 |

`<hash(x)>` = `hashApiKeySecret(x)`（Node 的 key 指纹函数）。**Go 实现时必须复刻它的确切输入与截断**，
否则同一份凭据得到不同种子。

## 已实测确认的 §8.1 违规

### 1. `grok`：可变字段赢了稳定字段

```
grok (email + user_id)   -> oauth:grok:g@example.com      ← 邮箱赢了
grok (email only)        -> oauth:grok:g@example.com
```

凭据里同时有 `user_id` 时，`email` 仍然优先。这与 Codex 修复前的病**完全同形**：
一个可变字段压过了一个可用的稳定字段，于是改邮箱就换账号。

**修法明确**（调换优先级，`user_id`/`principal_id` 优先），但它是**身份向量变更**，
会改写既有 grok 账号的 `accountRef`——按 §8.1 不能静默做，需要自己的账本/迁移。
`scripts/codex-identity-rekey.js` 目前只覆盖 Codex。

### 2. `kiro`：凭据轮换直接改变 `accountRef`

```
kiro (refresh token rt-1)  -> oauth:kiro:token:a33d8c625833429d
kiro (refresh token rt-2)  -> oauth:kiro:token:1f23b7dadfb229cb
```

这是 §8.1 第 3 条的**逐字违反**：轮换凭据 → 新 `accountRef` → 旧账号变孤儿、新账号成重复。

`kiro` 的存储（`auth_kv` 的 `kirocli:odic:token`）里只有 `access_token`/`refresh_token`/
`expires_at`/`region`，**没有** user id 或邮箱。所以这不是「选错字段」，而是
「在仓库当前读取的数据里没有稳定字段」——和 AGY 同性质，但更糟：AGY 至少用的是邮箱。

**关闭它需要上游证据**：Kiro 的 token 是不是 JWT（若 `sub` 存在，可用 `sub` 做身份，
且 `sub` 不随 token 轮换而变）；或 `auth_kv` 里是否有别的 key 携带账号身份。
在拿到证据前不改——猜一个字段比现状更危险。

### 3. `kimi` / `zcode` / `codebuddy` 家族的 token 回退

三者的回退路径同样是 `token:<hash(凭据)>`，实测轮换后种子改变。它们的**主路径**是稳定的
（`user:<hash(subject)>`），所以只在拿不到 subject 时退化。zcode 与 codebuddy 家族另有
**邮箱回退**，同样违反第 2 条。

## 关闭顺序建议

1. `grok` 优先级：**先做**。修法无歧义、收益明确，代价是需要一份 grok 账本
   （把 `codex-identity-rekey.js` 泛化成按 Provider 参数化）。
2. `kiro`：**先取证**再动手。需要 Kiro token 的实际形态。
3. `kimi`/`zcode`/`codebuddy` 的邮箱与 token 回退：需要先确认「拿不到 subject」在真实凭据里
   是否常见。若不常见，改成 `identity_unverifiable` 更符合 §8.1；若常见，则它们和 AGY 一样
   是需要论证的例外。

## 参考

- `docs/architecture/codex-oauth-identity-vector-adr.md`（决策与已实施的三个 Provider）
- `docs/architecture/oauth-email-identity-exception-adr.md`（AGY/Gemini 的例外裁决、Kiro 的待取证）
- `docs/architecture/product-direction-node-go-2026-08-15.md` §8.1
- `lib/account/account-identity.js` `resolveNativeAuthIdentitySeed`
- `lib/account/identity-components.js`（Go 兼容原语）
- `test/oauth-identity-vector-spec.test.js`（把本文档变成可执行断言，含两条已知违规的特征化测试）
