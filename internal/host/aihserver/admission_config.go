// Package aihserver 的准入配置桥：server 配置里的 concurrency 对象 ↔ 进程级
// admission.Controller。放在独立小文件里，避免把组合根继续膨胀。
package aihserver

import (
	"context"
	"time"

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

// refreshAdmissionConfigLoop 周期对齐 server 配置里的 concurrency 对象。
//
// WebUI 保存会走 OnSaved 立即生效；但 `aih limits` 等写路径直接改 config:server，
// 不经过 HTTP 钩子。周期读取让运行中的控制器在数秒内收敛（与账号覆盖刷新同频），
// 避免「CLI 已保存但排队超时仍是旧值」的静默漂移。
func refreshAdmissionConfigLoop(
	ctx context.Context,
	controller *admission.Controller,
	aiHomeDir string,
	interval time.Duration,
) {
	if controller == nil {
		return
	}
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			config, ok := readAdmissionConcurrency(ctx, aiHomeDir)
			if !ok {
				continue
			}
			if controller.Config().Equal(config) {
				continue
			}
			controller.Configure(config)
		}
	}
}

// readAdmissionConcurrency 读取 config:server 的 concurrency 对象；未配置时返回 false。
func readAdmissionConcurrency(ctx context.Context, aiHomeDir string) (concurrency.Config, bool) {
	view, err := webuiserverconfigapi.ReadFullConfig(ctx, aiHomeDir)
	if err != nil || view.Concurrency == nil {
		return concurrency.Config{}, false
	}
	parsed, err := concurrency.ParseConfig(view.Concurrency)
	if err != nil {
		return concurrency.Config{}, false
	}
	return parsed, true
}
