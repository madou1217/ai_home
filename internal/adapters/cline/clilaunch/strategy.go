// Package clilaunch 把 Cline 领域凭据转换为官方 CLI 的启动描述。
//
// 对齐 Node launch-profile/cline-strategy.js：OAuth 账号把 CLINE_DIR/CLINE_DATA_DIR
// 指向账号投影并物化 providers.json；API Key 账号只注入 CLINE_API_KEY。
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
	providerID = "cline"
	binaryName = "cline"
)

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 Cline 账号。
	ErrInvalidBinding = errors.New("Cline CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是 Cline 支持的认证类型。
	ErrUnsupportedCredential = errors.New("Cline CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的启动描述。
	ErrBuildLaunchContext = errors.New("Cline CLI 启动描述构建失败")
)

// inheritedCredentialKeys 是宿主上可能改变 Cline 身份/接入点的变量。
var inheritedCredentialKeys = []string{
	"CLINE_DIR",
	"CLINE_DATA_DIR",
	"CLINE_API_KEY",
	"CLINE_API_BASE_URL",
}

// Strategy 是 Cline 的无状态启动策略。
type Strategy struct{}

var _ providerlaunch.Strategy = (*Strategy)(nil)

// NewStrategy 创建 Cline 启动策略。
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

// buildOAuth 让官方 CLI 读取账号投影里的 providers.json（CLINE_DIR 由策略注入）。
func buildOAuth() (providerlaunch.StrategyResult, error) {
	projection, err := providerlaunch.NewProjectionDirective(
		providerID,
		providerlaunch.ProjectionModeConfigDir,
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 投影指令无效", ErrBuildLaunchContext)
	}
	environment, err := providerlaunch.NewEnvironmentPatch(nil, inheritedCredentialKeys)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 环境补丁无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor("oauth", "refreshable")
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

// buildAPIKey 注入本账号密钥与接入点；共享配置（无投影）与 Node 一致。
func buildAPIKey(
	credential *accountcore.StaticAPIKeyAuth,
) (providerlaunch.StrategyResult, error) {
	values := map[string]string{"CLINE_API_KEY": credential.APIKey()}
	if baseURL := strings.TrimSpace(credential.BaseURL()); baseURL != "" {
		values["CLINE_API_BASE_URL"] = baseURL
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
