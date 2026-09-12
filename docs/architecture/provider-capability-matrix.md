# Provider 能力矩阵（实测）

> 测量时间：2026-09-12（B33 同日复核，见 §3.1）· 测量者：本机网关 `127.0.0.1:9527` 真账号真上游
> 用途：`chat-harness-absorption.md` §后续吸收专题 第 5 项要求「逐 provider 记录模型窗口、reasoning、图片、
> 停止、压缩、恢复的**真实结果**」，并明确「某项协议限制持续存在时再接 Pi adapter」。本文是该前置数据，
> **只测不改**，不构成对任何实现的改动。

## 1. 静态能力（来源：models.dev 固定快照，`createModelsDevReader().resolveEntry`）

| provider | 代表模型 | 上下文窗口 | 最大输出 | 输入模态 |
|---|---|---:|---:|---|
| codex | `gpt-5.5` | 1,050,000 | 128,000 | text / image / pdf |
| claude | `claude-opus-5` | 1,000,000 | 128,000 | text / image / pdf |
| agy | `gemini-2.5-flash` | 1,048,576 | — | text / image / audio |
| grok | `grok-4.6` | 500,000 | 500,000 | text / image |
| opencode | `opencode/grok-4.6` | 500,000 | 500,000 | text / image |
| kimi | `k3-256k` | 262,144 | 131,072 | text / image |
| zcode | `glm-4.6` | 204,800 | — | text |

窗口解析链见 `webui-chat-routes-opencode-proxy.js:126 resolveModelContextLimit`：先取 `limits.context`，
再取 `limits.input`，最后才落到按模型名前缀的兜底常量。**上表七项均命中真实元数据，未走兜底**。

## 2. 实时可达性（同一时刻、同一请求形状实测）

| provider | HTTP | 耗时 | 结果 |
|---|---:|---:|---|
| claude | **200** | 2155ms | 上游真实回复 |
| agy | **200** | 5032ms | 上游真实回复 |
| codex | 503 → 429 | 258ms | `blocked_by_quota:usage_exhausted`；换第二账号为 `model_cooldown:gpt-5.5:upstream_429` |
| kimi | 503 | 116ms | `blocked_by_quota:usage_exhausted` |
| grok | 402 | 976ms | `upstream_402: personal-team-blocked:spending-limit` |
| opencode | 401 | 1133ms | 上游 401 |
| zcode | 429 | 713ms | `upstream_429`（上游限流） |

### 2.1 关键结论：七项失败全部是账号侧状态，无一是网关缺陷

额度耗尽、模型级冷却、计费封锁、鉴权失败、上游限流——五种成因各自返回了**不同且精确**的错误，
调用方据此可以分别决定「换号 / 等冷却 / 去付费 / 重登 / 退避」。这说明错误词汇表本身是健康的。

**样本局限**：测量时只有 2/7 provider 可达，因此下面的会话级行为只在这两家上取到实测值。
codex 的额度是在本轮测试过程中耗尽的（当日早些时候同一账号可正常回答），属自然消耗，非故障。

## 3. 会话级行为：停止

流式请求收满 12 个数据块后由调用方 `AbortController.abort()`：

| provider | 首字 | 中断时点 | 调用方结束 | 异常 |
|---|---:|---:|---:|---|
| claude | 5606ms | 7501ms | 7504ms | 无 |
| agy | 4388ms | 5237ms | 5237ms | 无 |

两家均在中断后 **≤3ms** 结束，无挂起、无未捕获异常。

## 3.1 reasoning 回传与图片输入(2026-09-12 补测)

两项都在可达的两家上实测,请求走 `/v1/chat/completions`:

| provider | 模型 | reasoning 回传 | 图片输入(48×48 纯蓝 PNG,data URI) |
|---|---|---|---|
| claude | `claude-opus-5` | **未回传**(带 `reasoning_effort:'low'` 仍为 0 字符;推理过程混在正文里) | **通过**——答 `Blue` |
| agy | `gemini-2.5-flash-thinking` | **回传**(1903–2722 字符独立 reasoning 内容) | **未通过**——答 `NOIMAGE` |

元数据侧两家 `capabilities.reasoning` 均为 `true`(字段在 `capabilities` 下,
不是条目顶层——本文初版的探测脚本读错路径,恒为 false,故初版未给出 reasoning 结论)。

### B33:agy 经 `/v1/chat/completions` 收不到图片输入 —— 范围已收窄到 `/v1` 这条协议路径

初始复现:上述同一请求,1×1 与 48×48 两种图都答"没收到图"(`NO` / `NOIMAGE`),claude 同请求同图答 `Blue`。

**2026-09-12 复核(测试图:64×64 四象限,左上红/右上绿/右下黄/左下蓝,顺序报色几乎不可能靠猜命中):**

| 路径 | 模型 | 结果 |
|---|---|---|
| **chat harness**(WebUI 实际走的路) | `gemini-3.8-flash-high` | 答「红、绿、黄、蓝」**4/4** ✅ |
| **chat harness** | `gemini-2.5-flash-thinking`(B33 原模型) | 答「红色、绿色、黄色、蓝色」**4/4** ✅ |
| `/v1/chat/completions` | — | **未复测**:该端点只认 gateway client key(`v1-router.js:692`),
本次无法取得该凭据,不以推断代替实测 |

由此:

- **不是模型特异**:B33 当初失败的那个模型在 harness 路径上答全对。
- **不影响 WebUI/harness 用户路径**:两个模型、真实账号、真实上游,图片都到达了模型。
- **请求构建层已排除(进程内逐字节验证)**:`normalizeOpenAIContentParts` → canonical →
  `canonicalPartsToGeminiParts` → `addGeminiContent`(含 `removeEmptyGeminiTextParts` 与
  `orderGeminiPartsForRole` 两个包装)全链保留 `inlineData`,mime 正确、base64 与原图完全一致;
  纯图片(无文字)轮次同样保留。
- **仍未查明**:`/v1/chat/completions` 端到端是否还丢图。若还丢,按上一条,问题不在请求构建,
  而在该路由选用的协议变体或上游包裹层(参见 agy 响应包在 `{response:{…}}` 的既有结论)。
  取得 client key 后一条请求即可判定。

## 4. 尚未取得实测的项

| 项 | 为何未测 |
|---|---|
| reasoning / 图片输入 | **已补测,见 §3.1**;图片输入 2026-09-12 已在 harness 路径复核通过 |
| 压缩 / 恢复 | 属 harness 会话级行为，需经 chat-runtime 会话通道而非 `/v1/*` 直调；且该子系统正在并发开发中 |
| 其余 5 家的会话级行为 | 账号不可达（见 §2），无法取得真实值 |

**不以「元数据声明」冒充「实测结果」**：§1 是声明，§3 是实测，§4 是空白。三者不得混为一谈——
这正是吸收文档要求「先验证差距，再实现」的原因。
