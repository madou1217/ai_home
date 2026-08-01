package clilaunch

import (
	"fmt"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	gatewayProviderKey       = "aih_gateway"
	gatewayProviderLabel     = "AIH Gateway"
	gatewayClientKeyEnv      = "AIH_GATEWAY_CLIENT_KEY"
	gatewayPinnedAccountEnv  = "AIH_GATEWAY_ACCOUNT_REF"
	gatewayPinnedAccountHead = "X-Account-Ref"
)

// 编译期确认 Codex Gateway Strategy 满足不读取上游凭据的应用层接口。
var _ providerlaunch.GatewayStrategy = (*GatewayStrategy)(nil)

// GatewayStrategy 使用 Responses model_provider 把官方 Codex CLI 指向 AIH Server。
type GatewayStrategy struct{}

// NewGatewayStrategy 创建无状态 Codex Gateway Strategy。
func NewGatewayStrategy() *GatewayStrategy {
	return &GatewayStrategy{}
}

// ProviderID 返回 Codex Provider 标识。
func (*GatewayStrategy) ProviderID() string {
	return codex.ProviderID
}

// Build 只消费 Server Endpoint 和可选 AccountRef，不接收任何上游账号凭据。
func (*GatewayStrategy) Build(
	target providerlaunch.GatewayTarget,
) (providerlaunch.GatewayStrategyResult, error) {
	if !target.IsValid() {
		return providerlaunch.GatewayStrategyResult{}, ErrBuildLaunchContext
	}
	endpoint := target.Endpoint()
	values := map[string]string{
		gatewayClientKeyEnv: endpoint.RevealClientKey(),
	}
	unset := append([]string(nil), inheritedCredentialKeys...)
	arguments := []string{
		"-c", fmt.Sprintf("model_provider=%q", gatewayProviderKey),
		"-c", fmt.Sprintf("model_providers.%s.name=%q", gatewayProviderKey, gatewayProviderLabel),
		"-c", fmt.Sprintf("model_providers.%s.base_url=%q", gatewayProviderKey, endpoint.BaseURL()+"/v1"),
		"-c", fmt.Sprintf("model_providers.%s.wire_api=%q", gatewayProviderKey, "responses"),
		"-c", fmt.Sprintf("model_providers.%s.env_key=%q", gatewayProviderKey, gatewayClientKeyEnv),
		"-c", fmt.Sprintf("model_providers.%s.request_max_retries=0", gatewayProviderKey),
		"-c", fmt.Sprintf("model_providers.%s.stream_max_retries=0", gatewayProviderKey),
	}
	if accountRef, pinned := target.PinnedAccount(); pinned {
		values[gatewayPinnedAccountEnv] = accountRef.String()
		arguments = append(
			arguments,
			"-c",
			fmt.Sprintf(
				"model_providers.%s.env_http_headers={%q=%q}",
				gatewayProviderKey,
				gatewayPinnedAccountHead,
				gatewayPinnedAccountEnv,
			),
		)
	} else {
		unset = append(unset, gatewayPinnedAccountEnv)
	}
	environment, err := providerlaunch.NewEnvironmentPatch(values, unset)
	if err != nil {
		return providerlaunch.GatewayStrategyResult{}, fmt.Errorf(
			"%w: Gateway 环境无效",
			ErrBuildLaunchContext,
		)
	}
	return providerlaunch.NewGatewayStrategyResult(
		providerlaunch.GatewayStrategyResultInput{
			ProviderID:                codex.ProviderID,
			Binary:                    binaryName,
			Arguments:                 arguments,
			ArgumentsAfterSubcommands: configScopedSubcommands,
			Environment:               environment,
		},
	)
}
