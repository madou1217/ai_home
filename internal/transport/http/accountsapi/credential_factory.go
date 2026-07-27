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
)

// APIKeyCredentialFactory 把 HTTP API Key 输入转换为 Provider 领域凭据。
type APIKeyCredentialFactory interface {
	Build(
		providerID string,
		apiKey string,
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
