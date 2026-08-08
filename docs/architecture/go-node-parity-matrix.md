# Go / Node 网关功能矩阵

> 目的：把「Go 什么时候能取代 Node 9527」从感觉变成账。
> 采集日期：2026-08-08。Node 侧 106 条路径 / 35 组，Go 侧 13 条。
> 采集方式：只读扫描 `lib/server/{server,v1-router,web-ui-router,webui-*-routes}.js`
> 与 `internal/host/aihserver/router.go` 的路径字面量，未启动服务。

## 结论先行

**阻塞切流的只有 3 组，不是 35 组。** Node 的 106 条路径里约 80 条是 WebUI 自己的
后端（终端、文件树、git、ssh、项目、会话），与「推理网关」无关。把它们算进
Go 的必做清单是把重构范围放大了一个数量级。

三档分类：

| 档 | 含义 | 组数 | 路径数 |
| --- | --- | ---: | ---: |
| **A 阻塞** | 不补齐就不能切流 | 3 | 9 |
| **B 需决策** | 归属未定，先定归属再排期 | 4 | 15 |
| **C 不阻塞** | WebUI 后端，重构范围之外 | 28 | 82 |

---

## A 档：阻塞切流（必须补齐）

| Node 路径 | Go 现状 | 说明 |
| --- | --- | --- |
| `/v1/responses` | ✅ 已有 | OpenAI Responses 入口 |
| `/v1/chat/completions` | ✅ 已有 | OpenAI Chat 入口 |
| `/v1/messages` | ✅ 已有 | Canonical + Native Relay 双路分发 |
| `/v1/models` | ✅ 已有 | 模型目录 |
| `/healthz` `/readyz` | ✅ 已有 | 存活/就绪 |
| `/v1/props` | ❌ **缺失** | 客户端能力协商。Node 返回 `{object:"props",data:{}}` |
| `/v1/blobs/{id}` | ❌ **缺失** | 视觉 blob 句柄，见下方说明 |
| ~~`/v1/`~~ | — | **不是端点**：`v1-router.js:592` 的作用域守卫 |
| ~~`/v1beta/`~~ | — | **不是端点**：同上。全仓 `/v1beta` 只出现在该守卫里，无任何处理器 |

采集脚本按路径字面量收集，会把这两条守卫当成端点。**已实测证伪**：对活着的
Node 9527 探测，`/v1beta/models` 与 `/v1/unknown-endpoint` 均返回 404，而
`/v1/props` 返回 200。

所以数据面真实缺口是 **2 条**，不是 4 条：

1. `/v1/props` —— 常量响应，工作量近似为零。
2. `/v1/blobs/{id}` —— 依赖 vision-image-guard 的 blob 存储：非视觉模型收到图片时
   网关剥图存 blob、正文留句柄，视觉子代理再回来取。Go 侧没有这条链路，补端点
   而不补链路没有意义。**归入「Go 支持视觉借用」的独立课题，不算切流阻塞。**

## B 档：需要先定归属

| 组 | Node | Go | 决策点 |
| --- | --- | --- | --- |
| 管理面账号 | `/v0/webui/management/accounts` 等 11 条 | `/v1/management/*` 5 条 | **命名空间不同**：Go 用 `/v1/management`，Node 用 `/v0/webui/management`。切流时 WebUI 会打不中 Go。要么 Go 加别名，要么 WebUI 改调用。 |
| `/v0/management` | ✅ | ❌ | 控制面入口，是否由 Go 承载 |
| `/v0/node-rpc/status` | ✅ | ❌ | Fabric 节点 RPC |
| `/v0/webui/nodes/*`（6） | ✅ | ❌ | 远程节点编排，属 Fabric 主线 |

**命名空间冲突是 B 档里唯一的硬伤**，其余三项取决于 Fabric 是否也迁 Go。

## C 档：WebUI 后端，不阻塞

以下 28 组共 82 条路径服务于 WebUI 自身，与推理网关正交。切流时应继续由 Node
提供，或由前端直连 Node。列出仅为完整性。

`accounts`(6) `chat`(5) `config`(1) `control-plane`(5) `desktop-menu`(1)
`fs`(5) `git`(2) `internal`(1) `model-aliases`(1) `projects`(含 sessions/watch)
`provider-hooks`(2) `server`(1) `server-config`(2) `server-routes`(6)
`session-events`(1) `sessions`(6) `slash-commands`(1) `ssh-connections`(3)
`ssh-hosts`(1) `ssh-workspaces`(2) `terminal`(7) `ui`(2) `webui` 根(2) 等。

---

## Go 侧完整路由清单（13）

```
/healthz
/readyz
/v1/models
/v1/responses
/v1/chat/completions
/v1/messages                              (Canonical / Native Relay 分发)
/v1/claude-relay-leases
/v1/management/accounts        (+ /)
/v1/management/account-imports (+ /sub2api)
/v1/management/account-defaults/
/v1/management/account-selections/resolve
/v1/management/account-auth-jobs (+ /)
```

## 第二步的工作清单

1. ✅ `/v1/props` —— 已补齐。
2. 管理面命名空间对齐（B 档硬伤）—— 需先决策由谁改，非纯实现工作。

不在清单内且有理由：

- `/v1/blobs/{id}`：依赖 Go 侧尚不存在的 vision-guard blob 链路，独立课题。
- `/v1beta/`、`/v1/` 兜底：不是端点（见 A 档说明）。

## 判定原则：权威是 provider 契约，不是 Node

本文档前几版把「与 Node 一致」当成目标，这是错的——Node 正是因为有问题才要被
替换。影子比对给出的是**差异**，不是**判决**。每条差异必须回到权威来源判断谁对：

| 场景 | 权威 |
| --- | --- |
| `/v1/messages` | Anthropic 真实响应。Node 在这条路径是字节透传，所以它的输出**恰好**等于权威——权威性来自透传，不来自 Node |
| `/v1/responses`、`/v1/chat/completions` | OpenAI 对应 API 契约 |
| `aih_*` 自定义字段 | 没有 provider 权威，属本仓设计决策，必须单独论证 |

推论：**Node 的行为不构成 Go 的验收标准。** 三种可能结论都要允许出现——Go 错、
Node 错、两边都要改。

## 第三步：影子比对结果（2026-08-08 首轮）

同一账号、同一时刻、同一请求分别发给 Node 9527 与 Go，比状态码与响应结构。
5 条探针全部 200，**3 条结构不一致**。

```bash
node scripts/gateway-shadow-compare.js \
  --node http://127.0.0.1:9527 --go http://127.0.0.1:19550 \
  --include-inference
```

### 1. `/v1/models` 的 `aih_modalities`：不照抄 Node 的做法

Node 给每个模型对象内联一个 `aih_modalities`（`lib/server/models.js:81`），数据源
是 models.dev 元数据加家族兜底。

查证后有两点让「Go 照抄」不成立：

- **今天没有任何消费者。** 全仓（`lib/`、`web/src/`、skills）唯一引用它的是
  `lib/server/models.js` 自己和它的测试。`docs/aih-skills-roadmap.md` 里两个尚未
  实现的 skill 计划依赖它。
- **Node 自己承认这有兼容风险。** 同文件注释写明：除 `aih_modalities` 外其余自定义
  字段都被剥掉，因为 Claude Code 这类严格客户端可能拒绝带未知字段的模型对象。

也就是说 Node 为一个还没人用的字段，在「所有客户端都会调用」的最热路径上长期
担着 schema 风险。这是本仓的设计选择，不是 provider 契约，没有理由继承。

**Go 侧的目标设计：`/v1/models` 默认严格标准形状，模态经显式 opt-in 暴露**
（`?include=modalities`，与 Node 已有的 `?capability=` 过滤同一风格）。默认响应
零风险，需要能力发现的调用方明确要求才拿到扩展数据，roadmap 里的
`aih_context_length` 也能挂在同一机制上而不再加一个内联字段。

数据源仍需在 Go 侧引入模态索引（models.dev），这部分工作量不变。

### 2. `/v1/responses`：谁更贴近 OpenAI 契约要按契约判，不按 Node 判

Go 多出 `completed_at`、`error`、`text.format`、`tools`，以及
`usage.input_tokens_details` / `usage.output_tokens_details`；Node 更精简。

**不能因为 Node 少发就认定 Go 多余。** 判据是 OpenAI Responses API 契约与真实
客户端的解析行为，两种结论都可能成立（Node 漏发 / Go 冗余）。此项待逐字段对照
契约后定论，未定之前不改任何一侧。

### 3. `/v1/messages`：分成两类，一类已修

权威是 Anthropic 真实响应（Node 在这条路径是字节透传，其输出恰好等于权威）。
首轮差异混着两类问题，分开后结论完全不同：

**(A) 序列化缺陷——已修。** `container`、`content[].citations`、
`usage.server_tool_use` 都是 Anthropic 的真实可选字段，Go 并没有自造数据；问题是
这些指针字段缺 `omitempty`，nil 被序列化成显式 `null`，而 Anthropic 缺省时是
**省略**。加上 `omitempty` 后三个幽灵字段消失，`content[]` 与上游逐字段一致。

首轮把这一类描述成「Go 注入了上游没发的字段」是不准确的，已纠正。

**(B) Canonical 模型的信息丢失——未修，切流硬门。** 剩余差异全部属于此类：

| 字段 | 上游 | Go |
| --- | --- | --- |
| `stop_details` | `null`（refusal 时有值） | 模型里没有该字段 |
| `usage.service_tier` | 字符串 | 模型里没有该字段 |
| `usage.inference_geo` | 字符串 | 恒 `null` |
| `usage.cache_creation` | 对象（1h/5m 分项） | 恒 `null` |

这四个不是打 tag 能解决的，需要 Canonical 响应模型承载它们。计费与缓存可观测性
依赖 `usage.*`，`stop_details` 是 refusal 分类的唯一出口。

### 结论

- 1：不照抄，按 opt-in 重新设计；模态数据源仍要补。
- 2：待对照 OpenAI 契约定论，未定不动。
- 3：(A) 已修；(B) 四个字段是切流硬门。

影子比对应在每次改动 Canonical 编解码后重跑。

## 维护

路径清单会随开发漂移。重新采集：

```bash
node scripts/collect-gateway-routes.js            # 打印分组清单
node scripts/collect-gateway-routes.js --json     # 机器可读，供 CI 比对
```
