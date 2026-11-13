// Package clilaunch 把 CodeBuddy / WorkBuddy 家族的原生凭据转换为官方 CLI 启动描述。
package clilaunch

import (
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const binaryName = "codebuddy"

var (
	// ErrInvalidBinding 表示凭据未绑定到有效家族账号。
	ErrInvalidBinding = errors.New("CodeBuddy 家族 CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是原生 OAuth。
	ErrUnsupportedCredential = errors.New("CodeBuddy 家族 CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的启动描述。
	ErrBuildLaunchContext = errors.New("CodeBuddy 家族 CLI 启动描述构建失败")
)

// inheritedCredentialKeys 是启动前必须删除的宿主账号级变量。
var inheritedCredentialKeys = []string{
	"CODEBUDDY_API_KEY",
	"CODEBUDDY_BASE_URL",
	"CODEBUDDY_AUTH_TOKEN",
}

// Strategy 负责一个家族 Provider 的伪 HOME 投影与站点环境。
type Strategy struct {
	providerID   string
	siteInternal bool
}

var _ providerlaunch.Strategy = (*Strategy)(nil)

// NewStrategy 创建指定家族 Provider 的启动策略。
func NewStrategy(providerID string, siteInternal bool) (*Strategy, error) {
	id := strings.ToLower(strings.TrimSpace(providerID))
	if id == "" {
		return nil, ErrInvalidBinding
	}
	return &Strategy{providerID: id, siteInternal: siteInternal}, nil
}

// ProviderID 返回策略唯一支持的 Provider。
func (strategy *Strategy) ProviderID() string {
	if strategy == nil {
		return ""
	}
	return strategy.providerID
}

// Build 生成伪 HOME 投影 + 官方 CLI 的启动描述。
//
// 家族四支共用同一个 codebuddy 二进制；站点由 CODEBUDDY_INTERNET_ENVIRONMENT 固定
// （国内站 internal），配置根与 .info 由投影执行器注入。
func (strategy *Strategy) Build(
	binding accountapp.CredentialBinding,
) (providerlaunch.StrategyResult, error) {
	if strategy == nil || !binding.IsValid() ||
		binding.ProviderID() != strategy.providerID ||
		!binding.AccountRef().IsValid() {
		return providerlaunch.StrategyResult{}, ErrInvalidBinding
	}
	native, ok := binding.Credential().(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != strategy.providerID {
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
	if strings.ToLower(strings.TrimSpace(native.AuthKind())) != "oauth" {
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
	projection, err := providerlaunch.NewProjectionDirective(
		strategy.providerID,
		providerlaunch.ProjectionModeFakeHome,
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 投影指令无效", ErrBuildLaunchContext)
	}
	set := map[string]string(nil)
	if strategy.siteInternal {
		set = map[string]string{
			"CODEBUDDY_INTERNET_ENVIRONMENT":         "internal",
			"CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT": "internal",
		}
	}
	environment, err := providerlaunch.NewEnvironmentPatch(set, inheritedCredentialKeys)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 环境无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor("oauth", "static")
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 凭据摘要无效", ErrBuildLaunchContext)
	}
	return providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:  strategy.providerID,
		Binary:      binaryName,
		Environment: environment,
		Runtime:     providerlaunch.NewDirectProcessRuntime(),
		Projection:  projection,
		Credential:  descriptor,
	})
}
