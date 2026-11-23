// Package aihserver 的准入配置桥：server 配置里的 concurrency 对象 ↔ 进程级
// admission.Controller。放在独立小文件里，避免把组合根继续膨胀。
package aihserver

import (
	"context"

	"github.com/madou1217/ai_home/application/admission"
	"github.com/madou1217/ai_home/core/concurrency"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

// startupConcurrencyConfig 读取启动时的并发配置。
//
// server 配置存在 concurrency 对象时以它为准；否则沿用 core 默认值，并叠加旧
// AIH_SERVER_*_MAX_CONCURRENCY / AIH_SERVER_QUEUE_LIMIT 环境变量提供的兜底。
func startupConcurrencyConfig(ctx context.Context, aiHomeDir string) concurrency.Config {
	if view, err := webuiserverconfigapi.ReadFullConfig(ctx, aiHomeDir); err == nil && view.Concurrency != nil {
		if parsed, parseErr := concurrency.ParseConfig(view.Concurrency); parseErr == nil {
			return parsed
		}
	}
	config := concurrency.Default()
	providerLimits, queueLimit := admission.LegacyDefaults()
	if len(providerLimits) > 0 {
		merged := make(map[string]int, len(config.ProviderDefaults)+len(providerLimits))
		for provider, limit := range config.ProviderDefaults {
			merged[provider] = limit
		}
		for provider, limit := range providerLimits {
			merged[provider] = limit
		}
		config.ProviderDefaults = merged
	}
	if queueLimit > 0 {
		config.QueueLimit = queueLimit
	}
	return config
}

// applyAdmissionConcurrency 把 WebUI 保存后的 concurrency 对象原子应用到控制器。
func applyAdmissionConcurrency(raw any) {
	controller := admission.Current()
	if controller == nil {
		return
	}
	parsed, err := concurrency.ParseConfig(raw)
	if err != nil {
		return
	}
	controller.Configure(parsed)
}
