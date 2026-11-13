// Package clilaunch 把 Qoder（全球站 / 国内站）凭据转换为官方 CLI 的启动描述。
//
// 账号配置根由合同声明的 --config-dir 注入（providercli 在投影根就绪后追加），
// 本策略只负责投影指令与环境剥离；PAT 账号改走环境变量。
package clilaunch

import (
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// binaryNames 是两家 Qoder 的官方可执行文件。
var binaryNames = map[string]string{
	"qoder":   "qodercli",
	"qodercn": "qoderclicn",
}

var (
	// ErrInvalidBinding 表示凭据未绑定到有效 Qoder 账号。
	ErrInvalidBinding = errors.New("Qoder CLI 启动凭据绑定无效")
	// ErrUnsupportedCredential 表示凭据不是 Qoder 支持的认证类型。
	ErrUnsupportedCredential = errors.New("Qoder CLI 启动凭据类型不受支持")
	// ErrBuildLaunchContext 表示凭据无法编码成安全的启动描述。
	ErrBuildLaunchContext = errors.New("Qoder CLI 启动描述构建失败")
)

// inheritedCredentialKeys 是宿主上可能改变 Qoder 身份的变量。
var inheritedCredentialKeys = []string{
	"QODER_PERSONAL_ACCESS_TOKEN",
	"QODER_CONFIG_DIR",
}

// Strategy 是单个 Qoder Provider 的无状态启动策略。
type Strategy struct {
	providerID string
	binaryName string
}

var _ providerlaunch.Strategy = (*Strategy)(nil)

// NewStrategy 创建指定 Qoder Provider 的启动策略。
func NewStrategy(providerID string) (*Strategy, error) {
	id := strings.ToLower(strings.TrimSpace(providerID))
	binary, ok := binaryNames[id]
	if !ok {
		return nil, ErrInvalidBinding
	}
	return &Strategy{providerID: id, binaryName: binary}, nil
}

// ProviderID 返回策略唯一支持的 Provider。
func (strategy *Strategy) ProviderID() string {
	if strategy == nil {
		return ""
	}
	return strategy.providerID
}

// Build 根据凭据形态选择投影或 PAT 注入。
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
		if credential == nil ||
			credential.ProviderID() != strategy.providerID ||
			!strings.EqualFold(credential.AuthKind(), "oauth") {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		return strategy.buildOAuth()
	case *accountcore.StaticAPIKeyAuth:
		if credential == nil || credential.ProviderID() != strategy.providerID {
			return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
		}
		return strategy.buildPAT(credential)
	default:
		return providerlaunch.StrategyResult{}, ErrUnsupportedCredential
	}
}

// buildOAuth 让官方 CLI 读取 --config-dir 指向的账号配置根（.auth/user）。
func (strategy *Strategy) buildOAuth() (providerlaunch.StrategyResult, error) {
	projection, err := providerlaunch.NewProjectionDirective(
		strategy.providerID,
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
		ProviderID:  strategy.providerID,
		Binary:      strategy.binaryName,
		Environment: environment,
		Runtime:     providerlaunch.NewDirectProcessRuntime(),
		Projection:  projection,
		Credential:  descriptor,
	})
}

// buildPAT 注入本账号的 Personal Access Token；共享配置（无投影）与 Node 一致。
func (strategy *Strategy) buildPAT(
	credential *accountcore.StaticAPIKeyAuth,
) (providerlaunch.StrategyResult, error) {
	values := map[string]string{"QODER_PERSONAL_ACCESS_TOKEN": credential.APIKey()}
	unset := make([]string, 0, len(inheritedCredentialKeys))
	for _, key := range inheritedCredentialKeys {
		if _, set := values[key]; !set {
			unset = append(unset, key)
		}
	}
	environment, err := providerlaunch.NewEnvironmentPatch(values, unset)
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: PAT 环境无效", ErrBuildLaunchContext)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor(accountcore.StaticAPIKeyAuthKind, "")
	if err != nil {
		return providerlaunch.StrategyResult{}, fmt.Errorf("%w: PAT 摘要无效", ErrBuildLaunchContext)
	}
	return providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:  strategy.providerID,
		Binary:      strategy.binaryName,
		Environment: environment,
		Runtime:     providerlaunch.NewDirectProcessRuntime(),
		Credential:  descriptor,
	})
}
