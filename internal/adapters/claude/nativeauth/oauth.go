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

// DecodeOAuth 原子组合官方全局 oauthAccount 与 secure storage Token 容器。
func DecodeOAuth(credentialsJSON []byte, globalConfigJSON []byte) (*claude.OAuthAuth, error) {
	identity, err := oauthaccount.Decode(globalConfigJSON)
	if err != nil {
		return nil, fmt.Errorf("%w: 身份 artifact 无效", ErrInvalidNativeAuth)
	}
	auth, err := securestorage.Decode(credentialsJSON, securestorage.DecodeOptions{Identity: identity})
	if err != nil {
		return nil, fmt.Errorf("%w: 凭据 artifact 无效", ErrInvalidNativeAuth)
	}
	return auth, nil
}
