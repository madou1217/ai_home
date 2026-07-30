package aihserver

import (
	"errors"
	"log"
	"strings"
	"unicode"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

const (
	// MinServerKeyLength 是 Client 与 Management Key 共用的最小长度。
	MinServerKeyLength = 32
	// MaxServerKeyLength 防止异常请求头和配置占用无界内存。
	MaxServerKeyLength = 8192
)

var (
	// ErrInvalidOptions 表示 Go Server Host 缺少启动所需依赖。
	ErrInvalidOptions = errors.New("go server host 配置无效")
	// ErrInvalidManagementKey 表示 Management Key 不满足安全合同。
	ErrInvalidManagementKey = errors.New("management key 必须为 32-8192 个非空白且非控制字符")
	// ErrInvalidClientKey 表示 Client Key 不满足安全合同。
	ErrInvalidClientKey = errors.New("client key 必须为 32-8192 个非空白且非控制字符")
	// ErrServerKeyCollision 表示管理权限和标准客户端权限没有使用独立密钥。
	ErrServerKeyCollision = errors.New("management key 与 client key 必须不同")
)

// Options 是创建 Go Server Host 所需的最小依赖。
type Options struct {
	// AIHomeDir 是唯一业务数据库 aih.db 所在的数据根目录。
	AIHomeDir string
	// ManagementKey 返回当前生效的 Server Management Key。
	ManagementKey func() string
	// ClientKey 返回标准推理和模型目录使用的 Client Key。
	ClientKey func() string
	// ErrorLog 接收 net/http 连接级错误，不记录请求体或凭据。
	ErrorLog *log.Logger
	// ModelDiscoverers 允许嵌入方注入无网络测试策略；生产留空时装配 Codex/Claude。
	ModelDiscoverers []accountapp.ProviderModelDiscoverer
}

// ValidateManagementKey 校验 Bearer 请求头可安全表达的 Management Key。
func ValidateManagementKey(value string) error {
	if !validBearerKey(value) {
		return ErrInvalidManagementKey
	}
	return nil
}

// ValidateClientKey 校验标准客户端 Bearer 请求头使用的密钥。
func ValidateClientKey(value string) error {
	if !validBearerKey(value) {
		return ErrInvalidClientKey
	}
	return nil
}

// ValidateServerKeys 校验两个权限域的密钥格式和相互隔离。
func ValidateServerKeys(managementKey string, clientKey string) error {
	if err := ValidateManagementKey(managementKey); err != nil {
		return err
	}
	if err := ValidateClientKey(clientKey); err != nil {
		return err
	}
	if managementKey == clientKey {
		return ErrServerKeyCollision
	}
	return nil
}

// validBearerKey 复用两个 HTTP 权限域相同的输入安全约束。
func validBearerKey(value string) bool {
	if len(value) < MinServerKeyLength ||
		len(value) > MaxServerKeyLength ||
		value != strings.TrimSpace(value) ||
		strings.IndexFunc(value, unicode.IsSpace) >= 0 ||
		strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return false
	}
	return true
}

// validateOptions 在打开数据库或监听端口前完成失败关闭校验。
func validateOptions(options Options) error {
	if strings.TrimSpace(options.AIHomeDir) == "" ||
		options.ManagementKey == nil ||
		options.ClientKey == nil {
		return ErrInvalidOptions
	}
	return ValidateServerKeys(options.ManagementKey(), options.ClientKey())
}
