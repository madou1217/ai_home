# WebUI 组合根热点拆分

## 问题

并行会话反复同时修改 `composition.go`、`webuiroutes.go` 与 Provider 配置页，冲突的根因不是粗心，而是单文件承担了过多职责：

- 组合根：服务装配 + 路由依赖 + 运行辅助全在一个文件；
- 路由总装：SSH、账号、聊天、工具链、插件等所有域的路由都在一个函数里追加；
- egress：策略目录、账号解析、出口客户端过去存在多份实现。

## 已完成的拆分

| 热点 | 处理 | 结果 |
| --- | --- | --- |
| egress 策略目录 | 服务端 `ListStrategies` 唯一声明，前端只渲染 | 不再维护第二份策略清单 |
| 账号出口解析器 | `runtimeegress.NewAccountResolver` 唯一构造入口 | `npm run egress:check` 禁止业务层自行拼 Options |
| WebUI 出口依赖 | `webuiEgressDependencies` 嵌入 | 出口能力集中装配 |
| 出口客户端 | `relayegress` 端口 + `accountEgressClients` | Relay/图片/刷新/额度共用解析与连接池 |
| SSH 路由 | `webui_ssh_core_routes.go` | 新增 SSH 路由不再改路由总装函数 |
| 功能路由组 | `webui_feature_routes.go` | 新增一个域只改该文件 |
| 组合根运行辅助 | `composition_runtime_helpers.go` | `composition.go` 2851 → 2550 行 |

## 新代码应该落在哪里

- 新路由组：新建 `webui_<domain>_routes.go`，在 `webui_feature_routes.go` 追加一行装配；不要再往 `buildWebUIRoutes` 里塞静态路由。
- 新 egress 能力：在 `internal/runtime/egress` 增加端口/实现，由 `account_egress_clients.go` 统一取客户端；应用层只依赖 `application/accountegress.Decision`。
- 新 WebUI 依赖：优先收进现有能力结构（`webuiEgressDependencies` 等），不要继续平铺到 `webuiRouteDependencies` 顶层。
- 新组合根辅助：放 `composition_runtime_helpers.go` 或新建 `composition_<topic>.go`。

## 下一次拆分点

以下不是当前未完成项，而是后续继续降低冲突概率的候选：

- `newHandlers` 内的 credential refresh、egress runtime、WebUI dependency 三段装配；
- `web/src/features/provider-config/ProviderNetworkSettings.tsx`（893 行）按策略/池/SSH 分区拆组件。
