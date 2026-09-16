# CodeBuddy 家族「额度探测闭环」— 需求 / 交付 / 未完成 评审文档

- 状态：**待 review**
- 评审对象：2026-09-15 ~ 2026-09-16 的 CodeBuddy 家族工作（分支 `main`）
- 当前 HEAD：`dd90ee4d`（已推送，与 `origin/main` 同步，0/0）
- 相关源码文档：[`docs/architecture/codebuddy-family-credential-model.md`](architecture/codebuddy-family-credential-model.md)

---

## 一、需求

### 1.1 背景

`workbuddy` / `codebuddy` 的国内（cn）与国际两站在产品上是**四支 Provider**
（`codebuddy`、`codebuddycn`、`workbuddy`、`workbuddycn`）。勘察确认：**同地区**的 work 与 code
跑的是**同一套 runtime**，因此**共用一份会话历史**、也**共用一份账户级额度**。

### 1.2 用户确认的原始范围（2026-09-14）

> 静态 provider 定义 + 账号 + 安装启动隔离 + 图标/token 品牌；
> **不做**：网关路由、用量探测、会话历史、原生聊天。

即：**用量探测与会话历史在初始范围里是被显式排除的。**

### 1.3 后续追加的指令（本次工作的直接来源）

1. 会话打通：同地区 work/code 共用一份历史 → **完成**（`9db95e2b`）。
2. 「那就闭环 必须闭环」→ 把此前显式延后的**额度/用量探测**补齐，家族四员全部打开
   `quota_usage`，并保证**从探测到展示、从落盘到账号列表**整条链路都通。
3. 「别忘了拉取最新代码」→ 每轮动手前先 `fetch`/比对，只提交自己的文件。

### 1.4 本次的验收口径

「闭环」= 下面**每一层**都能真实取到家族额度，且**没有静默失效的层**：

```
探针(HTTP) → 落盘快照 → server 侧 trusted 闸门 → 展示层 → 账号可见性
```

---

## 二、我做了什么

按轮次列出，全部已推送到 `origin/main`。

| # | 轮次 | 交付 | 提交 |
| --- | --- | --- | --- |
| 0 | 会话打通 | 同地区 work/code 共用一份历史（软链接共享、**绝不迁移**） | `9db95e2b` |
| 1 | 额度探针 | 家族四员接入 `quota_usage`：新探针 + 聚合语义 + kind/source 注册 + 契约/codegen | `21e01921` |
| 2 | server 侧闸门 | `readTrustedUsageSnapshot` 的家族放行/拒绝用例（此前**无测试保护**） | `5b50697d` |
| 3 | 展示层 | WebUI 加家族分支：渲染每个积分桶，不再只画一条账号级进度条 | `531ef595` |
| 4 | 账号可见性 | 钉住"家族不在运行时账号池、但账号列表仍可见"的回归用例 | `7b4389cd` |
| 5 | 全展示面核查 | 把家族快照能到达的**所有**消费方扫一遍，记录结论（§14.7） | `dd90ee4d` |

### 2.1 关键技术结论（评审要点）

**端点**：`POST {endpoint}/billing/meter/get-user-resource-summary`，与桌面端/官网同款。

**两个静默坑**（错了不报错，只是 403/404）：

- **不带 `/v2`**：新版计量接口注册在**无前缀**路径，带 `/v2` → 404。
- **必须真实 UA**：国内网关对脚本默认 UA（`Python-urllib`/`undici`/`curl`）回
  `403 + code 10085`。**这不是鉴权失败，是 WAF**。排查顺序固定：**路径前缀 → UA → 最后才怀疑 token**。

**聚合语义（最关键的设计）**：积分跨包通用 → 权威值是**一条账户级聚合**
`sum(remain)/sum(total)`；每个 PackageCode 另发一条 `category:'detail'` 明细。提取器
**跳过 `detail`**（同 kimi 跳 `gift`），否则**一个用尽的赠送/试用包会把健康账号拖到 0%**，
调度会据此把好账号判成额度耗尽。`remainingPct` 缺失时取 `null`，**绝不回退 100%**。

**跨层一致性**：四支共用**同一个** kind（`codebuddy_credit_balance`）与 source 常量
（`USAGE_SOURCE_CODEBUDDY`），探针产出 / `usage/cache.js` 校验 / `server/accounts.js` 校验
**三处引用同一常量**。

---

## 三、已完成（Done）

每条都附了**可复核的证据**。

### 3.1 会话打通（`9db95e2b`）

- 同地区 work/code 读取同一份 `projects` 历史；`projects` 是指向地区存储的**软链接**，
  且**绝不搬迁**（切账号不影响历史）。
- 续聊（relay）只给**自带 CLI** 的两个站点。
- 展示层按会话 id 去重。

### 3.2 额度探测闭环（`21e01921` + `5b50697d` + `531ef595` + `7b4389cd` + `dd90ee4d`）

| 层 | 交付 | 证据 |
| --- | --- | --- |
| 探针 | 新 `lib/account/codebuddy-billing.js`、新 `lib/cli/services/usage/codebuddy-quota-probe.js` | `test/codebuddy-quota-probe.test.js` **21 pass** |
| 语义 | 聚合 + 明细；提取器跳过 `detail` | 明细包用尽时账号级仍 `16.67%` |
| server 闸门 | `readTrustedUsageSnapshot` 按 **cliName 分派**（不靠"形状对了"放行） | `test/server.accounts.test.js` 新增 3 条 |
| 展示层 | `UsageSnapshotCell.tsx` 家族分支 + `buildCodebuddyCreditRows()` 纯函数 | Web 侧 4 条用例；`bun test web/src` **524 pass** |
| 账号可见性 | 家族不在运行时 pool，但账号列表照常出现 | `test/webui-account-live.test.js` **29 pass** |
| 全展示面 | 终端标题 / `ls` 标签 / 调度索引**均已由数值兜底覆盖** | §14.7（**实测证伪**，见下） |

**实机验证（穿到 server 闸门）**：用本机真实 `.info` 凭据跑真实端点，快照落盘后经
`readTrustedUsageSnapshot` 读回，**前后一致**：

- `workbuddy` **16.67%**（100/600 credits）
- `codebuddy` **16.67%**（100/600）
- `workbuddycn` **≈68%**（≈1400/2056，随真实用量浮动）
- 快照 `schemaVersion=2`；**聚合值没被用尽的明细包拖低**（`proTrialMon` = 0/500，账户级仍 100/600）。

### 3.3 全展示面核查（`dd90ee4d`，§14.7）——**价值是"证伪"**

排查"疑似缺口"时**实测**（而非靠读命名猜），结论是**三处看起来像缺口的地方都不是缺口**：

1. **交互式终端标题**：窗口格式化返回空后，**回落到数值**（实测 `getUsageRemainingPctValues`
   = `[16.67]`）→ 标题显示 `[o:<id>:17%]`，**不是 `?`**。
2. **CLI `aih <p> ls`**：`formatUsageLabel` 返回空后，调用方**已有**数值兜底
   （`profile/list.js`）→ `[Remaining: 16.7%]`，且**本来就有测试钉住**。
3. **调度 / 模型-账号索引**：走的就是账户级聚合值。

**为什么 `window-format.js` 不加家族是"有意正确"**：它**只认时间窗**
（codex/claude/kimi），家族与**已上线的 zcode** 返回空是**设计且有测试**。更关键：家族 entry 是
**按 credits 计费的桶、没有 `window` 字段**，就算把 kind 加进去也会被滤光——**加了等于白加**。

---

## 四、未完成 / 未做（Not done）

**请重点 review 这一节。** 分为「刻意不做」与「确实遗留」两类。

### 4.1 刻意不做（有明确理由，建议维持）

| 项 | 理由 | 出处 |
| --- | --- | --- |
| 启动策略注入每账号唯一 `ACC_PRODUCT_CONFIG_V3.authentication.id` | 会让沙箱**不再与 App 共用登录态**，与产品目标冲突；国内侧已由 HOME 隔离天然实现"一账号一份" | 文档 §8 / §11.3 |
| `provider-usage-policies.js` 保持只登记 5/15 provider | 家族**和 zcode/grok/qoder/opencode/kiro 一样缺席**，属**该表自身既存覆盖度**问题；未登记时的兜底是"保持可调度"（**安全**）。单独补家族会与另外 9 支不一致 | §14.7 |
| Go Preview 不显示家族额度 | `AccountsGoPreview.tsx` **只在隔离进程**加载，且**刻意**把 quota 投影为 `unknown`（"没证据不伪造"） | §14.7 / ACC-003 |

### 4.2 确实遗留（建议 review 是否排期）

| 项 | 影响 | 现状 |
| --- | --- | --- |
| **只装独立分发件时的凭据捕获缺口** | 用户若**只**装了独立分发件（无 WorkBuddy.app），国内站 CLI 会写 `Tencent-Cloud.coding-copilot.info`，而 aih 的 `codebuddycn`/`workbuddycn` **不认**该文件 → 该账号登录后**不会被捕获注册** | 文档 §11.3，**未做** |
| WorkBuddy 桌面端"新建会话" | 仍需在**桌面端**发起；aih 只负责读取与（codebuddy 侧）续聊 | 文档 §13.8，**未做** |
| `aih <p> usage` 详细输出 | 对**未知 kind** 落到 `[JSON.stringify(cache)]`，家族会打印原始 JSON 而非格式化行。**诊断面**、zcode 同样如此 | §14.7，**未改** |
| 评估 `codebuddy --serve` 集成入口 | 若要**真正意义的凭据共用**，应优先评估官方 REST/ACP 入口而非自实现 bootstrap | 文档 §8，**未做** |

### 4.3 环境 / 仓库既存问题（**非本次引入，但建议一并处理**）

| 问题 | 详情 |
| --- | --- |
| **`package-lock.json` 与 `package.json` 漂移** | `smol-toml@1.3.1` 声明在 `package.json`，但在 `package-lock.json` 中**出现 0 次**（已复核）。装依赖时会出现"声明了但装不上" |
| `node_modules` 严重不全 | 15 个声明依赖中 **8 个不在 `node_modules`**。已用 `npm install --no-save --ignore-scripts` **临时修复**（`package.json`/lock **零改动**，已校验哈希），但**未入库**——换机器需重跑 |
| 1 个既存测试失败 | `test/pty-runtime.test.js` 的 "runtime atomically assigns a Codex CLI id only after pending OAuth succeeds"（`pty-runtime-run.js:1105` 报 `EXIT:1`）。**单独跑也 167/168 fail**；用 `git stash` 收走本次改动后**仍 fail** → **证明与本次无关** |
| 仓库无 lint 门 | 未定义标识符只能靠测试发现（本次就踩到一次，见 §5.1） |

---

## 五、过程记录（供 review 参考）

### 5.1 本次踩过并修掉的自身问题

- **自己引入的回归**：给探针传 `resolveAccountRef` 却**漏 import** → 进函数即 `ReferenceError`，
  `test/usage.snapshot.test.js` **34 项全挂**。**教训**：`node --check` 只查语法、**查不出未定义
  标识符**，改了被大量测试覆盖的中枢文件必须**立刻单独跑那个测试文件**。
- **展示层索引错位**：明细行过滤后用 `entries[index]` 回查会**错位**，改为**行携带原始 `entry`**。
- **联合类型漏登记**：新 kind 未进 `AccountUsageSnapshot` → `tsc` 报 **TS2367 + TS2339**；
  补齐后错误数回到基线。
- **工具坑**：macOS 的 BSD `grep` **BRE 不支持 `\|`**，`grep "a\|b"` 会**静默假阴性**
  （本次因此误判过一次"重大发现"）。多选分支必须 `grep -E`。

### 5.2 门禁汇总

| 门禁 | 结果 |
| --- | --- |
| `npm test`（根） | **7148 pass / 1 fail**（该 1 项已证明为既存、与本次无关） |
| `bun test web/src` | 524 pass |
| `node --test test/webui-account-live.test.js` | 29 pass |
| `test/codebuddy-quota-probe.test.js` | 21 pass |
| `go build ./...` / `go vet` | 通过 |
| `tsc --noEmit` | 与基线对比**无新增**错误（基线 ~101 条既存） |
| `cd web && npm run build` | 通过 |

---

## 六、需你决策的点

1. **§4.2 的凭据捕获缺口**（只装独立分发件 → 账号不被捕获）是否**值得排期**？影响面取决于
   "只装独立分发件"的用户占比。
2. **§4.3 的 lock 漂移**（`smol-toml` 缺锁）建议**单独提一个修复提交**——它会让任何新机器
   `npm install` 出现不一致。**本次未擅自改 lock**。
3. **§4.2 的 `usage` 原始 JSON**：是否要为**所有**非时间窗 kind 统一做格式化（会同时改善 zcode）？
   本次刻意未动共享格式化代码，避免影响 5 个已上线 Provider。
4. **§4.1 的"刻意不做"三项**：若认可，建议在文档里标注为**产品决策**而非待办，以免被反复重提。

---

## 附：相关文档索引

- 家族凭据/会话/额度全貌：`docs/architecture/codebuddy-family-credential-model.md`
  （§8 待办、§11.3 / §13.8 已知限制、§14 额度探测闭环、**§14.7 全展示面核查**）
- 功能矩阵：`docs/functional-matrix.md`（家族原生额度 → `支持`）
- 会话级 gap 追踪（既有）：`docs/session-b2ce4810-gap-tracker.md`
