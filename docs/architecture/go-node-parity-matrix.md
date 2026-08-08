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

## 第三步：影子比对结果（2026-08-08 首轮）

同一账号、同一时刻、同一请求分别发给 Node 9527 与 Go，比状态码与响应结构。
5 条探针全部 200，**3 条结构不一致**。

```bash
node scripts/gateway-shadow-compare.js \
  --node http://127.0.0.1:9527 --go http://127.0.0.1:19550 \
  --include-inference
```

### 1. `/v1/models`：Go 缺 `aih_modalities`

Node 每个模型附带输入/输出模态（`lib/server/models.js:81`），让客户端不必逐个探测
就能挑出支持视觉/出图的模型，数据源是 models.dev 元数据加保守家族兜底。

Go 侧没有 models.dev 集成，字段整体缺失。**这是切流的真实阻塞**：依赖该字段做
能力路由的客户端在 Go 上会退化成「所有模型都不支持视觉」。补齐需要在 Go 侧引入
模态索引，不是加个字段那么简单。

### 2. `/v1/responses`：Go 比 Node 多发字段

Go 多出 `completed_at`、`error`、`text.format`、`tools`，以及
`usage.input_tokens_details` / `usage.output_tokens_details`。方向与 1 相反——
Go 更贴近 OpenAI Responses 完整形状，Node 更精简。

严格客户端两个方向都可能出问题：多字段可能被 schema 校验拒绝，少字段可能触发
空指针。需要按真实客户端逐一确认取舍，不能想当然认为「多即更好」。

### 3. `/v1/messages`：Go 的重建丢了上游真实字段

**这条最关键，因为 Node 在这条路径上是字节透传，它的形状就是上游真相。**

Node（= Anthropic 原样）有而 Go 没有：`stop_details`、`usage.service_tier`、
`usage.cache_creation`（细分 1h/5m）、`usage.inference_geo`（真实取值）。

Go 有而上游没有：`container`、`content[].citations`、`usage.server_tool_use`，
且 `cache_creation` / `inference_geo` 恒为 `null`。

即 Canonical 重建既**丢了**上游真实信息，又**注入了**上游没发的空字段。计费与
缓存可观测性依赖 `usage.*`，这条必须在切流前对齐。

### 结论

切流前必须解决 1 与 3；2 需要按客户端确认。影子比对应在每次改动 Canonical
编解码后重跑。

## 维护

路径清单会随开发漂移。重新采集：

```bash
node scripts/collect-gateway-routes.js            # 打印分组清单
node scripts/collect-gateway-routes.js --json     # 机器可读，供 CI 比对
```
