// Package clilaunch 把 ZCode 凭据转换为官方 CLI 的启动描述。
//
// 对齐 Node launch-profile/zcode-strategy.js：HOME 与 ZCODE_DATA_BASE_DIR 指向
// 账号沙箱，并把宿主派生的 ZCODE_CREDENTIAL_SECRET 显式传给子进程——沙箱 HOME
// 会改变 CLI 的默认派生值，不带这个变量就解不开账号凭据库。
package clilaunch

import (
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	zcodestorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/zcode"
)

const (
	providerID = "zcode"
	binaryName = "zcode"
)

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 ZCode 账号。
	ErrInvalidBinding = errors.New("ZCode CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是 ZCode 支持的认证类型。
	ErrUnsupportedCredential = errors.New("ZCode CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的启动描述。
	ErrBuildLaunchContext = errors.New("ZCode CLI 启动描述构建失败")
)

// inheritedCredentialKeys 是宿主上可能改变 ZCode 身份/接入点的变量。
var inheritedCredentialKeys = []string{
	"ZCODE_API_KEY",
	"ZCODE_BASE_URL",
	"ZCODE_DATA_BASE_DIR",
	"ZCODE_CREDENTIAL_SECRET",
}

// Strategy 是 ZCode 的无状态启动策略。
type Strategy struct{}

var _ providerlaunch.Strategy = (*Strategy)(nil)

// NewStrategy 创建 ZCode 启动策略。
func NewStrategy() *Strategy {
	return &Strategy{}
}

// ProviderID 返回策略唯一支持的 Provider。
func (*Strategy) ProviderID() string { return providerID }

// Build 生成伪 HOME 投影（OAuth）或共享配置 + API Key 注入。
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

// buildOAuth 让官方 CLI 读取账号沙箱里的凭据库，并显式携带宿主派生密钥。
func buildOAuth() (providerlaunch.StrategyResult, error) {
	projection, err := providerlaunch.NewProjectionDirective(
		providerID,
		providerlaunch.ProjectionModeFakeHome,
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 投影指令无效", ErrBuildLaunchContext)
	}
	values := map[string]string{
		"ZCODE_CREDENTIAL_SECRET": zcodestorage.ResolveHostSecret(),
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
	values := map[string]string{"ZCODE_API_KEY": credential.APIKey()}
	if baseURL := strings.TrimSpace(credential.BaseURL()); baseURL != "" {
		values["ZCODE_BASE_URL"] = baseURL
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
