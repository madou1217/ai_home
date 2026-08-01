package accountsapi

import (
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

var (
	// ErrUnsupportedProvider 表示当前 HTTP 注册入口不支持指定 Provider。
	ErrUnsupportedProvider = errors.New("账号 HTTP Provider 不支持")
	// ErrInvalidAPIKeyInput 表示 API Key 或 Base URL 未通过 Provider 领域校验。
	ErrInvalidAPIKeyInput = errors.New("账号 HTTP API Key 输入无效")
	// ErrUnsupportedStaticAuthKind 表示 Provider 不支持请求中的静态凭据类型。
	ErrUnsupportedStaticAuthKind = errors.New("账号 HTTP 静态凭据类型不支持")
	// ErrInvalidStaticCredentialInput 表示静态凭据字段组合或领域值无效。
	ErrInvalidStaticCredentialInput = errors.New("账号 HTTP 静态凭据输入无效")
)

// APIKeyCredentialFactory 把 HTTP API Key 输入转换为 Provider 领域凭据。
type APIKeyCredentialFactory interface {
	Build(
		providerID string,
		apiKey string,
		baseURL string,
	) (accountapp.Credential, error)
}

// StaticCredentialFactory 把完整静态凭据 DTO 转换为 Provider 领域值。
type StaticCredentialFactory interface {
	BuildStatic(
		providerID string,
		kind string,
		apiKey string,
		authToken string,
		baseURL string,
	) (accountapp.Credential, error)
}

// apiKeyCredentialBuilder 是单个 Provider 的 API Key 构造策略。
type apiKeyCredentialBuilder func(
	apiKey string,
	baseURL string,
) (accountapp.Credential, error)

// BuiltinAPIKeyCredentialFactory 集中注册当前确认的 Codex、Claude 构造策略。
type BuiltinAPIKeyCredentialFactory struct {
	builders map[string]apiKeyCredentialBuilder
}

// NewBuiltinAPIKeyCredentialFactory 创建不包含 OAuth 或其他 Provider 的凭据工厂。
func NewBuiltinAPIKeyCredentialFactory() *BuiltinAPIKeyCredentialFactory {
	return &BuiltinAPIKeyCredentialFactory{
		builders: map[string]apiKeyCredentialBuilder{
			codex.ProviderID:  buildCodexAPIKeyCredential,
			claude.ProviderID: buildClaudeAPIKeyCredential,
		},
	}
}

// Build 使用精确 Provider ID 构造领域凭据，不修剪或猜测调用方输入。
func (factory *BuiltinAPIKeyCredentialFactory) Build(
	providerID string,
	apiKey string,
	baseURL string,
) (accountapp.Credential, error) {
	if factory == nil {
		return nil, ErrUnsupportedProvider
	}
	builder, found := factory.builders[providerID]
	if !found {
		return nil, ErrUnsupportedProvider
	}
	credential, err := builder(apiKey, baseURL)
	if err != nil {
		return nil, ErrInvalidAPIKeyInput
	}
	return credential, nil
}

// BuildStatic 严格区分 API Key 与 Claude Auth Token 字段。
func (factory *BuiltinAPIKeyCredentialFactory) BuildStatic(
	providerID string,
	kind string,
	apiKey string,
	authToken string,
	baseURL string,
) (accountapp.Credential, error) {
	if factory == nil {
		return nil, ErrUnsupportedProvider
	}
	switch kind {
	case "api_key":
		if authToken != "" {
			return nil, ErrInvalidStaticCredentialInput
		}
		credential, err := factory.Build(providerID, apiKey, baseURL)
		if errors.Is(err, ErrUnsupportedProvider) {
			return nil, err
		}
		if err != nil {
			return nil, ErrInvalidStaticCredentialInput
		}
		return credential, nil
	case "auth_token":
		if providerID != claude.ProviderID {
			if providerID == codex.ProviderID {
				return nil, ErrUnsupportedStaticAuthKind
			}
			return nil, ErrUnsupportedProvider
		}
		if apiKey != "" {
			return nil, ErrInvalidStaticCredentialInput
		}
		credential, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{
			AuthToken: authToken,
			BaseURL:   baseURL,
		})
		if err != nil {
			return nil, ErrInvalidStaticCredentialInput
		}
		return credential, nil
	default:
		return nil, ErrUnsupportedStaticAuthKind
	}
}

// buildCodexAPIKeyCredential 通过 Codex 领域构造器校验 API Key。
func buildCodexAPIKeyCredential(
	apiKey string,
	baseURL string,
) (accountapp.Credential, error) {
	return codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  apiKey,
		BaseURL: baseURL,
	})
}

// buildClaudeAPIKeyCredential 通过 Claude 领域构造器校验 API Key。
func buildClaudeAPIKeyCredential(
	apiKey string,
	baseURL string,
) (accountapp.Credential, error) {
	return claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey:  apiKey,
		BaseURL: baseURL,
	})
}
