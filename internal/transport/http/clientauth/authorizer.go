// Package clientauth 提供标准推理和模型目录共享的客户端密钥鉴权。
package clientauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

var (
	// ErrInvalidAuthorizer 表示客户端密钥提供端口缺失。
	ErrInvalidAuthorizer = errors.New("推理客户端鉴权配置无效")
)

// KeyProvider 返回当前生效的标准客户端密钥。
type KeyProvider func() string

// Authorizer 同时支持 OpenAI Bearer 和 Anthropic x-api-key 传递方式。
type Authorizer struct {
	key KeyProvider
}

// NewAuthorizer 创建不会长期复制明文客户端密钥的鉴权器。
func NewAuthorizer(key KeyProvider) (*Authorizer, error) {
	if key == nil {
		return nil, ErrInvalidAuthorizer
	}
	return &Authorizer{key: key}, nil
}

// Authorized 只接受一种无歧义传递方式，并使用常量时间摘要比较。
func (authorizer *Authorizer) Authorized(request *http.Request) bool {
	if authorizer == nil || authorizer.key == nil || request == nil {
		return false
	}
	provided, found := clientKeyFromRequest(request)
	expected := authorizer.key()
	if !found || expected == "" {
		return false
	}
	expectedDigest := sha256.Sum256([]byte(expected))
	providedDigest := sha256.Sum256([]byte(provided))
	return subtle.ConstantTimeCompare(
		expectedDigest[:],
		providedDigest[:],
	) == 1
}

// clientKeyFromRequest 拒绝重复、同时出现或包含空白的密钥头。
func clientKeyFromRequest(request *http.Request) (string, bool) {
	authorization := request.Header.Values("Authorization")
	apiKeys := request.Header.Values("x-api-key")
	if len(authorization) == 1 && len(apiKeys) == 0 {
		return parseBearerToken(authorization[0])
	}
	if len(authorization) == 0 && len(apiKeys) == 1 {
		value := apiKeys[0]
		return value, value != "" &&
			!strings.ContainsAny(value, " \t\r\n")
	}
	return "", false
}

// parseBearerToken 只接受单个不含空白的 Bearer Token。
func parseBearerToken(header string) (string, bool) {
	scheme, token, found := strings.Cut(header, " ")
	if !found ||
		!strings.EqualFold(scheme, "Bearer") ||
		token == "" ||
		strings.ContainsAny(token, " \t\r\n") {
		return "", false
	}
	return token, true
}
