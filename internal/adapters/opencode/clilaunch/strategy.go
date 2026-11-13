// Package clilaunch 把 OpenCode 凭据转换为官方 CLI 的启动描述。
//
// 对齐 Node launch-profile/opencode-strategy.js（非网关、非显式 server 形态）：
// XDG_DATA_HOME 指向账号 bridge，凭据走 auth.json（v1）或 OPENCODE_API_KEY（v2）。
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
	providerID = "opencode"
	binaryName = "opencode"
)

// unsetKeys 是宿主上可能改变 OpenCode 身份的变量。
var unsetKeys = []string{
	"OPENCODE_API_KEY",
	"OPENCODE_CONFIG",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_CONFIG_CONTENT",
	"OPENCODE_SERVER_PASSWORD",
	"OPENCODE_SERVER_USERNAME",
}

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 OpenCode 账号。
	ErrInvalidBinding = errors.New("OpenCode CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是 OpenCode 支持的认证类型。
	ErrUnsupportedCredential = errors.New("OpenCode CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的启动描述。
	ErrBuildLaunchContext = errors.New("OpenCode CLI 启动描述构建失败")
)

// Strategy 是 OpenCode 的无状态启动策略。
type Strategy struct{}

var _ providerlaunch.Strategy = (*Strategy)(nil)

// NewStrategy 创建 OpenCode 启动策略。
func NewStrategy() *Strategy {
	return &Strategy{}
}

// ProviderID 返回策略唯一支持的 Provider。
func (*Strategy) ProviderID() string { return providerID }

// Build 生成 bridge 投影（OAuth）或在 bridge 上叠加 OPENCODE_API_KEY（API Key）。
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
		values["OPENCODE_API_KEY"] = credential.APIKey()
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
	unset := make([]string, 0, len(unsetKeys))
	for _, key := range unsetKeys {
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
