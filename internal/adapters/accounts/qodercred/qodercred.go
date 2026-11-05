// Package qodercred 解密 Qoder CLI 写入的 opaque 凭据。
//
// Qoder CLI（1.1.x）把登录态写成 `.auth/user`（base64 密文）+ `.auth/machine_id`，
// 密文只能由 CLI 自带的 `qoder_auth_wasm_bg.wasm` 解开（导出
// `credential_storage_decrypt`，密钥是 machineId 前 16 个字符）。因此这里复用
// **厂商自己的 wasm**，用纯 Go 运行时（wazero）执行，不做密码学逆向。
//
// 与 Node `lib/account/qoder-credential-decrypt.js` 的纪律一致：
//   - 只在能读到 CLI 二进制时工作；任何一步失败都返回 ok=false（fail-open）；
//   - 明文只用于读取 token/身份，绝不回写、不落日志。
package qodercred

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
)

// Identity 是 opaque 凭据解出的明文载荷。
type Identity struct {
	// Payload 是完整明文 JSON（uid/email/security_oauth_token/...）。
	Payload map[string]any
	// UID 是身份主键（uid/user_id/account_id/id 中第一个非空值）。
	UID string
	// Token 是账号面令牌（security_oauth_token/access_token/token）。
	Token string
}

// Options 控制解密使用的宿主环境。
type Options struct {
	// HostHomeDir 是宿主 HOME（沙箱外）。为空时依次回退 AIH_HOST_HOME、os.UserHomeDir。
	HostHomeDir string
	// BinaryPath 是显式 CLI 二进制路径，优先于安装布局搜索（测试/诊断用）。
	BinaryPath string
}

const cacheLimit = 32

var (
	cacheMu    sync.Mutex
	cacheOrder []string
	cacheValue = map[string]Identity{}
)

// DecryptNative 解密 native_auth_json 里的 opaque credentials。
//
// ok=false 表示没有可解密的 blob，或本机 CLI/WASM 不可用——调用方应保持原有行为，
// 不要把「解不开」当成凭据无效。
func DecryptNative(provider string, native map[string]any, options Options) (Identity, bool) {
	blob := text(native["credentials"])
	machineID := text(native["machineId"])
	if !IsOpaqueCredential(blob) || machineID == "" || len(machineID) < 16 {
		return Identity{}, false
	}
	key := cacheKey(provider, blob, machineID)
	if identity, ok := cachedIdentity(key); ok {
		return identity.clone(), true
	}
	plaintext, err := DecryptBlob(provider, blob, machineID, options)
	if err != nil {
		return Identity{}, false
	}
	identity, ok := parseIdentity(plaintext)
	if !ok {
		return Identity{}, false
	}
	storeIdentity(key, identity)
	return identity.clone(), true
}

// DecryptBlob 用厂商 CLI 内嵌的 wasm 解密单个 base64 密文。
func DecryptBlob(provider, blob, machineID string, options Options) (string, error) {
	if !IsOpaqueCredential(blob) {
		return "", ErrNotOpaque
	}
	if len(machineID) < 16 {
		return "", ErrInvalidKey
	}
	wasmBytes, err := loadWasm(provider, options)
	if err != nil {
		return "", err
	}
	return decryptWithWasm(wasmBytes, blob, machineID[:16])
}

// IsOpaqueCredential 判断字符串是否是 CLI 写的 opaque blob。
//
// 可读 JSON 与 aih 自己的 `iv:tag:cipher` 由上层解析，不属于这里。
func IsOpaqueCredential(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	if strings.HasPrefix(trimmed, "{") {
		return false
	}
	return len(strings.Split(trimmed, ":")) != 3
}

// parseIdentity 把明文载荷拆成身份字段。
func parseIdentity(plaintext string) (Identity, bool) {
	trimmed := strings.TrimSpace(plaintext)
	if trimmed == "" {
		return Identity{}, false
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil || payload == nil {
		return Identity{}, false
	}
	identity := Identity{Payload: payload}
	identity.UID = firstText(payload, "uid", "user_id", "userId", "account_id", "accountId", "id")
	identity.Token = firstText(payload, "security_oauth_token", "access_token", "accessToken", "token")
	return identity, true
}

func (identity Identity) clone() Identity {
	cloned := Identity{UID: identity.UID, Token: identity.Token}
	if identity.Payload != nil {
		cloned.Payload = make(map[string]any, len(identity.Payload))
		for key, value := range identity.Payload {
			cloned.Payload[key] = value
		}
	}
	return cloned
}

func cacheKey(provider, blob, machineID string) string {
	digest := sha256.Sum256([]byte(provider + "\x00" + machineID + "\x00" + blob))
	return hex.EncodeToString(digest[:])
}

func cachedIdentity(key string) (Identity, bool) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	identity, ok := cacheValue[key]
	return identity, ok
}

func storeIdentity(key string, identity Identity) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if _, exists := cacheValue[key]; !exists {
		cacheOrder = append(cacheOrder, key)
	}
	cacheValue[key] = identity.clone()
	for len(cacheOrder) > cacheLimit {
		oldest := cacheOrder[0]
		cacheOrder = cacheOrder[1:]
		delete(cacheValue, oldest)
	}
}

func text(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return ""
	}
}

func firstText(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := text(values[key]); value != "" {
			return value
		}
	}
	return ""
}
