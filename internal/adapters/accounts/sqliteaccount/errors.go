package sqliteaccount

import "errors"

var (
	// ErrInvalidOpenOptions 表示数据库目录或 Provider 合同缺失。
	ErrInvalidOpenOptions = errors.New("账号数据库打开参数无效")
	// ErrIncompatibleDatabase 表示目标文件不是当前版本支持的 aih.db。
	ErrIncompatibleDatabase = errors.New("账号数据库结构不兼容")
	// ErrInvalidCredential 表示凭据类型或 JSON 不满足 Provider codec 合同。
	ErrInvalidCredential = errors.New("账号凭据无效")
	// ErrInvalidProfileDocument 表示公开资料类型或 JSON 不满足 Provider codec 合同。
	ErrInvalidProfileDocument = errors.New("账号公开资料文档无效")
)
