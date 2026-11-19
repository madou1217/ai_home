package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
)

// ErrInvalidSchemaValidation 表示校验调用缺少数据库或上下文。
var ErrInvalidSchemaValidation = errors.New("账号数据库 schema 校验参数无效")

// ValidateSchema 只读检查 AIH 数据库身份和运行时必需的表、列、索引及触发器。
// 额外表和列不影响兼容性；不读取、写入或比较数据库结构版本号。
func ValidateSchema(ctx context.Context, db *sql.DB) error {
	if ctx == nil || db == nil {
		return ErrInvalidSchemaValidation
	}
	connection, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = connection.Close() }()
	return ValidateSchemaConn(ctx, connection)
}
