# Go Global Model Catalog Projection Design

## Goal

让 Go Core 在 Node 继续负责远端模型探测与全局合并的期间，能够展示与 Node 相同的
`/v1/models` 全局目录，同时严格保持 Go 的可路由模型集合独立，避免把 Node-only
Provider 的模型错误交给 Go 推理。

## Scope

本阶段只迁移「全局目录展示投影」和其管理同步合同，不迁移 Provider 模型探测、插件
模型发现、SWR 缓存所有权或公开 `9527` 的 `gateway.models.list` ownership。Node 仍是
目录真相源和公开入口 owner；Go 负责接收最近一次完整投影并在私有预览端点提供同一目录。

本阶段明确不改变：

- Go 的账号模型发现、路由候选、账号 cooldown 或 Provider 选择；
- Node `goRoutableModelIds` 的语义。它必须继续来自 Go 本地可路由索引，而不是公共投影；
- `/v1/models/{id}` 的任意 ID 回显合同；
- Node 公开 `/v1/models` 的鉴权、缓存、远端探测和 capability 过滤入口。

## Architecture

### Node source and publication

`lib/server/v1-router.js` 在 auto 模式构造完整 `globalModelsCache` 后，调用 Go Core Host
的 `pushModelCatalogProjection`。投影包含一个 Node 目录 revision 和已经完成过滤前的
完整模型项（ID、owned_by、模态、reasoning efforts），不携带 `created` 时间戳。Node
按 revision 去重推送；Go 未就绪、网络失败或投影被拒绝时，Node 的公开目录响应不受影响，
并保留上一次成功投影。

Go Core 重启后，Host 从当前 Node 内存缓存重新推送一次；若 Node 尚未建立全局缓存，Go
继续用本地目录作为公共目录的冷启动回退。投影成功后返回 Go generation、revision 和
接受数量，Host 把这些状态暴露在 `/readyz` 的 `model_catalog` 字段中。

### Go projection boundary

新增 `application/modelcatalog` 不可变快照 Store，负责：

- 校验 ID 唯一、顺序稳定、模态非空且无重复、reasoning effort 合法；
- 整体替换快照，拒绝部分应用；
- 保存 revision 与本地 generation；
- 并发读取公共目录。

新增 `internal/transport/http/modelcatalogapi`：

- `PUT /v1/management/model-catalog`：只接受 Go management key，整体替换投影；
- `GET /v1/management/model-catalog`：返回投影状态和 Go 本地可路由模型 ID，供 Node
  更新 `goRoutableModelIds`，不把公共投影误当成路由能力。

`internal/transport/http/modelsapi` 增加可选的 `modelcatalog.Reader`。当投影 generation
大于零时，标准和 Codex 目录都渲染投影快照；没有投影时继续渲染本地 `RoutableModel`
索引。capability 过滤读取投影携带的模态，reasoning efforts 读取投影携带的档位，
不再因为 Node-only 模型缺少 Go 本地账号而被隐藏。

### Routing safety

公共目录和路由目录是两个明确的端口：

- `ModelCatalogReader`：展示 Node 合并后的全局模型项；
- `RoutableModelReader`：Go 自己真实拥有账号和 Provider 能力的模型集合。

Node `refreshRoutableModels` 改为读取 `/v1/management/model-catalog` 的
`routable_model_ids`，不再读取公共 `/v1/models`。因此投影 `opencode/*`、`cline-*` 或
其它 Node-only 模型不会改变 Go 转发判定。

## Error handling and recovery

- PUT 请求正文大小、未知字段、重复 ID、非法模态或非法 reasoning effort：返回 400，
  保留旧快照。
- Node revision 未变化：Host 不发请求；Go revision 不会无意义递增。
- Go 管理端点不可用：Host 记录失败并保留上一份接受集合，Node 继续提供公开目录。
- Go 进程重启：公共投影清空前先由 Host 重新推送；推送完成前 Go 公共目录回退到本地，
  Go 路由仍只看本地索引。
- 投影数量上限固定在 Go 应用层，防止异常 Node 响应无限膨胀；上限错误不影响 Node
  公开响应，只在 readiness 中显示最近失败状态。

## Verification

1. Go application tests：快照替换、revision、顺序、重复、模态和 reasoning 校验。
2. Go HTTP tests：鉴权、整体拒绝、旧快照保留、GET 状态和 routable IDs。
3. Go models API tests：投影存在时公共目录包含 Node-only 模型，capability/reasoning
   字段来自投影；投影缺失时保留本地目录行为。
4. Node tests：global cache 构造后推送一次、revision 去重、Go 不可用不影响响应、
   routable IDs 从 management status 读取。
5. Live shadow：Node 9527 与 Go 私有端点的 `/v1/models`、`capability=vision`、
   `capability=image_out` 的 ID 集合、顺序、owned_by、modalities 和 reasoning efforts
   一致；同时验证一个 Node-only 模型请求仍由 Node fallback，不会进入 Go。

## Rollback

删除或关闭投影推送后，Go generation 回到零并继续使用本地模型目录；Node 公开目录和
推理路由不依赖该投影。若新端点或渲染出现问题，只需停止将 `gateway.models.list`
切到 Go，现有 manifest ownership 不变。
