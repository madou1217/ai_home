package zcodecred

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// EncryptValue 把明文封装成 enc:v1:<nonce>.<tag>.<ciphertext>（AES-256-GCM，
// key = sha256(secret)），与 DecryptValue / Node zcode-credential.js 同格式。
func EncryptValue(value, secret string) (string, error) {
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", ErrInvalidEnvelope
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", ErrInvalidEnvelope
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", ErrInvalidEnvelope
	}
	sealed := gcm.Seal(nil, nonce, []byte(value), nil)
	tagStart := len(sealed) - gcm.Overhead()
	ciphertext := sealed[:tagStart]
	tag := sealed[tagStart:]
	encoded := EnvelopePrefix +
		base64.RawURLEncoding.EncodeToString(nonce) + "." +
		base64.RawURLEncoding.EncodeToString(tag) + "." +
		base64.RawURLEncoding.EncodeToString(ciphertext)
	return encoded, nil
}

// IsEncryptedValue 是 IsEncrypted 的别名，便于调用方按「值」语义命名。
func IsEncryptedValue(value string) bool {
	return IsEncrypted(strings.TrimSpace(value))
}
