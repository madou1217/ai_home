# OAuth 身份对齐：需求、完成项与待办（Review）

> 供 review 用。三个提交都已推送，工作树干净（除并行会话的产物）。
> 需要你拍板的点在最后一节。

## 一、需求来源

| 来源 | 原文要点 |
| --- | --- |
| `product-direction-node-go-2026-08-15.md` §8.1 | `accountRef` 创建后不因邮箱变化而改变；稳定字段缺失时返回 `identity_unverifiable`，**不得回退邮箱**；凭据轮换不得改变 `accountRef`；必须生成显式映射账本 `old_account_ref -> account_ref + resolution`，冲突逐条裁决；禁止双写、回读 fallback、影子账号表 |
| `go-node-parity-matrix.md` | 把「Codex OAuth 身份向量」列为**唯一需要决策的项** |
| 你的三次指令 | ①「写 ADR + 显式 rekey」→ ②「直接闭环」→ ③「继续闭合」 |

## 二、需求拆解与验收标准

| # | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| R1 | Codex 身份向量统一到 `user_id` | 两端逐字节一致，有跨语言测试钉住 | ✅ 完成 |
| R2 | 提供 §8.1 要求的映射账本 | 账本 + dry-run；冲突不自动合并；禁止双写/回读/影子表 | ✅ 完成 |
| R3 | rekey 可执行且可回滚 | `--apply` 有确认门槛；单事务；提交前校验外键完整性 | ✅ 完成 |
| R4 | 同一类问题在其余 Provider 上核对 | 逐个实测，不靠读源码推断 | ✅ 完成（12 个 Provider） |
| R5 | Go 未实现的 Provider 有可照抄的规格 | 向量、取值链、哈希函数都写明 | ✅ 完成 |
| R6 | 无法立刻修的项不能沉默 | 违规在 CI 可见 | ✅ 完成 |
| R7 | **对真实数据执行 rekey** | — | ⛔ **待你授权** |
| R8 | `aih.db`（Go 侧）迁移 | — | ⛔ **超出本轮范围**（Go 拥有） |
| R9 | 其余 9 个 Provider 的 Go 实现 | — | ⛔ **未开始**（Go 侧缺口） |

## 三、DONE

### `474a52ee` feat(codex): derive the OAuth identity from the stable user id
24 文件，+1832/−119

- **向量**：`buildCodexOAuthIdentitySeed` 是唯一实现，复刻 Go 的取值链
  （`chatgpt_user_id` → `user_id` → `sub`）与校验（拒绝 `:`、控制字符、U+FFFD、trim 后为空）。
- **五处站点**（ADR 原本只列了四处）：实施时发现 `standard-transfer.js` 的导出文件名闸门
  要求 `buildOAuthIdentity('codex', auth)` 非空——对 codex 等价于「邮箱存在」，
  会**误封**没有 ID Token 的账号，用户连备份都做不了。改为标签与身份分离。
- **app-server 解耦**：`account/read` 只自报邮箱，所以身份换向量后原来的哈希比对会对**每个**
  账号恒失败；改为直接比邮箱。
- **跨语言契约**：`contracts/codex-oauth-identity.json`，15 条向量两端共读。
- **rekey 工具**：`lib/cli/services/account/codex-identity-rekey.js` +
  `scripts/codex-identity-rekey.js`。重写**按构造完整**——枚举 SQLite schema 重写每一个
  `account_ref` 列，不维护表清单。

### `ae60c7ac` fix(identity): align the Claude and AGY vectors with Go too
13 文件，+977/−50

- **Claude 三处分歧**（实测确认）：Go 统一小写、拒绝未 trim、强制 UUID 形状；Node 三者都不做。
  大写 UUID 会让**同一个账号**得到两个 `accountRef`。
- **Claude 潜伏分歧**：Node 的通用 email 分支排在 uuid 之前，带 `claudeAiOauth.email` 的凭据
  会走邮箱向量。已关掉，且不回退邮箱。
- **AGY 校验强度**：Go 拒绝非邮箱形状，Node 原先接受任意非空串，能铸出
  `oauth:agy:no-at-sign`（Go 永远寻址不到）。对齐后 19 条实测向量全部一致。
- **共用实现**：`lib/account/identity-components.js` 收纳 Go 兼容原语——因为
  Go 的 `strings.TrimSpace` 与 JS 的 `\s` **不是同一套空白集**（差 U+0085 NEL），抄第二遍必漂。
- 顺带修 6 个用**假 UUID** 的夹具（`selected-uuid`、`claude-account-uuid`、`1fb09d73`）——
  这些值 Go 一直拒绝，只在 Node 侧「能过」，夹具本身一直是失真的。

### `2860409f` docs(identity): spec the remaining vectors and record the open exceptions
4 文件，+297/−1

- **`oauth-identity-vector-spec.md`**：全 12 个 Provider 的向量、取值链、§8.1 状态。
  Go 实现其余 Provider 时的照抄规格。
- **`oauth-email-identity-exception-adr.md`**：AGY/Gemini 接受为例外，Kiro 待取证。
- **`test/oauth-identity-vector-spec.test.js`**：把文档变成可执行断言，含两条
  `KNOWN §8.1 VIOLATION: ...` 的特征化测试。

## 四、TODO

### ⛔ 待你决策（阻塞项）

| # | 项 | 为什么需要你 | 我需要什么才能动 |
| --- | --- | --- | --- |
| T1 | **执行真实数据的 Codex rekey** | 会改写你机器上的 `accountRef` | 一句授权；我会先跑 dry-run 给你看账本 |
| T2 | **修 grok 的优先级** | 修法无歧义，但会改写既有 grok 账号的 `accountRef`，按 §8.1 不能静默做 | 是否现在就修 + 接受一次 grok 迁移 |
| T3 | **Kiro 取证** | 它的存储里只有 token，没有稳定字段可换 | 一份真实 Kiro 凭据，或确认其 token 是否 JWT |
| T4 | **`aih.db`（Go 侧）迁移** | 归 Go 所有，顺序不能反（Node 先迁完再对齐 Go） | 是否要我把 Node 侧的完成状态交接给 Go |

### 🔧 可自主推进（非阻塞）

| # | 项 | 说明 |
| --- | --- | --- |
| T5 | 把 `codex-identity-rekey.js` 泛化成按 Provider 参数化 | T2 的前置。现在只覆盖 Codex |
| T6 | kimi/zcode/codebuddy 的邮箱与 token 回退 | 需先确认「拿不到 subject」在真实凭据里是否常见 |
| T7 | 其余 9 个 Provider 的 Go 实现 | 按 `oauth-identity-vector-spec.md` 照抄。**这是范围扩张**（Go 侧账号域目前只覆盖 3 个 Provider），建议单独排期而不是搭在这次改动上 |

### 已知未闭合（记录在案，非待办）

- **grok**：可变邮箱压过可用的稳定 `user_id`（实测：改邮箱 → 改 `accountRef`）。
- **kiro**：轮换 refresh token → 改 `accountRef`（`…a33d8c62…` → `…1f23b7da…`）。
- 两条都在 CI 里可见，不是「忘了」。

## 五、验证口径

| 项 | 结果 |
| --- | --- |
| `go test ./...` | **0 失败**（`TestRunServesAccountsAndShutsDownCleanly` 首次偶发，基线 `ce5dffd4` 可复现，重跑即过） |
| `gofmt -l internal/ application/ core/ cmd/` | 干净 |
| 32 个涉及 codex 向量的测试文件 | **663/663** |
| 宽过滤（identity/account/transfer/import/backup/cliproxy/sub2api/codex/projection/session/reader/provider…） | **2329/2335、2796/2803，0 失败** |
| 四份契约套件 | 23/23 |

**方法说明**：所有跨语言结论都是**实测**得出的（喂真实形状凭据、打印实际输出、两端对拍），
不是读源码推断。这条纪律当天纠正了我两次错误假设。

## 六、请你确认

1. **T1** 是否授权我跑真实数据的 rekey？（我会先给 dry-run 账本，你复核后再决定 `--apply`）
2. **T2** grok 现在就修，还是等 Go 实现 grok 时一起做？
3. **T3** 你能提供一份真实 Kiro 凭据吗？（哪怕只看结构，token 是否 JWT 就能定）
4. 这份 review 的粒度够吗？需要我按提交逐个展开 diff 吗？
