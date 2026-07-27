// Package nativeauth 提供 Claude 原生认证 artifact 的稳定组合入口。
package nativeauth

import (
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/oauthaccount"
	"github.com/madou1217/ai_home/internal/adapters/claude/securestorage"
)

// ErrInvalidNativeAuth 表示 Claude 原生身份或 secure storage 凭据不可组合。
var ErrInvalidNativeAuth = errors.New("Claude 原生 OAuth 无效")

// OAuthArtifacts 是官方身份配置与 secure storage 的分层组合结果。
type OAuthArtifacts struct {
	// Auth 是只包含凭据和稳定账号 UUID 的 OAuth 认证值。
	Auth *claude.OAuthAuth
	// Profile 是与凭据分离的完整公开账号资料。
	Profile claude.OAuthProfile
	// Subscription 是 secure storage 提供的 Claude.ai 订阅值。
	Subscription claude.Subscription
}

// DecodeOAuth 原子组合官方全局 oauthAccount 与 secure storage Token 容器。
func DecodeOAuth(credentialsJSON []byte, globalConfigJSON []byte) (OAuthArtifacts, error) {
	profile, err := oauthaccount.Decode(globalConfigJSON)
	if err != nil {
		return OAuthArtifacts{}, fmt.Errorf("%w: 身份 artifact 无效", ErrInvalidNativeAuth)
	}
	decoded, err := securestorage.Decode(
		credentialsJSON,
		securestorage.DecodeOptions{Identity: profile.Identity()},
	)
	if err != nil {
		return OAuthArtifacts{}, fmt.Errorf("%w: 凭据 artifact 无效", ErrInvalidNativeAuth)
	}
	return OAuthArtifacts{
		Auth:         decoded.Auth,
		Profile:      profile,
		Subscription: decoded.Subscription,
	}, nil
}
