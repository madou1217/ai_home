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
| `/v1/props` | ❌ **缺失** | 客户端能力协商 |
| `/v1/blobs/` | ❌ **缺失** | 二进制句柄（非视觉模型借视觉的通道） |
| `/v1beta/` | ❌ **缺失** | Gemini 兼容入口 |
| `/v1/` 兜底 | ❌ **缺失** | 未知 `/v1/*` 的统一处理 |

Go 已覆盖 A 档的 6 条核心，缺 4 条。**这 4 条就是第二步的全部工作量。**

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

## 第二步的工作清单（按依赖排序）

1. `/v1/props` —— 客户端能力协商，其它入口的前置。
2. `/v1/blobs/` —— 二进制句柄。
3. `/v1beta/` —— Gemini 兼容入口。
4. `/v1/` 兜底 —— 未知路径的统一处理，Go 现在落到全局 404。
5. 管理面命名空间对齐（B 档硬伤），需先决策。

## 维护

路径清单会随开发漂移。重新采集：

```bash
node scripts/collect-gateway-routes.js            # 打印分组清单
node scripts/collect-gateway-routes.js --json     # 机器可读，供 CI 比对
```
