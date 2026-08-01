package clilaunch

import (
	"fmt"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/accounts/claude"
)

const gatewayPinnedHeader = "X-Account-Ref"

// 编译期确认 Claude Gateway Strategy 满足不读取上游凭据的应用层接口。
var _ providerlaunch.GatewayStrategy = (*GatewayStrategy)(nil)

// GatewayStrategy 使用 Claude Code 官方环境变量连接 AIH Messages API。
type GatewayStrategy struct{}

// NewGatewayStrategy 创建无状态 Claude Gateway Strategy。
func NewGatewayStrategy() *GatewayStrategy {
	return &GatewayStrategy{}
}

// ProviderID 返回 Claude Provider 标识。
func (*GatewayStrategy) ProviderID() string {
	return claude.ProviderID
}

// Build 只注入 AIH Server 客户端密钥，并清除父进程的上游认证和云 Provider 模式。
func (*GatewayStrategy) Build(
	target providerlaunch.GatewayTarget,
) (providerlaunch.GatewayStrategyResult, error) {
	if !target.IsValid() {
		return providerlaunch.GatewayStrategyResult{}, ErrBuildLaunchContext
	}
	endpoint := target.Endpoint()
	values := map[string]string{
		"ANTHROPIC_API_KEY":                    endpoint.RevealClientKey(),
		"ANTHROPIC_BASE_URL":                   endpoint.BaseURL(),
		"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "1",
	}
	if accountRef, pinned := target.PinnedAccount(); pinned {
		values["ANTHROPIC_CUSTOM_HEADERS"] = fmt.Sprintf(
			"%s: %s",
			gatewayPinnedHeader,
			accountRef,
		)
	}
	patch, err := providerlaunch.NewEnvironmentPatch(
		values,
		withoutSetKeys(inheritedCredentialKeys, values),
	)
	if err != nil {
		return providerlaunch.GatewayStrategyResult{}, fmt.Errorf(
			"%w: Gateway 环境无效",
			ErrBuildLaunchContext,
		)
	}
	return providerlaunch.NewGatewayStrategyResult(
		providerlaunch.GatewayStrategyResultInput{
			ProviderID:  claude.ProviderID,
			Binary:      binaryName,
			Environment: patch,
		},
	)
}
