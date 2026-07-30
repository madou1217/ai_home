// Package sqliteaccount 提供账号持久化端口的 SQLite 适配器。
package sqliteaccount

import _ "embed"

const (
	// ApplicationID 是 aih.db 的 SQLite application_id，十六进制表示为 0x41494831。
	ApplicationID = 1_095_321_649
	// SchemaVersion 是当前账号数据库只接受的结构版本。
	SchemaVersion = 2
)

// SchemaV1 是只用于全新 aih.db 的第一版完整结构。
//
//go:embed schema_v1.sql
var SchemaV1 string

// SchemaV2 是从既有 v1 前向增加账号模型关系的唯一 migration。
//
//go:embed schema_v2.sql
var SchemaV2 string
