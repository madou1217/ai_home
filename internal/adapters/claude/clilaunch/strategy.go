// Package clilaunch 把 Claude 领域凭据转换为共享原生状态的 Claude Code 启动描述。
package clilaunch

import (
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/environment"
)

const binaryName = "claude"

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 Claude 账号。
	ErrInvalidBinding = errors.New("Claude CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是当前领域允许的 Claude 认证类型。
	ErrUnsupportedCredential = errors.New("Claude CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的 Claude 启动描述。
	ErrBuildLaunchContext = errors.New("Claude CLI 启动描述构建失败")
)

// inheritedCredentialKeys 列出 Claude Code 当前可能从父进程继承的其他认证来源。
var inheritedCredentialKeys = []string{
	"ANTHROPIC_UNIX_SOCKET",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
}

// 编译期确认 Claude Strategy 满足应用层窄接口。
var _ providerlaunch.Strategy = (*Strategy)(nil)

// Strategy 负责四种 Claude 领域凭据的原生环境变量映射。
type Strategy struct{}

// NewStrategy 创建无状态 Claude CLI 启动策略。
func NewStrategy() *Strategy {
	return &Strategy{}
}

// ProviderID 返回策略唯一支持的 Claude Provider。
func (*Strategy) ProviderID() string {
	return claude.ProviderID
}

// Build 把静态凭据、长效 OAuth 或预刷新 OAuth 映射为唯一环境认证来源。
func (*Strategy) Build(
	binding accountapp.CredentialBinding,
) (providerlaunch.StrategyResult, error) {
	if !binding.IsValid() ||
		binding.ProviderID() != claude.ProviderID ||
		!binding.AccountRef().IsValid() {
		return providerlaunch.StrategyResult{}, ErrInvalidBinding
	}

	var values map[string]string
	var kind string
	var mode string
	var err error
	runtime := providerlaunch.NewDirectProcessRuntime()
	switch auth := binding.Credential().(type) {
	case *claude.APIKeyAuth:
		if auth == nil {
			return providerlaunch.StrategyResult{}, ErrInvalidBinding
		}
		values, err = environment.Encode(auth)
		kind = claude.AuthKindAPIKey.String()
	case *claude.AuthTokenAuth:
		if auth == nil {
			return providerlaunch.StrategyResult{}, ErrInvalidBinding
		}
		values, err = environment.Encode(auth)
		kind = claude.AuthKindAuthToken.String()
	case *claude.OAuthTokenAuth:
		if auth == nil {
			return providerlaunch.StrategyResult{}, ErrInvalidBinding
		}
		values, err = environment.Encode(auth)
		kind = claude.AuthKindOAuth.String()
		mode = claude.OAuthModeAccessToken.String()
	case *claude.OAuthAuth:
		if auth == nil {
			return providerlaunch.StrategyResult{}, ErrInvalidBinding
		}
		// Claude Code 原生 Unix Socket 模式只需要一个 OAuth 占位值来启用订阅认证
		// 协议；真实 Token 仅保留在 Go 代理内存，不进入官方 CLI 子进程环境。
		values = map[string]string{
			"CLAUDE_CODE_OAUTH_TOKEN":              "aih-managed-oauth",
			"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "1",
		}
		kind = claude.AuthKindOAuth.String()
		mode = claude.OAuthModeRefreshable.String()
		runtime, err = providerlaunch.NewClaudeOAuthProxyRuntime(auth.AccessToken())
	default:
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 原生认证运行时编码失败", ErrBuildLaunchContext)
	}
	if runtime.Kind() == providerlaunch.RuntimeKindDirectProcess {
		values["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] = "1"
	}
	patch, err := providerlaunch.NewEnvironmentPatch(
		values,
		withoutSetKeys(inheritedCredentialKeys, values),
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 环境补丁无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(kind, mode)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 凭据摘要无效", ErrBuildLaunchContext)
	}
	return providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:  claude.ProviderID,
		Binary:      binaryName,
		Environment: patch,
		Runtime:     runtime,
		Credential:  descriptor,
	})
}

// withoutSetKeys 返回未被本次显式设置的继承凭据变量。
func withoutSetKeys(candidates []string, set map[string]string) []string {
	result := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if _, exists := set[candidate]; !exists {
			result = append(result, candidate)
		}
	}
	return result
}
