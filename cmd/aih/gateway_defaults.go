package main

// Provider 启动时的本地网关兜底。
//
// 行为：环境变量缺失时，从本地 config:server 补齐 AIH_SERVER_BASE_URL /
// AIH_SERVER_API_KEY / AIH_SERVER_MANAGEMENT_KEY；显式环境变量永远优先。
// 安全边界由 aihcli.ReadLocalGatewayDefaults 保证（非回环地址不继承本机密钥）。
//
// 只是兜底：本地配置缺失或不可读时不报错，仍由 providerlaunch 的能力校验给出
// 结论，避免把「没有本地 Server」误报成启动失败。

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihcli"
)

// hostHomeFromProjection 从 <hostHome>/.ai_home/run/auth-projections/... 反推宿主 home。
func hostHomeFromProjection(aiHomeDir string) string {
	marker := string(filepath.Separator) + filepath.Join("run", "auth-projections") + string(filepath.Separator)
	index := strings.Index(aiHomeDir, marker)
	if index <= 0 {
		return ""
	}
	root := aiHomeDir[:index]
	if filepath.Base(root) != ".ai_home" {
		return ""
	}
	host := filepath.Dir(root)
	if info, err := os.Stat(filepath.Join(host, ".ai_home", "aih.db")); err == nil && !info.IsDir() {
		return host
	}
	return ""
}

// localGatewayEnvKeys 是可从本地配置兜底的环境变量。
var localGatewayEnvKeys = []string{
	"AIH_SERVER_BASE_URL",
	"AIH_SERVER_API_KEY",
	"AIH_SERVER_MANAGEMENT_KEY",
}

// withLocalGatewayDefaults 返回注入了本地网关兜底值的命令运行时。
func withLocalGatewayDefaults(
	ctx context.Context,
	command commandRuntime,
) commandRuntime {
	aiHomeDir, err := resolveAIHomeDir(command)
	if err != nil || aiHomeDir == "" {
		return command
	}
	explicitBaseURL, _ := command.lookupEnv("AIH_SERVER_BASE_URL")
	defaults, ok, err := aihcli.ReadLocalGatewayDefaults(ctx, aiHomeDir, explicitBaseURL)
	if err == nil && !ok {
		// 账号投影的 HOME 里 .ai_home/aih.db 没有 gateway 配置；回退到宿主 .ai_home。
		if hostHome := hostHomeFromProjection(aiHomeDir); hostHome != "" {
			defaults, ok, err = aihcli.ReadLocalGatewayDefaults(ctx, filepath.Join(hostHome, ".ai_home"), explicitBaseURL)
		}
	}
	if err != nil || !ok {
		return command
	}
	fallbacks := map[string]string{
		"AIH_SERVER_BASE_URL":       defaults.BaseURL,
		"AIH_SERVER_API_KEY":        defaults.ClientKey,
		"AIH_SERVER_MANAGEMENT_KEY": defaults.ManagementKey,
	}
	original := command.lookupEnv
	command.lookupEnv = func(key string) (string, bool) {
		if value, present := original(key); present {
			return value, true
		}
		if _, allowed := fallbacks[key]; !allowed {
			return "", false
		}
		value := fallbacks[key]
		return value, value != ""
	}
	return command
}
