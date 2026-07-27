package accounts

import (
	"errors"
	"strconv"
)

var (
	// ErrInvalidCLIAccountID 表示本机 CLI 数字别名不是规范正整数。
	ErrInvalidCLIAccountID = errors.New("CLI 账号别名无效")
)

// CLIAccountID 是供用户输入和展示的本机数字别名。
//
// 它不参与 AccountRef 派生，也不能作为数据库或运行时的账号主身份。
type CLIAccountID int64

// NewCLIAccountID 从 SQLite 有符号整数范围内的正数创建 CLI 账号别名。
func NewCLIAccountID(value int64) (CLIAccountID, error) {
	if value <= 0 {
		return 0, ErrInvalidCLIAccountID
	}
	return CLIAccountID(value), nil
}

// ParseCLIAccountID 解析不带符号、空白或前导零的规范十进制别名。
func ParseCLIAccountID(value string) (CLIAccountID, error) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 || strconv.FormatInt(parsed, 10) != value {
		return 0, ErrInvalidCLIAccountID
	}
	return CLIAccountID(parsed), nil
}

// Int64 返回适合持久化到 SQLite INTEGER 的值。
func (accountID CLIAccountID) Int64() int64 {
	return int64(accountID)
}

// String 返回规范十进制别名。
func (accountID CLIAccountID) String() string {
	return strconv.FormatInt(int64(accountID), 10)
}

// IsValid 判断 CLI 账号别名是否为正整数。
func (accountID CLIAccountID) IsValid() bool {
	return accountID > 0
}
