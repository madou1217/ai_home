package aihcli

import (
	"context"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/managementproxy"
	"github.com/madou1217/ai_home/internal/runtime/updateproxy"
)

// localEgressProvider 装配「缺失 CLI 自动安装」用的受管代理轮换。
//
// 与 aih <provider> install 的差异只在凭据来源：Provider 启动命令不保证导出
// 管理密钥，因此这里允许从本地 config:server 兜底（仅回环地址生效，远端地址
// 不继承本机密钥）。出口顺序、轮换与失败判定仍然只有 updateproxy 一份实现。
//
// 返回 nil 表示没有可用管理面：安装保持直连语义，不新增硬依赖。
func localEgressProvider(ctx context.Context, aiHomeDir string) egressProvider {
	return func(notify func(string)) *updateproxy.EgressRotation {
		baseURL, managementKey := resolveEgressCredentials(ctx, aiHomeDir)
		client, err := managementproxy.New(managementproxy.Config{
			BaseURL:       baseURL,
			ManagementKey: managementKey,
		})
		if err != nil {
			return nil
		}
		return client.Rotation(notify)
	}
}

// resolveEgressCredentials 优先使用显式环境变量，其次回落到本地网关配置。
func resolveEgressCredentials(ctx context.Context, aiHomeDir string) (string, string) {
	baseURL := strings.TrimSpace(os.Getenv("AIH_SERVER_BASE_URL"))
	managementKey := strings.TrimSpace(os.Getenv("AIH_SERVER_MANAGEMENT_KEY"))
	if baseURL != "" && managementKey != "" {
		return baseURL, managementKey
	}
	defaults, ok, err := ReadLocalGatewayDefaults(ctx, aiHomeDir, baseURL)
	if err != nil || !ok {
		return baseURL, managementKey
	}
	if baseURL == "" {
		baseURL = defaults.BaseURL
	}
	if managementKey == "" {
		managementKey = defaults.ManagementKey
	}
	return baseURL, managementKey
}
