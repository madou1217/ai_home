// Package clilaunch 把 Gemini 领域凭据转换为官方 CLI 的启动描述。
//
// 对齐 Node launch-profile/gemini-strategy.js：
//   - OAuth 账号只隔离配置根（GEMINI_CLI_HOME=<投影>/.gemini），凭据由投影物化；
//   - API Key 账号保持共享配置，只把密钥/接入点重新注入子进程环境；
//   - 宿主上的 Gemini 账号变量一律先剥掉，避免把别的身份带进沙箱。
package clilaunch

import (
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	providerID = "gemini"
	binaryName = "gemini"
)

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 Gemini 账号。
	ErrInvalidBinding = errors.New("Gemini CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是 Gemini 支持的认证类型。
	ErrUnsupportedCredential = errors.New("Gemini CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的启动描述。
	ErrBuildLaunchContext = errors.New("Gemini CLI 启动描述构建失败")
)

// inheritedCredentialKeys 是宿主上可能改变 Gemini 身份/接入点的变量。
var inheritedCredentialKeys = []string{
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_BASE_URL",
	"GOOGLE_GEMINI_BASE_URL",
	"GOOGLE_VERTEX_BASE_URL",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GEMINI_CLI_HOME",
	"GEMINI_CLI_SYSTEM_SETTINGS_PATH",
}

// Strategy 是 Gemini 的无状态启动策略。
type Strategy struct{}

var _ providerlaunch.Strategy = (*Strategy)(nil)

// NewStrategy 创建 Gemini 启动策略。
func NewStrategy() *Strategy {
	return &Strategy{}
}

// ProviderID 返回策略唯一支持的 Provider。
func (*Strategy) ProviderID() string { return providerID }

// Build 根据凭据形态选择投影或环境注入。
func (*Strategy) Build(
	binding accountapp.CredentialBinding,
) (providerlaunch.StrategyResult, error) {
	if !binding.IsValid() ||
		binding.ProviderID() != providerID ||
		!binding.AccountRef().IsValid() {
		return providerlaunch.StrategyResult{}, ErrInvalidBinding
	}
	switch credential := binding.Credential().(type) {
	case *accountcore.NativeCredential:
		if credential == nil ||
			credential.ProviderID() != providerID ||
			!strings.EqualFold(credential.AuthKind(), "oauth") {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		return buildOAuth()
	case *accountcore.StaticAPIKeyAuth:
		if credential == nil || credential.ProviderID() != providerID {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		return buildAPIKey(credential)
	default:
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
}

// buildOAuth 让官方 CLI 读取账号投影里的 oauth_creds.json / google_accounts.json。
func buildOAuth() (providerlaunch.StrategyResult, error) {
	projection, err := providerlaunch.NewProjectionDirective(
		providerID,
		providerlaunch.ProjectionModeConfigDir,
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: OAuth 投影指令无效", ErrBuildLaunchContext)
	}
	environment, err := providerlaunch.NewEnvironmentPatch(nil, inheritedCredentialKeys)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: OAuth 环境无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor("oauth", "refreshable")
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: OAuth 摘要无效", ErrBuildLaunchContext)
	}
	return providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:  providerID,
		Binary:      binaryName,
		Environment: environment,
		Runtime:     providerlaunch.NewDirectProcessRuntime(),
		Projection:  projection,
		Credential:  descriptor,
	})
}

// buildAPIKey 重新注入本账号的密钥与接入点；共享配置根保持不变（与 Node 一致）。
func buildAPIKey(
	credential *accountcore.StaticAPIKeyAuth,
) (providerlaunch.StrategyResult, error) {
	values := map[string]string{"GEMINI_API_KEY": credential.APIKey()}
	if baseURL := strings.TrimSpace(credential.BaseURL()); baseURL != "" {
		values["GEMINI_BASE_URL"] = baseURL
		// CLI 只认 GOOGLE_GEMINI_BASE_URL，账号库存的是 GEMINI_BASE_URL。
		values["GOOGLE_GEMINI_BASE_URL"] = baseURL
	}
	unset := make([]string, 0, len(inheritedCredentialKeys))
	for _, key := range inheritedCredentialKeys {
		if _, set := values[key]; !set {
			unset = append(unset, key)
		}
	}
	environment, err := providerlaunch.NewEnvironmentPatch(values, unset)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: API Key 环境无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(accountcore.StaticAPIKeyAuthKind, "")
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: API Key 摘要无效", ErrBuildLaunchContext)
	}
	return providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:  providerID,
		Binary:      binaryName,
		Environment: environment,
		Runtime:     providerlaunch.NewDirectProcessRuntime(),
		Credential:  descriptor,
	})
}
