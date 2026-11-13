// Package clilaunch 把 Kimi Code 领域凭据转换为官方 CLI 的启动描述。
//
// 对齐 Node launch-profile/kimi-strategy.js：KIMI_CODE_HOME 指向账号投影的
// .kimi-code；API Key 账号额外注入 MOONSHOT_API_KEY，OAuth 账号绝不允许继承
// 宿主的 MOONSHOT_API_KEY。
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
	providerID = "kimi"
	binaryName = "kimi"
)

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 Kimi 账号。
	ErrInvalidBinding = errors.New("Kimi CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是 Kimi 支持的认证类型。
	ErrUnsupportedCredential = errors.New("Kimi CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的启动描述。
	ErrBuildLaunchContext = errors.New("Kimi CLI 启动描述构建失败")
)

// inheritedCredentialKeys 是宿主上可能改变 Kimi 身份/接入点的变量。
var inheritedCredentialKeys = []string{
	"MOONSHOT_API_KEY",
	"KIMI_API_KEY",
	"KIMI_BASE_URL",
	"KIMI_CODE_HOME",
	"KIMI_CODE_CUSTOM_HEADERS",
}

// Strategy 是 Kimi 的无状态启动策略。
type Strategy struct{}

var _ providerlaunch.Strategy = (*Strategy)(nil)

// NewStrategy 创建 Kimi 启动策略。
func NewStrategy() *Strategy {
	return &Strategy{}
}

// ProviderID 返回策略唯一支持的 Provider。
func (*Strategy) ProviderID() string { return providerID }

// Build 生成 KIMI_CODE_HOME 投影（OAuth 与 API Key 都需要配置根隔离）。
func (*Strategy) Build(
	binding accountapp.CredentialBinding,
) (providerlaunch.StrategyResult, error) {
	if !binding.IsValid() ||
		binding.ProviderID() != providerID ||
		!binding.AccountRef().IsValid() {
		return providerlaunch.StrategyResult{}, ErrInvalidBinding
	}
	values := map[string]string{}
	switch credential := binding.Credential().(type) {
	case *accountcore.NativeCredential:
		if credential == nil ||
			credential.ProviderID() != providerID ||
			!strings.EqualFold(credential.AuthKind(), "oauth") {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
	case *accountcore.StaticAPIKeyAuth:
		if credential == nil || credential.ProviderID() != providerID {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		values["MOONSHOT_API_KEY"] = credential.APIKey()
		if baseURL := strings.TrimSpace(credential.BaseURL()); baseURL != "" {
			values["KIMI_BASE_URL"] = baseURL
		}
	default:
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
	projection, err := providerlaunch.NewProjectionDirective(
		providerID,
		providerlaunch.ProjectionModeConfigDir,
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 投影指令无效", ErrBuildLaunchContext)
	}
	unset := make([]string, 0, len(inheritedCredentialKeys))
	for _, key := range inheritedCredentialKeys {
		if _, set := values[key]; !set {
			unset = append(unset, key)
		}
	}
	environment, err := providerlaunch.NewEnvironmentPatch(values, unset)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 环境补丁无效", ErrBuildLaunchContext)
	}
	kind := "oauth"
	if len(values) > 0 {
		kind = accountcore.StaticAPIKeyAuthKind
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(kind, "")
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 凭据摘要无效", ErrBuildLaunchContext)
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
