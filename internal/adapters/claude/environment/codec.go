// Package environment 在 Claude 官方环境变量与静态认证领域值之间做严格转换。
//
// 该 Adapter 把 CLAUDE_CODE_OAUTH_TOKEN 保持为 OAuth，把 ANTHROPIC_API_KEY 与
// ANTHROPIC_AUTH_TOKEN 视为两种静态认证，不把复合请求头配置伪装成新账号类型。
package environment

import (
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/accounts/claude"
)

const (
	apiKeyName     = "ANTHROPIC_API_KEY"
	authTokenName  = "ANTHROPIC_AUTH_TOKEN"
	oauthTokenName = "CLAUDE_CODE_OAUTH_TOKEN"
	baseURLName    = "ANTHROPIC_BASE_URL"
)

// ErrInvalidEnvironment 表示环境中没有唯一、有效的 Claude 静态凭据。
var ErrInvalidEnvironment = errors.New("Claude 静态凭据环境无效")

// Decode 只读取 Claude Provider 官方环境变量并创建唯一认证值。
func Decode(values map[string]string) (claude.Auth, error) {
	apiKey, apiKeyConfigured, err := readCredential(values, apiKeyName)
	if err != nil {
		return nil, invalidEnvironment("ANTHROPIC_API_KEY 无效")
	}
	authToken, authTokenConfigured, err := readCredential(values, authTokenName)
	if err != nil {
		return nil, invalidEnvironment("ANTHROPIC_AUTH_TOKEN 无效")
	}
	oauthToken, oauthTokenConfigured, err := readCredential(values, oauthTokenName)
	if err != nil {
		return nil, invalidEnvironment("CLAUDE_CODE_OAUTH_TOKEN 无效")
	}
	configuredCount := 0
	for _, configured := range []bool{apiKeyConfigured, authTokenConfigured, oauthTokenConfigured} {
		if configured {
			configuredCount++
		}
	}
	if configuredCount != 1 {
		return nil, invalidEnvironment("必须且只能配置一种账号凭据")
	}
	baseURL := ""
	if values != nil {
		baseURL = values[baseURLName]
	}

	if apiKeyConfigured {
		auth, domainErr := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: apiKey, BaseURL: baseURL})
		if domainErr != nil {
			return nil, invalidEnvironment("API Key 不满足领域约束")
		}
		return auth, nil
	}
	if oauthTokenConfigured {
		auth, domainErr := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{AccessToken: oauthToken, BaseURL: baseURL})
		if domainErr != nil {
			return nil, invalidEnvironment("OAuth Token 不满足领域约束")
		}
		return auth, nil
	}
	auth, domainErr := claude.NewAuthTokenAuth(claude.AuthTokenInput{AuthToken: authToken, BaseURL: baseURL})
	if domainErr != nil {
		return nil, invalidEnvironment("Auth Token 不满足领域约束")
	}
	return auth, nil
}

// Encode 把静态认证值写成唯一 Provider 环境变量集合。
func Encode(auth claude.Auth) (map[string]string, error) {
	switch value := auth.(type) {
	case *claude.APIKeyAuth:
		if value == nil {
			return nil, invalidEnvironment("认证对象为空")
		}
		validated, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: value.APIKey(), BaseURL: value.BaseURL()})
		if err != nil {
			return nil, invalidEnvironment("API Key 认证对象无效")
		}
		return encodeStatic(apiKeyName, validated.APIKey(), validated.BaseURL()), nil
	case *claude.AuthTokenAuth:
		if value == nil {
			return nil, invalidEnvironment("认证对象为空")
		}
		validated, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{AuthToken: value.AuthToken(), BaseURL: value.BaseURL()})
		if err != nil {
			return nil, invalidEnvironment("Auth Token 认证对象无效")
		}
		return encodeStatic(authTokenName, validated.AuthToken(), validated.BaseURL()), nil
	case *claude.OAuthTokenAuth:
		if value == nil {
			return nil, invalidEnvironment("认证对象为空")
		}
		validated, err := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{AccessToken: value.AccessToken(), BaseURL: value.BaseURL()})
		if err != nil {
			return nil, invalidEnvironment("OAuth Token 认证对象无效")
		}
		return encodeStatic(oauthTokenName, validated.AccessToken(), validated.BaseURL()), nil
	default:
		return nil, invalidEnvironment("认证对象类型不受支持")
	}
}

// readCredential 区分未设置、空值和只有空白的错误值。
func readCredential(values map[string]string, name string) (string, bool, error) {
	if values == nil {
		return "", false, nil
	}
	value, exists := values[name]
	if !exists || value == "" {
		return "", false, nil
	}
	if strings.TrimSpace(value) == "" {
		return "", false, errors.New("凭据只有空白")
	}
	return value, true, nil
}

// encodeStatic 省略官方默认 Base URL，避免制造无意义环境差异。
func encodeStatic(name string, secret string, baseURL string) map[string]string {
	values := map[string]string{name: secret}
	if baseURL != claude.DefaultAPIBaseURL {
		values[baseURLName] = baseURL
	}
	return values
}

// invalidEnvironment 用固定原因包装错误，禁止回显任何环境值。
func invalidEnvironment(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidEnvironment, strings.TrimSpace(reason))
}
