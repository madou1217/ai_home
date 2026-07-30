package aihserver

import (
	"errors"
	"log"
	"strings"
	"unicode"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

const (
	// MinManagementKeyLength 与当前 Server Management Key 的最小长度合同一致。
	MinManagementKeyLength = 32
	// MaxManagementKeyLength 防止异常请求头和配置占用无界内存。
	MaxManagementKeyLength = 8192
)

var (
	// ErrInvalidOptions 表示 Go Server Host 缺少启动所需依赖。
	ErrInvalidOptions = errors.New("go server host 配置无效")
	// ErrInvalidManagementKey 表示 Management Key 不满足安全合同。
	ErrInvalidManagementKey = errors.New("management key 必须为 32-8192 个非空白且非控制字符")
)

// Options 是创建 Go Server Host 所需的最小依赖。
type Options struct {
	// AIHomeDir 是唯一业务数据库 aih.db 所在的数据根目录。
	AIHomeDir string
	// ManagementKey 返回当前生效的 Server Management Key。
	ManagementKey func() string
	// ErrorLog 接收 net/http 连接级错误，不记录请求体或凭据。
	ErrorLog *log.Logger
	// ModelDiscoverers 允许嵌入方注入无网络测试策略；生产留空时装配 Codex/Claude。
	ModelDiscoverers []accountapp.ProviderModelDiscoverer
}

// ValidateManagementKey 校验 Bearer 请求头可安全表达的 Management Key。
func ValidateManagementKey(value string) error {
	if len(value) < MinManagementKeyLength ||
		len(value) > MaxManagementKeyLength ||
		value != strings.TrimSpace(value) ||
		strings.IndexFunc(value, unicode.IsSpace) >= 0 ||
		strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return ErrInvalidManagementKey
	}
	return nil
}

// validateOptions 在打开数据库或监听端口前完成失败关闭校验。
func validateOptions(options Options) error {
	if strings.TrimSpace(options.AIHomeDir) == "" || options.ManagementKey == nil {
		return ErrInvalidOptions
	}
	if err := ValidateManagementKey(options.ManagementKey()); err != nil {
		return err
	}
	return nil
}
