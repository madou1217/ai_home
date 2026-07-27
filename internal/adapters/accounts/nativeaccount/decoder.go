// Package nativeaccount 把 Codex、Claude 官方认证 artifact 转换为账号应用层输入。
//
// 该适配器只处理已经研究确认的官方格式，不读取文件、不访问旧数据库，也不把原始
// Token 或 Key 写入错误文本。
package nativeaccount

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/claude/nativeauth"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
)

const maxArtifactBytes = 1024 * 1024

// ErrInvalidNativeArtifacts 表示官方认证 artifact 缺失、损坏或彼此不一致。
var ErrInvalidNativeArtifacts = errors.New("provider 原生账号 artifact 无效")

// decodeStrategy 是单个 Provider 官方 artifact 的转换策略。
type decodeStrategy func(
	artifactsJSON []byte,
) (accountapp.Credential, accountapp.PublicProfile, error)

// Decoder 通过固定注册表选择 Codex、Claude 原生账号转换策略。
type Decoder struct {
	strategies map[string]decodeStrategy
}

// NewDecoder 创建不持有文件系统或网络依赖的内置策略注册表。
func NewDecoder() *Decoder {
	return &Decoder{
		strategies: map[string]decodeStrategy{
			"codex":  decodeCodex,
			"claude": decodeClaude,
		},
	}
}

// Supports 判断 Provider 是否已经注册原生账号转换策略。
func (decoder *Decoder) Supports(providerID string) bool {
	if decoder == nil {
		return false
	}
	_, found := decoder.strategies[providerID]
	return found
}

// Decode 选择 Provider 策略，并返回统一凭据和可选公开资料。
func (decoder *Decoder) Decode(
	providerID string,
	artifactsJSON []byte,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	if !decoder.Supports(providerID) {
		return nil, nil, invalidArtifacts("Provider 转换策略不存在")
	}
	return decoder.strategies[providerID](artifactsJSON)
}

// decodeCodex 解码官方 auth.json，并为 OAuth 账号派生公开资料。
func decodeCodex(
	artifactsJSON []byte,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	rawArtifacts, err := decodeArtifactObject(
		artifactsJSON,
		"auth_json",
	)
	if err != nil {
		return nil, nil, invalidArtifacts("Codex artifact 结构无效")
	}
	auth, err := authfile.Decode(
		rawArtifacts["auth_json"],
		authfile.DecodeOptions{},
	)
	if err != nil {
		return nil, nil, invalidArtifacts("Codex auth.json 无效")
	}
	switch value := auth.(type) {
	case *codex.OAuthAuth:
		profile, profileErr := codex.NewAccountProfile(value.Profile())
		if profileErr != nil {
			return nil, nil, invalidArtifacts("Codex OAuth 公开资料无效")
		}
		return value, profile, nil
	case *codex.APIKeyAuth:
		return value, nil, nil
	default:
		return nil, nil, invalidArtifacts("Codex 认证类型不受支持")
	}
}

// decodeClaude 原子组合官方 secure storage 与全局 oauthAccount 配置。
func decodeClaude(
	artifactsJSON []byte,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	rawArtifacts, err := decodeArtifactObject(
		artifactsJSON,
		"credentials_json",
		"global_config_json",
	)
	if err != nil {
		return nil, nil, invalidArtifacts("Claude artifact 结构无效")
	}
	decoded, err := nativeauth.DecodeOAuth(
		rawArtifacts["credentials_json"],
		rawArtifacts["global_config_json"],
	)
	if err != nil {
		return nil, nil, invalidArtifacts("Claude OAuth artifact 无效")
	}
	profile, err := claude.NewAccountProfile(
		decoded.Profile,
		decoded.Subscription,
	)
	if err != nil {
		return nil, nil, invalidArtifacts("Claude OAuth 公开资料无效")
	}
	return decoded.Auth, profile, nil
}

// decodeArtifactObject 严格读取唯一顶层字段，并把嵌套官方 JSON 原样交给 Provider codec。
func decodeArtifactObject(
	data []byte,
	requiredKeys ...string,
) (map[string]json.RawMessage, error) {
	if len(data) == 0 || len(data) > maxArtifactBytes {
		return nil, ErrInvalidNativeArtifacts
	}
	allowed := make(map[string]struct{}, len(requiredKeys))
	for _, key := range requiredKeys {
		allowed[key] = struct{}{}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, ErrInvalidNativeArtifacts
	}
	values := make(map[string]json.RawMessage, len(requiredKeys))
	for decoder.More() {
		token, tokenErr := decoder.Token()
		key, valid := token.(string)
		if tokenErr != nil || !valid {
			return nil, ErrInvalidNativeArtifacts
		}
		if _, accepted := allowed[key]; !accepted {
			return nil, ErrInvalidNativeArtifacts
		}
		if _, duplicated := values[key]; duplicated {
			return nil, ErrInvalidNativeArtifacts
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, ErrInvalidNativeArtifacts
		}
		values[key] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, ErrInvalidNativeArtifacts
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidNativeArtifacts
	}
	if len(values) != len(requiredKeys) {
		return nil, ErrInvalidNativeArtifacts
	}
	return values, nil
}

// invalidArtifacts 只使用代码内固定原因构造脱敏边界错误。
func invalidArtifacts(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidNativeArtifacts, reason)
}
