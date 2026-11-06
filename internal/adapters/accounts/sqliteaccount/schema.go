// Package sqliteaccount 提供账号持久化端口的 SQLite 适配器。
package sqliteaccount

import _ "embed"

const (
	// ApplicationID 是 aih.db 的 SQLite application_id，十六进制表示为 0x41494831。
	ApplicationID = 1_095_321_649
	// SchemaVersion 是当前账号数据库只接受的结构版本。
	SchemaVersion = 26
)

// SchemaV1 是只用于全新 aih.db 的第一版完整结构。
//
//go:embed schema_v1.sql
var SchemaV1 string

// SchemaV2 是从既有 v1 前向增加账号模型关系的唯一 migration。
//
//go:embed schema_v2.sql
var SchemaV2 string

// SchemaV3 是从既有 v2 前向增加账号当前额度快照的唯一 migration。
//
//go:embed schema_v3.sql
var SchemaV3 string

// SchemaV4 把可轮换凭据的查重引用与稳定 AccountRef 分离。
//
//go:embed schema_v4.sql
var SchemaV4 string

// SchemaV5 增加每个 Provider 唯一的默认启动账号关系。
//
//go:embed schema_v5.sql
var SchemaV5 string

// SchemaV6 把 Codex 工作区提升为 account_profiles 的公开列。
//
//go:embed schema_v6.sql
var SchemaV6 string

// SchemaV7 增加账号请求结果的时间桶聚合（账号状态页）。
//
//go:embed schema_v7.sql
var SchemaV7 string

// SchemaV8 增加跨重启保留的账号模型冷却状态。
//
//go:embed schema_v8.sql
var SchemaV8 string

// SchemaV9 增加 Go 自有的成功推理 token 用量事实账本。
//
//go:embed schema_v9.sql
var SchemaV9 string

// SchemaV10 增加账号 ref 与静态密钥指纹的删除墓碑。
//
//go:embed schema_v10.sql
var SchemaV10 string

// SchemaV11 保存采集方生产的完整 Provider 额度快照文档（WebUI 展示真相）。
//
//go:embed schema_v11.sql
var SchemaV11 string

// SchemaV12 在快照文档上物化账号级额度状态，供 Node 服务端与 CLI 共同读取。
//
//go:embed schema_v12.sql
var SchemaV12 string

// SchemaV13 保存账号页展示状态（status / displayName / authMode / baseUrl）。
//
//go:embed schema_v13.sql
var SchemaV13 string

// SchemaV14 保存账号级失败阻塞（auth_invalid / rate_limited / permission_denied）。
//
//go:embed schema_v14.sql
var SchemaV14 string

// SchemaV15 在账号展示状态上物化 configured 与 OAuth 待登录判定。
//
//go:embed schema_v15.sql
var SchemaV15 string

// SchemaV16 保存账号级运行态文档，Go 负责持久化与派生。
//
//go:embed schema_v16.sql
var SchemaV16 string

// SchemaV17 保存 OAuth Job 的公开快照（不含授权码、state、PKCE、Token）。
//
//go:embed schema_v17.sql
var SchemaV17 string

// SchemaV18 保存额度窗口采样，供按窗口期（5h / 7 天 / 30 天）统计消耗。
//
//go:embed schema_v18.sql
var SchemaV18 string

// SchemaV19 保存窗口账本、重置检测基线与本机识别出的额度重置事件。
//
//go:embed schema_v19.sql
var SchemaV19 string

// SchemaV20 在账号当前额度快照上补 Provider 归一后的套餐标识。
//
//go:embed schema_v20.sql
var SchemaV20 string

// SchemaV21 保存账号模型探测事实（时刻 / 来源 / 错误 / 模型数）。
//
// 探测事实与 account_models 分开：目录快照会被失败刷新保留，而探测结果必须反映
// 最近一次尝试，两者生命周期不同。
//
//go:embed schema_v21.sql
var SchemaV21 string

// SchemaV22 保存 Go 自有的模型别名表与代次。
//
// 别名所有权最终要迁到 Go：这张表让 Go 重启后能自己恢复，而不是等 Node 再推一次。
// generation 单调递增，路由编译靠它判断快照新旧。
//
//go:embed schema_v22.sql
var SchemaV22 string

// SchemaV23 给别名补 display_models_json：通配别名的展示名单不能只活在内存里。
//
//go:embed schema_v23.sql
var SchemaV23 string

// SchemaV24 保存账号额度探针的最近结果（由 Node 执行并推送）。
//
//go:embed schema_v24.sql
var SchemaV24 string

// SchemaV25 保存账号级 Go 路由排除（自定义上游账号必须永远不进 Go 候选）。
//
//go:embed schema_v25.sql
var SchemaV25 string

// SchemaV26 给 usage_ledger 加幂等导入键（Node 历史 token 事实并账用）。
//
//go:embed schema_v26.sql
var SchemaV26 string
