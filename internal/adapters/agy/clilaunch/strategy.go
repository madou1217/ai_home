// Package clilaunch 把 Antigravity 凭据转换为官方 CLI 的启动描述。
//
// 对齐 Node launch-profile/agy-strategy.js：HOME 就是账号沙箱，XDG/设置指针由
// 投影策略注入；这里只补 agy 特有的 Keychain 绕过变量与宿主身份剥离。
package clilaunch

import (
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

const (
	providerID = "agy"
	binaryName = "agy"
)

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 agy 账号。
	ErrInvalidBinding = errors.New("Antigravity CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是 Antigravity OAuth。
	ErrUnsupportedCredential = errors.New("Antigravity CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的启动描述。
	ErrBuildLaunchContext = errors.New("Antigravity CLI 启动描述构建失败")
)

// inheritedCredentialKeys 是宿主上可能改变 agy 身份/Keychain 行为的变量。
var inheritedCredentialKeys = []string{
	"AGY_ACCESS_TOKEN",
	"GOOGLE_OAUTH_ACCESS_TOKEN",
	"GEMINI_CLI_SYSTEM_SETTINGS_PATH",
}

// keychainBypassEnv 让 agy 走投影文件凭据而不是 macOS 全局钥匙串。
//
// agy 1.x 会先检查 SSH_CONNECTION，四个变量必须成套出现；缺一个就会回到
// 单机钥匙串，让并发账号互相串号（Node 同名字段的注释有真机取证）。
var keychainBypassEnv = map[string]string{
	"SSH_CONNECTION":  "127.0.0.1 12345 127.0.0.1 22",
	"SSH_CLIENT":      "127.0.0.1 12345 22",
	"SSH_TTY":         "/dev/tty",
	"container":       "docker",
	"WSL_DISTRO_NAME": "Ubuntu",
}

// Strategy 是 Antigravity 的无状态启动策略。
type Strategy struct{}

var _ providerlaunch.Strategy = (*Strategy)(nil)

// NewStrategy 创建 Antigravity 启动策略。
func NewStrategy() *Strategy {
	return &Strategy{}
}

// ProviderID 返回策略唯一支持的 Provider。
func (*Strategy) ProviderID() string { return providerID }

// Build 生成伪 HOME 投影 + Keychain 绕过的启动描述。
func (*Strategy) Build(
	binding accountapp.CredentialBinding,
) (providerlaunch.StrategyResult, error) {
	if !binding.IsValid() ||
		binding.ProviderID() != providerID ||
		!binding.AccountRef().IsValid() {
		return providerlaunch.StrategyResult{}, ErrInvalidBinding
	}
	switch credential := binding.Credential().(type) {
	case *agy.OAuthAuth:
		if credential == nil {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		return buildOAuth()
	case *accountcore.StaticAPIKeyAuth:
		if credential == nil || credential.ProviderID() != providerID {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		return buildAccessToken(credential)
	default:
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
}

// buildOAuth 生成伪 HOME 投影 + Keychain 绕过的启动描述。
func buildOAuth() (providerlaunch.StrategyResult, error) {
	projection, err := providerlaunch.NewProjectionDirective(
		providerID,
		providerlaunch.ProjectionModeFakeHome,
	)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 投影指令无效", ErrBuildLaunchContext)
	}
	environment, err := providerlaunch.NewEnvironmentPatch(keychainBypassEnv, inheritedCredentialKeys)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: 环境补丁无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(agy.AuthKindOAuth.String(), "refreshable")
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

// buildAccessToken 走共享配置，只把账号的 access token 注入环境（Node 的 env-token 分支）。
func buildAccessToken(
	credential *accountcore.StaticAPIKeyAuth,
) (providerlaunch.StrategyResult, error) {
	values := map[string]string{"AGY_ACCESS_TOKEN": credential.APIKey()}
	unset := make([]string, 0, len(inheritedCredentialKeys))
	for _, key := range inheritedCredentialKeys {
		if _, set := values[key]; !set {
			unset = append(unset, key)
		}
	}
	environment, err := providerlaunch.NewEnvironmentPatch(values, unset)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: access token 环境无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(accountcore.StaticAPIKeyAuthKind, "")
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: access token 摘要无效", ErrBuildLaunchContext)
	}
	return providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:  providerID,
		Binary:      binaryName,
		Environment: environment,
		Runtime:     providerlaunch.NewDirectProcessRuntime(),
		Credential:  descriptor,
	})
}
