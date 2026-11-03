// Package accounts 定义与具体 Provider 凭据实现解耦的账号基础领域模型。
//
// 该包只负责稳定身份、CLI 数字别名和用户启停生命周期，不依赖数据库、
// Server、文件系统、网络、额度、模型目录或运行态。
package accounts

import (
	"errors"
	"strings"
)

var (
	// ErrInvalidIdentity 表示账号身份来源缺少规范 Provider 或稳定身份种子。
	ErrInvalidIdentity = errors.New("账号身份无效")
)

// IdentitySource 是 Provider 认证值暴露给账号基础领域的最小身份合同。
//
// 接口不暴露凭据、认证类型或公开资料，Account 也不会保存 IdentitySeed。
type IdentitySource interface {
	ProviderID() string
	IdentitySeed() string
}

// readIdentitySource 校验身份来源并返回规范 Provider 与稳定身份种子。
func readIdentitySource(source IdentitySource) (string, string, error) {
	if source == nil {
		return "", "", ErrInvalidIdentity
	}
	providerID := source.ProviderID()
	identitySeed := source.IdentitySeed()
	if !isCanonicalProviderID(providerID) || !isCanonicalIdentitySeed(identitySeed) {
		return "", "", ErrInvalidIdentity
	}
	return providerID, identitySeed, nil
}

// isCanonicalProviderID 限制内部 Provider ID 为稳定的小写标识。
func isCanonicalProviderID(value string) bool {
	if value == "" || value != strings.TrimSpace(value) || len(value) > 64 {
		return false
	}
	lastIndex := len(value) - 1
	for index, character := range value {
		if character >= 'a' && character <= 'z' {
			continue
		}
		if character >= '0' && character <= '9' {
			continue
		}
		if index > 0 && index < lastIndex && (character == '-' || character == '_') {
			continue
		}
		return false
	}
	return true
}

// isCanonicalIdentitySeed 拒绝空白、控制字符和已废弃身份来源。
func isCanonicalIdentitySeed(value string) bool {
	if value == "" || value != strings.TrimSpace(value) || strings.HasPrefix(value, "legacy:") {
		return false
	}
	return strings.IndexFunc(value, func(character rune) bool {
		return character < 0x20 || character == 0x7f
	}) < 0
}
