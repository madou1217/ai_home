package clilaunch

import (
	"fmt"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	// Gateway profile 与 API-key strategy / Node 正式链共用同一个受管
	// provider 身份。不能再产生 aih_gateway：Codex thread 元数据会持久记录
	// provider 名，而宿主注册表只保证 aih_server 常驻。
	gatewayClientKeyEnv           = "OPENAI_API_KEY"
	legacyGatewayClientKeyEnv     = "AIH_GATEWAY_CLIENT_KEY"
	legacyGatewayPinnedAccountEnv = "AIH_GATEWAY_ACCOUNT_REF"
	gatewayPinnedAccountHead      = "X-Account-Ref"
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
	// OPENAI_API_KEY 在 Gateway 模式下承载的是 AIH Server client key，
	// 必须先从“继承凭据清理”集合中排除再显式设置；其余上游凭据继续删除。
	unset := make([]string, 0, len(inheritedCredentialKeys)+2)
	for _, name := range inheritedCredentialKeys {
		if name != gatewayClientKeyEnv {
			unset = append(unset, name)
		}
	}
	// 清理早期 Go Preview 的私有变量，避免旧 shell 环境继续暗示第二套契约。
	unset = append(unset, legacyGatewayClientKeyEnv, legacyGatewayPinnedAccountEnv)

	arguments := []string{
		"-c", fmt.Sprintf("model_provider=%s", apiProviderKey),
		"-c", fmt.Sprintf("model_providers.%s.name=%q", apiProviderKey, apiProviderLabel),
		"-c", fmt.Sprintf("model_providers.%s.base_url=%s", apiProviderKey, endpoint.BaseURL()+"/v1"),
		"-c", fmt.Sprintf("model_providers.%s.wire_api=responses", apiProviderKey),
		"-c", fmt.Sprintf("model_providers.%s.env_key=%s", apiProviderKey, gatewayClientKeyEnv),
		"-c", fmt.Sprintf("model_providers.%s.request_max_retries=0", apiProviderKey),
		"-c", fmt.Sprintf("model_providers.%s.stream_max_retries=0", apiProviderKey),
	}
	if accountRef, pinned := target.PinnedAccount(); pinned {
		// AccountRef 是公开稳定哈希，不是凭据。与 Node buildCodexProviderArgs
		// 一致直接进入受管 header，避免 env_http_headers 再造一套变量语义。
		arguments = append(
			arguments,
			"-c",
			fmt.Sprintf(
				"model_providers.%s.http_headers.%s=%s",
				apiProviderKey,
				gatewayPinnedAccountHead,
				accountRef.String(),
			),
		)
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
