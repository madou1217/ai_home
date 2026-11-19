package sqliteaccount

// 本文件提供「给定数据库是否就是当前程序可用的账号库」的只读校验。
//
// 为什么需要它：数据分发（internal/runtime/distributiondata）要在不打开 Store 的
// 前提下判断一份已有 aih.db 是否已经就绪。把判断放在 sqliteaccount 里，schema
// 版本与 application_id 的唯一事实源就不会散落成外部猜测。

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ErrInvalidSchemaValidation 表示校验调用缺少数据库或上下文。
var ErrInvalidSchemaValidation = errors.New("账号数据库 schema 校验参数无效")

// ValidateSchema 校验数据库身份与应用版本都与当前构建一致。
//
// 只接受精确版本：低于当前版本需要先迁移，高于当前版本属于由更新程序写入的库，
// 两者都不能当作「已就绪」。任何读取失败都原样返回，调用方不得把它当成通过。
func ValidateSchema(ctx context.Context, db *sql.DB) error {
	if ctx == nil || db == nil {
		return ErrInvalidSchemaValidation
	}
	var applicationID int64
	if err := db.QueryRowContext(ctx, "PRAGMA application_id").Scan(&applicationID); err != nil {
		return fmt.Errorf("读取账号数据库 application_id 失败: %w", err)
	}
	if applicationID != ApplicationID {
		return fmt.Errorf("%w: application_id=%d", ErrIncompatibleDatabase, applicationID)
	}
	var schemaVersion int64
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&schemaVersion); err != nil {
		return fmt.Errorf("读取账号数据库 user_version 失败: %w", err)
	}
	if schemaVersion != SchemaVersion {
		return fmt.Errorf("%w: user_version=%d want %d", ErrIncompatibleDatabase, schemaVersion, SchemaVersion)
	}
	return nil
}
