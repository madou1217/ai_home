package providerlaunch

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidCredentialDescriptor 表示脱敏凭据摘要包含未知或非规范值。
	ErrInvalidCredentialDescriptor = errors.New("Provider 启动凭据摘要无效")
)

// CredentialDescriptor 是允许进入日志和公开诊断的凭据类型摘要。
type CredentialDescriptor struct {
	kind string
	mode string
}

// NewCredentialDescriptor 创建不含 Token、Key、指纹或账号公开资料的凭据摘要。
func NewCredentialDescriptor(kind string, mode string) (CredentialDescriptor, error) {
	if !isDescriptorToken(kind) || (mode != "" && !isDescriptorToken(mode)) {
		return CredentialDescriptor{}, ErrInvalidCredentialDescriptor
	}
	return CredentialDescriptor{kind: kind, mode: mode}, nil
}

// Kind 返回 Provider 领域认证类型。
func (descriptor CredentialDescriptor) Kind() string {
	return descriptor.kind
}

// Mode 返回同一认证类型下的生命周期模式；非 OAuth 类型通常为空。
func (descriptor CredentialDescriptor) Mode() string {
	return descriptor.mode
}

// IsValid 判断凭据摘要是否仍为规范的小写标识。
func (descriptor CredentialDescriptor) IsValid() bool {
	return isDescriptorToken(descriptor.kind) &&
		(descriptor.mode == "" || isDescriptorToken(descriptor.mode))
}

// String 返回固定字段的脱敏凭据摘要。
func (descriptor CredentialDescriptor) String() string {
	return fmt.Sprintf(
		"providerlaunch.CredentialDescriptor{kind=%s,mode=%s}",
		descriptor.kind,
		descriptor.mode,
	)
}

// isDescriptorToken 校验 Provider、凭据类型和模式使用的小写稳定标识。
func isDescriptorToken(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') &&
			character != '_' && character != '-' {
			return false
		}
	}
	return true
}
