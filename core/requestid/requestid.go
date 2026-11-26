// Package requestid 为每次网关请求分配并传播稳定的 Request ID。
//
// 客户端可以自带（X-Request-Id），否则由网关生成；同一个 ID 会进入响应头、
// 请求 Context 以及按天日志里的结构化事件，用户报错时只需提供这个值，
// 就能在 ~/.ai_home/logs/server/YYYY-MM-DD.log 中还原整条请求链路。
package requestid

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
)

const (
	// HeaderName 是请求/响应共用的 ID 头。
	HeaderName = "X-Request-Id"
	// maxLength 限制客户端可注入的 ID 长度，避免把日志行撑坏。
	maxLength = 128
	// generatedPrefix 标记网关生成的 ID，便于和客户端自带值区分。
	generatedPrefix = "req-"
)

type contextKey struct{}

// New 生成一个新的网关 Request ID。
func New() string {
	var buffer [8]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return generatedPrefix + "0000000000000000"
	}
	return generatedPrefix + hex.EncodeToString(buffer[:])
}

// Sanitize 校验客户端提供的 ID：只接受可见 ASCII、长度受限；不合法时返回空串。
func Sanitize(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > maxLength {
		return ""
	}
	for _, char := range trimmed {
		switch {
		case char >= 'a' && char <= 'z',
			char >= 'A' && char <= 'Z',
			char >= '0' && char <= '9',
			char == '-', char == '_', char == '.', char == ':':
			continue
		default:
			return ""
		}
	}
	return trimmed
}

// WithContext 把 ID 放进 Context；空 ID 原样返回。
func WithContext(ctx context.Context, id string) context.Context {
	if ctx == nil || id == "" {
		return ctx
	}
	return context.WithValue(ctx, contextKey{}, id)
}

// FromContext 读取当前请求的 ID；没有时返回空串。
func FromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(contextKey{}).(string)
	return id
}