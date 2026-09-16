# ADR：无稳定字段时的身份回退（AGY / Gemini / Kiro）

- **状态**：AGY、Gemini **接受为例外**（Accepted exception）；Kiro **待取证**（Pending evidence）。
- **日期**：2026-09-16
- **依据**：`product-direction-node-go-2026-08-15.md` §8.1
- **相关**：`codex-oauth-identity-vector-adr.md`（已实施的三个 Provider）、
  `oauth-identity-vector-spec.md`（全 Provider 向量表）

## 背景

§8.1 对 OAuth 身份定了一条硬规则：**稳定字段必须存在；缺失时返回 `identity_unverifiable`，
不得回退邮箱**。同时要求 `accountRef` 创建后不因**邮箱变化**或**凭据轮换**而改变。

核对完全部 Provider 后，有三个 Provider 无法满足这条规则，而且原因**不是选错了字段**：

| Provider | 可用的身份输入 | 性质 |
| --- | --- | --- |
| `agy` | 只有邮箱 | 没有更稳定的字段 |
| `gemini` | 只有邮箱（`googleAccounts.active`） | 没有更稳定的字段 |
| `kiro` | 只有 access/refresh token | 没有更稳定的字段，且 token 会轮换 |

前两个用邮箱，第三个用 token 哈希。**两者的失败方式不同**，所以处置也不同。

## 决策

### 1. AGY 与 Gemini：接受「邮箱即身份」，但要求校验强度与 Go 一致

不改用别的字段——**没有别的字段可用**。改用任何「看起来更稳定」的东西都是猜，
而猜出来的身份比已知会变的身份更危险。

但校验强度必须对齐：Go 的 `normalizeEmail` 会拒绝非邮箱形状的值，Node 原先只做
trim + lowercase，于是能铸出 `oauth:agy:no-at-sign` 这种 Go 直接拒绝的种子——
即「Node 能建、Go 永远寻址不到」的账号。已对齐并逐条实测（见
`contracts/agy-oauth-identity.json` 的 17 条向量）。

### 2. Kiro：**待取证，不猜**

Kiro 比前两个更糟：邮箱至少在「用户不换邮箱」时是稳定的，而 token 会轮换。
实测确认轮换会改变 `accountRef`，直接违反 §8.1 第 3 条：

```
refresh_token rt-1 -> oauth:kiro:token:a33d8c625833429d
refresh_token rt-2 -> oauth:kiro:token:1f23b7dadfb229cb
```

`auth_kv` 的 `kirocli:odic:token` 里只有 `access_token`/`refresh_token`/`expires_at`/`region`。
**关闭它需要上游证据**，二选一：

- Kiro 的 token 是否是 JWT（若是，其 `sub` 不随轮换改变，可直接作身份）；
- `auth_kv` 里是否另有携带账号身份的 key。

在拿到证据前保持现状，并把违规写进 `test/oauth-identity-vector-spec.test.js` 的特征化断言，
让它在 CI 里可见——**沉默地保持现状是不可接受的，可见地保持现状是可以的**。

## 后果

**我们接受的代价**：AGY/Gemini 账号在用户改邮箱后会得到新的 `accountRef`，
旧账号变孤儿。这不影响可用性（重新登录即可），但会让「使用量归属」和「默认账号」
指向旧 ref。

**我们明确不接受的**：为了消除这个代价而引入
- 双写、回读 fallback、影子账号表（§8.1 明文禁止）；
- 猜一个「更稳定」的字段；
- 在拿不到稳定字段时**静默**按邮箱建号——必须是显式的、记录在案的例外。

## 重新评估的触发条件

1. **上游开始提供稳定字段**（AGY/Gemini 的 token 里出现 user id / uuid）→ 立即改用，
   并按 `codex-oauth-identity-vector-adr.md` 的 rekey 程序迁移。
2. **Kiro 的 token 形态被证实** → 按上面二选一处理。
3. **出现真实的孤儿账号投诉** → 说明代价比预期高，需要重新权衡。

## 本 ADR 不授权的事

- 不授权给 `codex`、`claude` 引入邮箱回退——它们的稳定字段**总是存在**，
  所以拒绝比回退更正确。
- 不授权把 `grok` 的优先级问题一并归入「例外」。`grok` 的凭据里**有**稳定 `user_id`，
  却被邮箱压过——那是**违规**，不是例外，必须修（见 spec 的「关闭顺序建议」）。


## 2026-09-16：Grok 违规已修正

Grok 不再属于本 ADR 的待修项：稳定 user_id/userId 优先，其次 principal_id/principalId，
冲突或缺失时返回不可核验；规范化后的去重 ID 集合参与摘要，邮箱与轮换令牌不参与。
已有账号重登保留原 accountRef；需要改写引用时显式使用通用 OAuth rekey v2 账本。
Kiro 的证据限制不变：本机不存在对应原生存储或 AIH 账号，不能虚构稳定字段。
