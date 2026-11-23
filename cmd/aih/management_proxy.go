package main

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/internal/adapters/managementproxy"
	"github.com/madou1217/ai_home/internal/runtime/updateproxy"
)

// managementProxyClient 用命令运行时（环境变量里的 Server 地址与管理密钥）
// 装配管理面客户端。凭据来源只有这一处：install/update、proxy serve 共用。
func managementProxyClient(runtime commandRuntime) (*managementproxy.Client, error) {
	key, found := runtime.lookupEnv("AIH_SERVER_MANAGEMENT_KEY")
	if !found || strings.TrimSpace(key) == "" {
		return nil, fmt.Errorf("%w: 命名代理需要 AIH_SERVER_MANAGEMENT_KEY", errInvalidCommand)
	}
	return managementproxy.New(managementproxy.Config{
		BaseURL:       resolveManagementBaseURL(runtime),
		ManagementKey: key,
		HTTPClient:    runtime.managementAPI,
	})
}

// explicitProxyEgress 处理用户显式指定的 --proxy 值。
//
// 含 "://" 的值按 URL 直接用（不重新解释成节点名，避免把带凭据的畸形 URL
// 当成名称）；其余值必须是管理面候选，失败就失败，不回落直连。
func explicitProxyEgress(ctx context.Context, runtime commandRuntime, value string) (updateproxy.EgressLease, error) {
	value = strings.TrimSpace(value)
	if strings.Contains(value, "://") {
		if _, err := updateproxy.Environment(nil, value); err != nil {
			return updateproxy.EgressLease{}, err
		}
		return updateproxy.EgressLease{URL: value, Name: "自定义代理"}, nil
	}
	client, err := managementProxyClient(runtime)
	if err != nil {
		return updateproxy.EgressLease{}, err
	}
	lease, err := client.Acquire(ctx, value)
	if err != nil {
		return updateproxy.EgressLease{}, err
	}
	return lease, nil
}

// managementProxyRotation 用命令运行时装配自动轮换；缺少凭据时返回 nil，
// 调用方据此保持原有直连失败语义。
func managementProxyRotation(runtime commandRuntime, notify func(string)) *updateproxy.EgressRotation {
	client, err := managementProxyClient(runtime)
	if err != nil {
		return nil
	}
	return client.Rotation(notify)
}

// displayEgressName 把出口名压成一行可打印文本（去掉控制字符与多余空白）。
func displayEgressName(name string) string {
	cleaned := strings.Join(strings.FieldsFunc(name, func(value rune) bool {
		return unicode.IsControl(value) || unicode.IsSpace(value)
	}), " ")
	if cleaned == "" {
		return "未命名出口"
	}
	return cleaned
}
