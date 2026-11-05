// Package zcodecred 解密 ZCode 桌面端写入的凭据封装。
//
// 格式与 Node 的 zcode-credential.js 一致：`enc:v1:<nonce>.<tag>.<ciphertext>`，
// AES-256-GCM，key = sha256(secret)；secret 优先取 ZCODE_CREDENTIAL_SECRET，
// 否则由平台/家目录/用户名派生（与 Node 同公式，保证同一台机器可互通）。
package zcodecred

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

const (
	// EnvelopePrefix 是加密值的固定前缀。
	EnvelopePrefix = "enc:v1:"
	// SecretEnv 是显式密钥环境变量。
	SecretEnv = "ZCODE_CREDENTIAL_SECRET"
	// FallbackSecretPrefix 是本机派生密钥的前缀。
	FallbackSecretPrefix = "zcode-credential-fallback"
)

// ErrInvalidEnvelope 表示密文格式或认证标签无效。
var ErrInvalidEnvelope = errors.New("zcode 凭据密文无效")

// IsEncrypted 判断值是否带加密前缀。
func IsEncrypted(value string) bool {
	return strings.HasPrefix(value, EnvelopePrefix)
}

// ResolveSecret 返回解密密钥：显式环境变量优先，否则按平台/家目录/用户名派生。
func ResolveSecret(explicit, platform, homeDir, username string) string {
	if value := strings.TrimSpace(explicit); value != "" {
		return value
	}
	if strings.TrimSpace(username) == "" {
		username = "unknown"
	}
	return FallbackSecretPrefix + ":" + platform + ":" + homeDir + ":" + username
}

// DecryptValue 解密一个 enc:v1 值；非加密值原样返回。
func DecryptValue(value, secret string) (string, bool) {
	if !IsEncrypted(value) {
		return value, true
	}
	parts := strings.Split(strings.TrimPrefix(value, EnvelopePrefix), ".")
	if len(parts) < 3 {
		return "", false
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(nonce) != 12 {
		return "", false
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(tag) != 16 {
		return "", false
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(strings.Join(parts[2:], "."))
	if err != nil {
		return "", false
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", false
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", false
	}
	combined := append(append([]byte(nil), ciphertext...), tag...)
	plaintext, err := gcm.Open(nil, nonce, combined, nil)
	if err != nil {
		return "", false
	}
	return string(plaintext), true
}
