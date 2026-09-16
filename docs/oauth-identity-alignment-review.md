# Codex/Claude/AGY OAuth 身份对齐：需求 · TODO · DONE

> 2026-09-16 复核交付：新增修复、精确验证与真实数据阻塞见
> [Provider review 交付记录](maintenance/provider-review-delivery-20260916.md)。
> 下文保留原评审时间点的事实；不得把历史“未做”或早期测试数量当作当前状态。

提交：`474a52ee` · `ae60c7ac` · `2860409f` · `2f79dbbe` · `28f2dd7c`（均已推送，工作树干净）

---

## 一、需求

### 来源

| 来源 | 要点 |
| --- | --- |
| `product-direction-node-go-2026-08-15.md` §8.1 | ① `accountRef` 创建后不因**邮箱变化**而改变；② 稳定字段缺失时返回 `identity_unverifiable`，**不得回退邮箱**；③ **凭据轮换**不得改变 `accountRef`；④ 必须生成显式映射账本 `old_account_ref -> account_ref + resolution`，冲突逐条裁决；⑤ 禁止双写、回读 fallback、影子账号表 |
| `go-node-parity-matrix.md` | 把「Codex OAuth 身份向量」列为**唯一需要决策的项** |
| 你的指令序列 | ①「写 ADR + 显式 rekey」→ ②「直接闭环」→ ③「继续闭合」 |

### 拆解与验收标准

| # | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| R1 | Codex 向量统一到 `user_id` | 两端逐字节一致，有跨语言测试钉住 | ✅ |
| R2 | 提供 §8.1 要求的映射账本 | 账本 + dry-run；冲突不自动合并；禁止双写/回读/影子表 | ✅ |
| R3 | rekey 可执行、可回滚 | `--apply` 有确认门槛；单事务；提交前校验外键完整性 | ✅ |
| R4 | 同类问题在其余 Provider 上核对 | 逐个**实测**，不靠读源码推断 | ✅（12 个） |
| R5 | Go 未实现的 Provider 有可照抄的规格 | 向量、取值链、哈希函数都写明 | ✅ |
| R6 | 无法立刻修的项不能沉默 | 违规在 CI 里可见 | ✅ |
| R7 | **对真实数据执行 rekey** | — | ⛔ 待你授权 |
| R8 | `aih.db`（Go 侧）迁移 | — | ⛔ 归 Go 所有 |
| R9 | 其余 9 个 Provider 的 Go 实现 | — | ⛔ 未开始 |

---

## 二、TODO

### ⛔ 待你决策（阻塞）

| # | 项 | 为什么需要你 | 我需要什么才能动 |
| --- | --- | --- | --- |
| T1 | **执行真实数据的 Codex rekey** | 会改写你机器上的 `accountRef` | 一句授权；我会先给 dry-run 账本 |
| T2 | **修 grok 的优先级** | 会改写既有 grok 账号的 `accountRef`，按 §8.1 不能静默做 | 是否现在修 + 接受一次 grok 迁移 |
| T3 | **Kiro 取证** | 它的存储里只有 token，没有稳定字段可换 | 一份真实 Kiro 凭据（看结构即可，token 是否 JWT 就能定） |
| T4 | **`aih.db`（Go 侧）迁移** | 归 Go 所有，顺序不能反（Node 先迁完再对齐 Go） | 是否要我交接完成状态 |

### 🔧 非阻塞

| # | 项 | 说明 |
| --- | --- | --- |
| T5 | rekey 工具按 Provider 参数化 | T2 的前置；现在只覆盖 Codex |
| T6 | kimi/zcode/codebuddy 的邮箱与 token 回退 | 需先确认「拿不到 subject」在真实凭据里是否常见 |
| T7 | 其余 9 个 Provider 的 Go 实现 | **范围扩张**（Go 账号域目前只覆盖 3 个 Provider），建议单独排期 |

### 已知未闭合（记录在案，非待办）

| 项 | 证据 |
| --- | --- |
| `grok`：可变邮箱压过可用的稳定 `user_id` | 凭据含 `email`+`user_id` → 取邮箱；改邮箱 → 改 `accountRef` |
| `kiro`：轮换 refresh token → 改 `accountRef` | `rt-1` → `…a33d8c62…`；`rt-2` → `…1f23b7da…` |

两条都在 `test/oauth-identity-vector-spec.test.js` 里写成特征化断言（测试名就叫
`KNOWN §8.1 VIOLATION: ...`），在 CI 里可见；修的时候必须显式改那个文件。

---

## 三、DONE

### `474a52ee` Codex 向量 → `user_id`（24 文件，+1832/−119）

- **向量**：`buildCodexOAuthIdentitySeed` 为唯一实现，复刻 Go 的取值链
  （`chatgpt_user_id` → `user_id` → `sub`）与校验（拒绝 `:`、控制字符、U+FFFD、trim 后为空）。
  拿不到稳定字段即 `identity_unverifiable`，**不回退邮箱**。
- **五处站点**（ADR 原本只列四处）：实施时发现 `standard-transfer.js` 的导出文件名闸门要求
  `buildOAuthIdentity('codex', auth)` 非空——对 codex 等价于「邮箱存在」，会**误封**没有
  ID Token 的账号，**用户连备份都做不了**。改为标签与身份分离。
- **app-server 解耦**：`account/read` 只自报邮箱，身份换向量后原来的哈希比对会对**每个**账号
  恒失败；改为直接比邮箱（语义等价）。
- **跨语言契约** `contracts/codex-oauth-identity.json`：15 条向量两端共读。
- **rekey 工具** `lib/cli/services/account/codex-identity-rekey.js` +
  `scripts/codex-identity-rekey.js`：默认 dry-run 只写账本；`--apply` 需 `--confirm-apply`，
  且账本有冲突/不可迁移/不属于已知向量就拒绝。重写**按构造完整**——枚举 SQLite schema 重写
  每一个 `account_ref` 列，不维护表清单。

### `ae60c7ac` Claude 与 AGY 对齐（13 文件，+977/−50）

- **Claude 三处分歧**（实测确认）：

  | 输入 | Go | Node（改前） | 后果 |
  | --- | --- | --- | --- |
  | `1FB09D73-…` | 小写 | 保留大写 | **同一个账号得到两个 `accountRef`** |
  | `" uuid "` | 拒绝 | trim 后接受 | 铸出 Go 不认的账号 |
  | `not-a-uuid` | 拒绝 | 接受 | 同上 |

- **Claude 潜伏分歧**：Node 的通用 email 分支排在 uuid 之前，带 `claudeAiOauth.email` 的凭据会
  走邮箱向量。已关掉，且不回退邮箱。
- **AGY 校验强度**：Go 拒绝非邮箱形状，Node 原先接受任意非空串，能铸出
  `oauth:agy:no-at-sign`（Go 永远寻址不到）。对齐后 **19 条实测向量全部一致**。
- **共用实现** `lib/account/identity-components.js`：因为 Go 的 `strings.TrimSpace` 与 JS 的
  `\s` **不是同一套空白集**（差 U+0085 NEL），抄第二遍必漂。
- 顺带修 6 个用**假 UUID** 的夹具（`selected-uuid`、`claude-account-uuid`、`1fb09d73`）——
  这些值 Go 一直拒绝，只在 Node 侧「能过」，夹具本身一直是失真的。

### `2860409f` 规格 + 例外（4 文件，+297/−1）

- `docs/architecture/oauth-identity-vector-spec.md`：全 12 个 Provider 的向量规格
  （Go 实现其余 Provider 时的照抄依据）。
- `docs/architecture/oauth-email-identity-exception-adr.md`：例外裁决——区分**例外**
  （没有稳定字段可用：agy/gemini/kiro）与**违规**（有稳定字段却被忽略：grok）。
- `test/oauth-identity-vector-spec.test.js`：把文档变成**可执行断言**。

### 全 Provider 向量现状（实测）

**Go 已实现（两端一致，有契约钉住）**

| Provider | 向量 | 稳定字段 |
| --- | --- | --- |
| `codex` | `oauth:codex:<user_id>` | ID Token：`chatgpt_user_id` → `user_id` → `sub` |
| `claude` | `oauth:claude:uuid:<account_uuid>` | `claudeAiOauth.account.uuid` |
| `agy` | `oauth:agy:<email>` | 邮箱（无更稳定字段） |
| 任意 | `api_key:<provider>:<baseUrl>:<fingerprint>` | baseUrl + key 指纹 |

**Go 未实现（只有 Node，共 9 个）**

| Provider | 向量 | §8.1 |
| --- | --- | --- |
| `gemini` | `oauth:gemini:<email>` | ⚠️ 邮箱即身份（例外） |
| `opencode` | `oauth:opencode:auth:<sha256(条目)[:16]>` | ✅ |
| `grok` | `oauth:grok:auth:<sha256(身份集)[:16]>` | ❌ 违规 |
| `kimi` | `oauth:kimi:user:<hash(subject)>` → 回退 `token:<hash>` | ⚠️ token 回退随轮换改变 |
| `kiro` | `oauth:kiro:token:<hash(refresh_token)>` | ❌ 违规 |
| `zcode` | `oauth:zcode:user:<hash(id\|email\|jwt sub)>` → 回退 `token:<hash>` | ⚠️ 邮箱 + token 回退 |
| `codebuddy` / `codebuddycn` / 同族 | `oauth:<provider>:user:<hash(subject)>` → `<email>` → `token:<hash>` | ⚠️ 邮箱 + token 回退 |
| `qoder` / `qodercn` | 专门解析；PAT-only 时 `api_key:<provider>:pat:<sha256(pat)[:16]>` | 未实测 |

> Go 实现时**必须复刻 `hashApiKeySecret` 的确切输入与截断**，否则同一份凭据得到不同种子。

### 验证

| 项 | 结果 |
| --- | --- |
| `go test ./...` | **0 失败**（`TestRunServesAccountsAndShutsDownCleanly` 首次偶发，基线 `ce5dffd4` 可复现，重跑即过） |
| `gofmt -l internal/ application/ core/ cmd/` | 干净 |
| 32 个涉及 codex 向量的测试文件 | **663/663** |
| 宽过滤（identity/account/transfer/import/backup/cliproxy/sub2api/codex/projection/session/reader/provider…） | **2329/2335、2796/2803，0 失败** |
| 四份契约套件 | 23/23 |

**方法说明**：所有跨语言结论都是**实测**得出的（喂真实形状凭据 → 打印实际输出 → 两端对拍），
不是读源码推断。这条纪律当天纠正了我两次错误假设：Claude 的「邮箱优先」猜测，以及第一次
grep provider 分派时模式写窄、漏掉 355-358 行导致 codebuddy/qoder 看起来不可达。
