// Package clientkeys 定义客户端 API Key 的纯领域模型。
//
// 一把「总 key」仍由 config:server.apiKey 提供；本包描述在其之上新增的
// 多把托管 Key：身份、密钥格式与请求上下文。密钥只在创建/轮换时以明文出现
// 一次，持久层只保存 SHA-256 摘要与前缀。本包不依赖数据库、HTTP 或配置。
package clientkeys

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

const (
	// SecretPrefix 是托管 Key 的固定前缀，便于日志与界面识别（不含任何秘密熵）。
	SecretPrefix = "aihk_"
	// MasterKeyID 是总 key 在统计里的稳定身份。
	MasterKeyID = "master"
	keyIDPrefix = "ck_"
	keyIDHexLen = 12
	secretBytes = 32
)

// ErrInvalidSecret 表示客户端 Key 的字符串形态不合法。
var ErrInvalidSecret = errors.New("客户端 API Key 格式无效")

// Limits 是一把 Key 的限流字段；0 表示不限/继承。
//
// 并发、RPM、TPM 与每日 token 由 application/admission 执行；AllowedProviders
// 与 AllowedModels 由路由解析层（application/inferencegateway.ScopedRoutes）执行：
// 空列表表示不限制，非空时分别限定可使用的账号池（Provider）与模型。
type Limits struct {
	MaxConcurrency   int
	RPMLimit         int
	TPMLimit         int
	DailyTokenLimit  int
	AllowedProviders []string
	AllowedModels    []string
}

// Key 是一把托管客户端 Key 的持久化投影（不含明文）。
type Key struct {
	ID           string
	Name         string
	Prefix       string
	Enabled      bool
	CreatedAtMS  int64
	UpdatedAtMS  int64
	LastUsedAtMS int64
	RevokedAtMS  int64
	Limits       Limits
	Notes        string
}

// Active 判断这把 Key 当前是否允许鉴权。
func (key Key) Active() bool {
	return key.Enabled && key.RevokedAtMS == 0
}

// Identity 返回该 Key 的鉴权身份。
func (key Key) Identity() Identity {
	return Identity{KeyID: key.ID, Name: key.Name, Prefix: key.Prefix}
}

// AuthRecord 是鉴权快照的一行：只含摘要、展示信息与生效所需的限流字段。
type AuthRecord struct {
	KeyID  string
	Name   string
	Prefix string
	Hash   [32]byte
	Limits Limits
}

// 统计粒度。
const (
	GranularityMinute = "minute"
	GranularityHour   = "hour"
)

// RequestBucket 是请求级统计桶。
type RequestBucket struct {
	BucketMS int64
	KeyID    string
	Surface  string
	Requests int64
	Aborted  int64
}

// AttemptBucket 是尝试级统计桶（含 token）。
type AttemptBucket struct {
	BucketMS              int64
	KeyID                 string
	ProviderID            string
	ModelID               string
	AccountRef            string
	Attempts              int64
	Successes             int64
	Failures              int64
	Aborted               int64
	InputTokens           int64
	OutputTokens          int64
	CachedInputTokens     int64
	CacheWriteInputTokens int64
	ReasoningTokens       int64
	TotalTokens           int64
}

// RemoteSessionUsage 是远程执行会话维度的 token 聚合。
type RemoteSessionUsage struct {
	SessionID             string `json:"sessionId"`
	InputTokens           int64  `json:"inputTokens"`
	OutputTokens          int64  `json:"outputTokens"`
	CachedInputTokens     int64  `json:"cachedInputTokens"`
	CacheWriteInputTokens int64  `json:"cacheWriteInputTokens"`
	ReasoningTokens       int64  `json:"reasoningTokens"`
	TotalTokens           int64  `json:"totalTokens"`
	UpdatedAtMS           int64  `json:"updatedAtMs"`
}

// StatsQuery 是统计读取条件。
type StatsQuery struct {
	Granularity string
	FromMS      int64
	ToMS        int64
	KeyID       string
	ProviderID  string
	ModelID     string
	AccountRef  string
	Limit       int
}

// Identity 是已鉴权请求的调用方身份。
type Identity struct {
	KeyID  string
	Name   string
	Prefix string
	Master bool
}

// MasterIdentity 返回总 key 的身份。
func MasterIdentity() Identity {
	return Identity{KeyID: MasterKeyID, Name: "master", Master: true}
}

// IsValid 判断身份是否可用于归因与统计。
func (identity Identity) IsValid() bool {
	return strings.TrimSpace(identity.KeyID) != ""
}

// DisplayName 返回界面展示名：托管 Key 用名称，总 key 用固定标签。
func (identity Identity) DisplayName() string {
	if name := strings.TrimSpace(identity.Name); name != "" {
		return name
	}
	if identity.Master {
		return "master"
	}
	return identity.KeyID
}

type identityContextKey struct{}

// WithIdentity 把调用方身份写入请求上下文。
func WithIdentity(ctx context.Context, identity Identity) context.Context {
	if ctx == nil {
		return ctx
	}
	return context.WithValue(ctx, identityContextKey{}, identity)
}

// IdentityFromContext 读取请求上下文里的调用方身份。
func IdentityFromContext(ctx context.Context) (Identity, bool) {
	if ctx == nil {
		return Identity{}, false
	}
	identity, ok := ctx.Value(identityContextKey{}).(Identity)
	return identity, ok && identity.IsValid()
}

// Generate 生成一把新托管 Key。
//
// 返回的 raw 是唯一一次可以拿到的明文；hash 交给持久层；prefix 可安全展示。
func Generate() (raw string, keyID string, prefix string, hash [32]byte, err error) {
	idBytes := make([]byte, keyIDHexLen/2)
	if _, err = rand.Read(idBytes); err != nil {
		return "", "", "", hash, err
	}
	secret := make([]byte, secretBytes)
	if _, err = rand.Read(secret); err != nil {
		return "", "", "", hash, err
	}
	keyID = keyIDPrefix + hex.EncodeToString(idBytes)
	prefix = SecretPrefix + keyID
	encoded := base64.RawURLEncoding.EncodeToString(secret)
	raw = prefix + "." + encoded
	hash = sha256.Sum256([]byte(raw))
	return raw, keyID, prefix, hash, nil
}

// HashSecret 返回密钥明文的 SHA-256 摘要。
func HashSecret(raw string) [32]byte {
	return sha256.Sum256([]byte(strings.TrimSpace(raw)))
}

// ParseSecret 从明文里解析出 key_id，供鉴权按 id 查快照。
//
// 只做格式校验，不做保密比较；秘密比较由调用方用常量时间完成。
func ParseSecret(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, SecretPrefix) {
		return "", false
	}
	body := strings.TrimPrefix(trimmed, SecretPrefix)
	keyID, secret, found := strings.Cut(body, ".")
	if !found || secret == "" || len(secret) > 64 {
		return "", false
	}
	if !validKeyID(keyID) {
		return "", false
	}
	if _, err := base64.RawURLEncoding.DecodeString(secret); err != nil {
		return "", false
	}
	return keyID, true
}

func validKeyID(keyID string) bool {
	if !strings.HasPrefix(keyID, keyIDPrefix) {
		return false
	}
	suffix := strings.TrimPrefix(keyID, keyIDPrefix)
	if len(suffix) != keyIDHexLen {
		return false
	}
	for index := 0; index < len(suffix); index++ {
		character := suffix[index]
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
