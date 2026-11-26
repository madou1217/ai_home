// Package secretkey 统一生成 AIH 对外密钥明文。
//
// server api key、management key 与客户端 API Key 共用同一套规则：
// 前缀 + 24 字节随机数的十六进制（48 字符）。这样所有密钥的熵、长度与字符集
// 一致，客户端看到的都是熟悉的 `sk-…` / `mk-…` 形态，而不是自定义命名空间。
package secretkey

import (
	"crypto/rand"
	"encoding/hex"
)

// entropyBytes 是明文随机部分的字节数；hex 编码后固定 48 个字符。
const entropyBytes = 24

// Generate 返回 prefix 加上 48 位十六进制随机串的密钥明文。
func Generate(prefix string) (string, error) {
	raw := make([]byte, entropyBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(raw), nil
}