package aihserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/transport/http/webuipluginapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiproviderauthsourcesapi"
)

// buildWebUIPluginRoutes 按统一 webuiRouteDependencies 签名装配插件诊断、调试调用、
// 插件报价与账号插件管理的 WebUI/CLI 管理路由；宿主服务未注入时以 fail-closed 模式注册端点。
func buildWebUIPluginRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUIPluginRoutesWithHostService(dependencies, nil)
}

// buildWebUIPluginRoutesWithHostService 允许组合根或测试显式传入运行中的 pluginhost.Service。
func buildWebUIPluginRoutesWithHostService(
	dependencies webuiRouteDependencies,
	hostService *pluginhost.Service,
) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}

	handler, err := webuipluginapi.NewHandler(webuipluginapi.Dependencies{
		Authorizer:       dependencies.Authorizer,
		HostService:      hostService,
		PricingService:   dependencies.PricingService,
		AccountRegistrar: newPluginAccountRegistrar(dependencies),
	})
	if err != nil {
		return nil, fmt.Errorf("创建插件管理接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "GET " + webuipluginapi.DoctorPath, Handler: handler},
		{Pattern: "POST " + webuipluginapi.InvokePath, Handler: handler},
		{Pattern: "POST " + webuipluginapi.PricingRefreshPath, Handler: handler},
		{Pattern: "POST " + webuipluginapi.PricingQuotePath, Handler: handler},
		{Pattern: "GET " + webuipluginapi.AccountsSourcesPath, Handler: handler},
		{Pattern: "POST " + webuipluginapi.AccountsImportPath, Handler: handler},
		{Pattern: "POST " + webuipluginapi.AccountsRefreshPath, Handler: handler},
		{Pattern: "POST " + webuipluginapi.AccountsMaterializePath, Handler: handler},
	}, nil
}

// collectProviderPluginAuthSources 查询 Go pluginhost.Service 中的 account.source 贡献并转换为
// webuiproviderauthsourcesapi.PluginSource，供 Provider 授权来源接口直接合并原生与插件来源。
func collectProviderPluginAuthSources(
	ctx context.Context,
	hostService *pluginhost.Service,
	provider string,
) ([]webuiproviderauthsourcesapi.PluginSource, error) {
	if hostService == nil {
		return []webuiproviderauthsourcesapi.PluginSource{}, nil
	}
	listed, err := hostService.ListAccountSources(ctx, provider, pluginhost.AccountListOptions{})
	if err != nil {
		if pe, ok := pluginerr.From(err); ok && pe.Code == "plugin_runtime_inactive" {
			return []webuiproviderauthsourcesapi.PluginSource{}, nil
		}
		return nil, err
	}
	sources := make([]webuiproviderauthsourcesapi.PluginSource, 0, len(listed.Sources))
	for _, src := range listed.Sources {
		available := src.Available
		sources = append(sources, webuiproviderauthsourcesapi.PluginSource{
			ID:              src.ID,
			Kind:            src.Kind,
			ClientDependent: src.ClientDependent,
			RequiresApp:     src.RequiresApp,
			AuthMode:        src.AuthMode,
			DirectImport:    src.DirectImport,
			PluginLogin:     src.LoginAvailable,
			Description:     src.Description,
			Available:       &available,
			Identity:        extractPluginAuthSourceIdentity(src.Identity),
		})
	}
	return sources, nil
}

func extractPluginAuthSourceIdentity(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err == nil {
		return strings.TrimSpace(text)
	}
	var compacted bytes.Buffer
	if err := json.Compact(&compacted, trimmed); err == nil {
		return compacted.String()
	}
	return string(trimmed)
}
