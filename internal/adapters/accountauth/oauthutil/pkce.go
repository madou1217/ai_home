// Package oauthutil 提供 Codex、Claude OAuth 适配器共享的无状态安全原语。
package oauthutil

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
)

// ErrInvalidRandomSource 表示系统随机源无法生成 OAuth 私有值。
var ErrInvalidRandomSource = errors.New("OAuth 安全随机源无效")

// PKCE 是 OAuth S256 Proof Key for Code Exchange 值。
type PKCE struct {
	Verifier  string
	Challenge string
}

// GeneratePKCE 创建指定随机字节长度的 URL-safe verifier 和 S256 challenge。
func GeneratePKCE(random io.Reader, byteLength int) (PKCE, error) {
	if random == nil || byteLength < 32 || byteLength > 96 {
		return PKCE{}, ErrInvalidRandomSource
	}
	buffer := make([]byte, byteLength)
	if _, err := io.ReadFull(random, buffer); err != nil {
		return PKCE{}, ErrInvalidRandomSource
	}
	verifier := base64.RawURLEncoding.EncodeToString(buffer)
	digest := sha256.Sum256([]byte(verifier))
	clear(buffer)
	return PKCE{
		Verifier:  verifier,
		Challenge: base64.RawURLEncoding.EncodeToString(digest[:]),
	}, nil
}

// GenerateState 创建指定随机字节长度的 URL-safe OAuth state。
func GenerateState(random io.Reader, byteLength int) (string, error) {
	if random == nil || byteLength < 16 || byteLength > 64 {
		return "", ErrInvalidRandomSource
	}
	buffer := make([]byte, byteLength)
	if _, err := io.ReadFull(random, buffer); err != nil {
		return "", ErrInvalidRandomSource
	}
	state := base64.RawURLEncoding.EncodeToString(buffer)
	clear(buffer)
	return state, nil
}

// clear 覆盖短期随机缓冲区，避免在堆上保留无用副本。
func clear(data []byte) {
	for index := range data {
		data[index] = 0
	}
}
