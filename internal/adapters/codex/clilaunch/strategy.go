// Package clilaunch 把 Codex 领域凭据转换为原生 Codex CLI 启动描述。
package clilaunch

import (
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	binaryName       = "codex"
	apiProviderKey   = "aih_account"
	apiProviderLabel = "AIH Account"
)

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 Codex 账号。
	ErrInvalidBinding = errors.New("Codex CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是当前领域允许的 Codex OAuth 或 API Key。
	ErrUnsupportedCredential = errors.New("Codex CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的 Codex 启动描述。
	ErrBuildLaunchContext = errors.New("Codex CLI 启动描述构建失败")
)

// inheritedCredentialKeys 是启动前必须删除的其他 Codex 认证来源。
var inheritedCredentialKeys = []string{
	"CODEX_ACCESS_TOKEN",
	"CODEX_API_KEY",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
}

// configScopedSubcommands 要求 -c 参数跟随子命令，其他入口仍把参数放在根命令前。
var configScopedSubcommands = []string{"exec", "resume", "fork", "review", "app-server"}

// 编译期确认 Codex Strategy 满足应用层窄接口。
var _ providerlaunch.Strategy = (*Strategy)(nil)

// Strategy 负责 Codex OAuth 外部认证 Runtime 和 API Key model_provider 参数。
type Strategy struct{}

// NewStrategy 创建无状态 Codex CLI 启动策略。
func NewStrategy() *Strategy {
	return &Strategy{}
}

// ProviderID 返回策略唯一支持的 Codex Provider。
func (*Strategy) ProviderID() string {
	return codex.ProviderID
}

// Build 根据封闭领域凭据选择唯一 Codex 原生认证路径。
func (*Strategy) Build(
	binding accountapp.CredentialBinding,
) (providerlaunch.StrategyResult, error) {
	if !validBinding(binding) {
		return providerlaunch.StrategyResult{}, ErrInvalidBinding
	}
	switch auth := binding.Credential().(type) {
	case *codex.OAuthAuth:
		if auth == nil {
			return providerlaunch.StrategyResult{}, ErrInvalidBinding
		}
		return buildOAuth(auth)
	case *codex.APIKeyAuth:
		if auth == nil {
			return providerlaunch.StrategyResult{}, ErrInvalidBinding
		}
		return buildAPIKey(auth)
	default:
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
}

// buildOAuth 生成不写 auth.json 的官方 app-server 外部 Token Runtime。
func buildOAuth(auth *codex.OAuthAuth) (providerlaunch.StrategyResult, error) {
	accountID := auth.UpstreamAccountID()
	if accountID == "" {
		return providerlaunch.StrategyResult{}, fmt.Errorf(
			"%w: OAuth 缺少可注入的 ChatGPT Account ID",
			ErrBuildLaunchContext,
		)
	}
	runtime, err := providerlaunch.NewCodexExternalAuthRuntime(
		auth.AccessToken(),
		accountID,
		auth.PlanType(),
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: OAuth Runtime 无效", ErrBuildLaunchContext)
	}
	environment, err := providerlaunch.NewEnvironmentPatch(nil, inheritedCredentialKeys)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: OAuth 环境无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(
		codex.AuthKindOAuth.String(),
		"refreshable",
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: OAuth 摘要无效", ErrBuildLaunchContext)
	}
	return providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:                codex.ProviderID,
		Binary:                    binaryName,
		Arguments:                 []string{"-c", `model_provider="openai"`},
		ArgumentsAfterSubcommands: configScopedSubcommands,
		Environment:               environment,
		Runtime:                   runtime,
		Credential:                descriptor,
	})
}

// buildAPIKey 通过临时 model_provider 参数绑定账号 endpoint，避免修改共享 config.toml。
func buildAPIKey(auth *codex.APIKeyAuth) (providerlaunch.StrategyResult, error) {
	environment, err := providerlaunch.NewEnvironmentPatch(
		map[string]string{"OPENAI_API_KEY": auth.APIKey()},
		withoutEnvironmentKey(inheritedCredentialKeys, "OPENAI_API_KEY"),
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: API Key 环境无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(
		codex.AuthKindAPIKey.String(),
		"",
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: API Key 摘要无效", ErrBuildLaunchContext)
	}
	arguments := []string{
		"-c", "model_provider=" + apiProviderKey,
		"-c", fmt.Sprintf("model_providers.%s.name=%q", apiProviderKey, apiProviderLabel),
		"-c", fmt.Sprintf("model_providers.%s.base_url=%s", apiProviderKey, auth.BaseURL()),
		"-c", fmt.Sprintf("model_providers.%s.wire_api=responses", apiProviderKey),
		"-c", fmt.Sprintf("model_providers.%s.env_key=OPENAI_API_KEY", apiProviderKey),
	}
	return providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:                codex.ProviderID,
		Binary:                    binaryName,
		Arguments:                 arguments,
		ArgumentsAfterSubcommands: configScopedSubcommands,
		Environment:               environment,
		Runtime:                   providerlaunch.NewDirectProcessRuntime(),
		Credential:                descriptor,
	})
}

// validBinding 复核稳定账号、Provider 和封闭凭据接口的一致性。
func validBinding(binding accountapp.CredentialBinding) bool {
	return binding.IsValid() &&
		binding.ProviderID() == codex.ProviderID &&
		binding.AccountRef().IsValid()
}

// withoutEnvironmentKey 返回删除目标变量后的新切片，避免 set/unset 冲突。
func withoutEnvironmentKey(values []string, excluded string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != excluded {
			result = append(result, value)
		}
	}
	return result
}
