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

// Authorizer 同时支持 OpenAI Bearer、Anthropic x-api-key 与 Gemini x-goog-api-key 传递方式。
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

// clientKeyFromRequest 接受多种传递方式，但要求它们携带**完全相同**的密钥。
//
// x-goog-api-key 是 Gemini / Vertex 客户端（gemini CLI 的 vertex-ai 认证）的密钥头，
// 与 x-api-key 同等对待。
//
// 为什么不再要求「恰好出现一种」：CodeBuddy 的自定义模型会把同一个 apiKey 同时写进
// `Authorization: Bearer` 与 `X-API-Key`（2026-11-21 实测 2.185.0）。两个头值一致时
// 不存在歧义，按冲突拒绝会把合法客户端挡在 401；只有值不一致（真正的身份歧义）才拒绝。
// 重复头同样按「值必须全部一致」处理。
func clientKeyFromRequest(request *http.Request) (string, bool) {
	authorization := request.Header.Values("Authorization")
	apiKeys := append(
		append([]string{}, request.Header.Values("x-api-key")...),
		request.Header.Values("x-goog-api-key")...,
	)
	candidates := make([]string, 0, len(authorization)+len(apiKeys))
	for _, header := range authorization {
		token, ok := parseBearerToken(header)
		if !ok {
			return "", false
		}
		candidates = append(candidates, token)
	}
	for _, value := range apiKeys {
		if value == "" || strings.ContainsAny(value, " \t\r\n") {
			return "", false
		}
		candidates = append(candidates, value)
	}
	if len(candidates) == 0 {
		return "", false
	}
	key := candidates[0]
	for _, candidate := range candidates[1:] {
		if candidate != key {
			return "", false
		}
	}
	return key, true
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
