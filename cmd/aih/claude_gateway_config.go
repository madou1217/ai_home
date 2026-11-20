package main

import (
	"context"

	"github.com/madou1217/ai_home/internal/host/aihcli"
)

// withClaudeGatewayConfig 为 Claude 启动注入本地网关配置。
//
// 与 Provider 启动共用同一份兜底事实（aihcli.ReadLocalGatewayDefaults）：显式远端
// 地址不继承本机密钥；回环但端口不一致也不继承。这里是 Claude 侧的**显式**入口，
// 因此本地配置损坏时它仍然报错（Provider 启动路径则是尽力兜底，不阻断本地模式）。
func withClaudeGatewayConfig(ctx context.Context, command commandRuntime) (commandRuntime, error) {
	explicitBaseURL, _ := command.lookupEnv("AIH_SERVER_BASE_URL")
	home, err := resolveAIHomeDir(command)
	if err != nil {
		return command, err
	}
	defaults, ok, readErr := aihcli.ReadLocalGatewayDefaults(ctx, home, explicitBaseURL)
	if readErr != nil {
		return command, readErr
	}
	if !ok {
		return command, nil
	}
	values := map[string]string{
		"AIH_SERVER_BASE_URL":       defaults.BaseURL,
		"AIH_SERVER_API_KEY":        defaults.ClientKey,
		"AIH_SERVER_MANAGEMENT_KEY": defaults.ManagementKey,
	}
	original := command.lookupEnv
	command.lookupEnv = func(key string) (string, bool) {
		if value, present := original(key); present {
			return value, true
		}
		value, present := values[key]
		return value, present
	}
	return command, nil
}
