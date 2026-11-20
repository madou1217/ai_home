package clilaunch

import "fmt"

// 本文件是受管 Provider（aih_server）启动参数的唯一声明处。
//
// 凭据机制只能有一个权威：**生效的 Codex 配置**。Codex ≥0.149 拒绝同时出现
// auth 命令表与 env_key（「provider auth cannot be combined with env_key」），
// 因此启动参数不能固定携带 env_key，必须与配置保持一致：
//   - 宿主默认（aih codex default / 服务端投影）写入
//     [model_providers.aih_server.auth] 命令表，凭据由命令提供；
//   - 沙箱或未初始化的配置没有 auth 命令表，凭据只能来自启动环境，必须给出 env_key。
//
// 结论由组合根从 CODEX_HOME/config.toml 读出来注入；本包不做文件 I/O。

// ManagedProviderKey 是受管 Provider 的规范键（线程元数据会持久记录它，不能改名）。
const ManagedProviderKey = "aih_server"

// ManagedProviderAuth 是受管 Provider 的客户端密钥来源。
type ManagedProviderAuth int

const (
	// ManagedProviderAuthEnvKey 表示配置未声明 auth 命令，启动参数必须给出 env_key。
	ManagedProviderAuthEnvKey ManagedProviderAuth = iota
	// ManagedProviderAuthCommand 表示配置已声明 auth 命令表，凭据由该命令提供。
	ManagedProviderAuthCommand
)

// ManagedProviderAuthSource 报告生效 Codex 配置声明的凭据机制。
//
// 由组合根实现（读取有效 config.toml）；策略只消费结论，保持启动描述可复现。
type ManagedProviderAuthSource interface {
	ManagedProviderAuth() ManagedProviderAuth
}

// managedProviderAuthOf 容忍未注入的来源：没有配置证据时按 env_key 处理，
// 与「裸配置」的行为一致。
func managedProviderAuthOf(source ManagedProviderAuthSource) ManagedProviderAuth {
	if source == nil {
		return ManagedProviderAuthEnvKey
	}
	return source.ManagedProviderAuth()
}

// managedProviderArguments 生成受管 Provider 的公共 -c 覆盖。
//
// env_key 只在配置本身没有 auth 命令表时注入；配置声明了 auth 命令时由该命令
// 负责取 key，否则 Codex 会因两者并存而拒绝加载整份配置。
func managedProviderArguments(baseURL string, auth ManagedProviderAuth) []string {
	arguments := []string{
		"-c", fmt.Sprintf("model_providers.%s.name=%q", apiProviderKey, apiProviderLabel),
		"-c", fmt.Sprintf("model_providers.%s.base_url=%s", apiProviderKey, baseURL),
		"-c", fmt.Sprintf("model_providers.%s.wire_api=responses", apiProviderKey),
	}
	if auth == ManagedProviderAuthEnvKey {
		arguments = append(arguments,
			"-c", fmt.Sprintf("model_providers.%s.env_key=%s", apiProviderKey, gatewayClientKeyEnv))
	}
	return arguments
}