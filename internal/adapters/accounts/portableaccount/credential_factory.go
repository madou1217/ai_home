package portableaccount

import (
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/accounts/gemini"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

var (
	// ErrUnsupportedProvider 表示当前 HTTP 注册入口不支持指定 Provider。
	ErrUnsupportedProvider = errors.New("账号 HTTP Provider 不支持")
	// ErrUnsupportedStaticAuthKind 表示 Provider 不支持请求中的静态凭据类型。
	ErrUnsupportedStaticAuthKind = errors.New("账号 HTTP 静态凭据类型不支持")
	// ErrInvalidStaticCredentialInput 表示静态凭据字段组合或领域值无效。
	ErrInvalidStaticCredentialInput = errors.New("账号 HTTP 静态凭据输入无效")
)

// StaticCredentialFactory 把完整静态凭据 DTO 转换为 Provider 领域值。
type StaticCredentialFactory interface {
	BuildStatic(
		providerID string,
		kind string,
		apiKey string,
		authToken string,
		baseURL string,
	) (accountapp.Credential, error)
	BuildVertex(
		providerID string,
		projectID string,
		location string,
		apiKey string,
		baseURL string,
		placeholder bool,
	) (accountapp.Credential, error)
}

// apiKeyCredentialBuilder 是单个 Provider 的 API Key 构造策略。
type apiKeyCredentialBuilder func(
	apiKey string,
	baseURL string,
) (accountapp.Credential, error)

// authTokenCredentialBuilder 是单个 Provider 的 Bearer 令牌构造策略。
type authTokenCredentialBuilder func(
	authToken string,
	baseURL string,
) (accountapp.Credential, error)

// BuiltinStaticCredentialFactory 集中注册当前确认的 Codex、Claude 静态凭据策略。
//
// 哪些 (Provider, 凭据类型) 组合被接受由账号 HTTP 契约声明；本工厂只负责给出
// 对应的领域构造器。契约与构造器不一致时 BuildStatic 报 ErrUnsupportedProvider，
// 不会构造出契约未声明的凭据。
type BuiltinStaticCredentialFactory struct {
	apiKeyBuilders    map[string]apiKeyCredentialBuilder
	authTokenBuilders map[string]authTokenCredentialBuilder
}

// NewBuiltinStaticCredentialFactory 创建不包含 OAuth 或其他 Provider 的凭据工厂。
func NewBuiltinStaticCredentialFactory() *BuiltinStaticCredentialFactory {
	return &BuiltinStaticCredentialFactory{
		apiKeyBuilders: map[string]apiKeyCredentialBuilder{
			codex.ProviderID:  buildCodexAPIKeyCredential,
			claude.ProviderID: buildClaudeAPIKeyCredential,
		},
		authTokenBuilders: map[string]authTokenCredentialBuilder{
			claude.ProviderID: buildClaudeAuthTokenCredential,
		},
	}
}

// buildClaudeAuthTokenCredential 构造 Claude Code 独立认证令牌。
func buildClaudeAuthTokenCredential(
	authToken string,
	baseURL string,
) (accountapp.Credential, error) {
	return claude.NewAuthTokenAuth(claude.AuthTokenInput{
		AuthToken: authToken,
		BaseURL:   baseURL,
	})
}

// buildAPIKey 使用精确 Provider ID 构造领域凭据，不修剪或猜测调用方输入。
func (factory *BuiltinStaticCredentialFactory) buildAPIKey(
	providerID string,
	apiKey string,
	baseURL string,
) (accountapp.Credential, error) {
	if factory == nil {
		return nil, ErrUnsupportedProvider
	}
	builder, found := factory.apiKeyBuilders[providerID]
	if !found {
		return nil, ErrUnsupportedProvider
	}
	credential, err := builder(apiKey, baseURL)
	if err != nil {
		return nil, ErrInvalidStaticCredentialInput
	}
	return credential, nil
}

// buildAuthToken 使用精确 Provider ID 构造 Bearer 令牌凭据。
func (factory *BuiltinStaticCredentialFactory) buildAuthToken(
	providerID string,
	authToken string,
	baseURL string,
) (accountapp.Credential, error) {
	if factory == nil {
		return nil, ErrUnsupportedProvider
	}
	builder, found := factory.authTokenBuilders[providerID]
	if !found {
		return nil, ErrUnsupportedProvider
	}
	credential, err := builder(authToken, baseURL)
	if err != nil {
		return nil, ErrInvalidStaticCredentialInput
	}
	return credential, nil
}

// BuildStatic 严格区分 API Key 与 Bearer 令牌字段。
func (factory *BuiltinStaticCredentialFactory) BuildStatic(
	providerID string,
	kind string,
	apiKey string,
	authToken string,
	baseURL string,
) (accountapp.Credential, error) {
	if factory == nil {
		return nil, ErrUnsupportedProvider
	}
	if !accountcontract.IsStaticCredentialKind(kind) {
		return nil, ErrUnsupportedStaticAuthKind
	}
	switch accountcontract.StaticCredentialKind(kind) {
	case accountcontract.StaticCredentialAPIKey:
		if authToken != "" {
			return nil, ErrInvalidStaticCredentialInput
		}
		if !accountcontract.SupportsStaticCredential(providerID, accountcontract.StaticCredentialAPIKey) {
			return nil, unsupportedStaticCredential(providerID)
		}
		credential, err := factory.buildAPIKey(providerID, apiKey, baseURL)
		if errors.Is(err, ErrUnsupportedProvider) {
			return nil, err
		}
		if err != nil {
			return nil, ErrInvalidStaticCredentialInput
		}
		return credential, nil
	case accountcontract.StaticCredentialAuthToken:
		if !accountcontract.SupportsStaticCredential(providerID, accountcontract.StaticCredentialAuthToken) {
			return nil, unsupportedStaticCredential(providerID)
		}
		if apiKey != "" {
			return nil, ErrInvalidStaticCredentialInput
		}
		credential, err := factory.buildAuthToken(providerID, authToken, baseURL)
		if errors.Is(err, ErrUnsupportedProvider) {
			return nil, err
		}
		if err != nil {
			return nil, ErrInvalidStaticCredentialInput
		}
		return credential, nil
	default:
		return nil, ErrUnsupportedStaticAuthKind
	}
}

// unsupportedStaticCredential 区分「Provider 不支持静态凭据」与「不支持该凭据类型」。
func unsupportedStaticCredential(providerID string) error {
	if len(accountcontract.StaticCredentialKinds(providerID)) == 0 {
		return ErrUnsupportedProvider
	}
	return ErrUnsupportedStaticAuthKind
}

// BuildVertex 只支持 Gemini Vertex 占位凭据；其他 Provider 一律拒绝。
func (factory *BuiltinStaticCredentialFactory) BuildVertex(
	providerID string,
	projectID string,
	location string,
	apiKey string,
	baseURL string,
	placeholder bool,
) (accountapp.Credential, error) {
	if factory == nil || providerID != gemini.ProviderID {
		return nil, ErrUnsupportedProvider
	}
	credential, err := gemini.NewVertexAuth(gemini.VertexInput{
		ProjectID:   projectID,
		Location:    location,
		APIKey:      apiKey,
		BaseURL:     baseURL,
		Placeholder: placeholder,
	})
	if err != nil {
		return nil, ErrInvalidStaticCredentialInput
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
