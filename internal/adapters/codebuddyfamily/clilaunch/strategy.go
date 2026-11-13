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
	switch credential := binding.Credential().(type) {
	case *accountcore.NativeCredential:
		if credential == nil || credential.ProviderID() != strategy.providerID {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		if strings.ToLower(strings.TrimSpace(credential.AuthKind())) != "oauth" {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		return strategy.buildOAuth()
	case *accountcore.StaticAPIKeyAuth:
		if credential == nil || credential.ProviderID() != strategy.providerID {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		return strategy.buildAPIKey(credential)
	default:
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
}

// buildOAuth 让官方 CLI 读取伪 HOME 里共享的 .info；退出后由投影层回写续期结果。
func (strategy *Strategy) buildOAuth() (providerlaunch.StrategyResult, error) {
	result, err := strategy.baseResult()
	if err != nil {
		return providerlaunch.StrategyResult{}, err
	}
	return result, nil
}

// buildAPIKey 把账号密钥重新注入子进程环境：宿主上的 CODEBUDDY_API_KEY 属于别的
// 账号，必须先剥掉再 set。伪 HOME 仍然需要——否则 CLI 会读到宿主 .info 的 OAuth
// 身份，把 api-key 账号静默换成另一个人。
func (strategy *Strategy) buildAPIKey(
	credential *accountcore.StaticAPIKeyAuth,
) (providerlaunch.StrategyResult, error) {
	set := map[string]string{
		"CODEBUDDY_API_KEY": credential.APIKey(),
	}
	if baseURL := strings.TrimSpace(credential.BaseURL()); baseURL != "" {
		set["CODEBUDDY_BASE_URL"] = baseURL
	}
	if strategy.siteInternal {
		set["CODEBUDDY_INTERNET_ENVIRONMENT"] = "internal"
		set["CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT"] = "internal"
	}
	// 只删没有重新注入的凭据变量；AUTH_TOKEN 与 API Key 是互斥身份。
	unset := []string{"CODEBUDDY_AUTH_TOKEN"}
	if _, ok := set["CODEBUDDY_BASE_URL"]; !ok {
		unset = append(unset, "CODEBUDDY_BASE_URL")
	}
	environment, err := providerlaunch.NewEnvironmentPatch(set, unset)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 环境无效", ErrBuildLaunchContext)
	}
	projection, err := providerlaunch.NewProjectionDirective(
		strategy.providerID,
		providerlaunch.ProjectionModeFakeHome,
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 投影指令无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(
		accountcore.StaticAPIKeyAuthKind,
		"",
	)
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

// baseResult 是 OAuth 账号的启动描述：伪 HOME 投影 + 剥离宿主凭据变量。
func (strategy *Strategy) baseResult() (providerlaunch.StrategyResult, error) {
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
