package aihserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/webuimanagementapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitcoreapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitenvapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitextapi"
)

const (
	// webuiWarmupSettleDelay 对应原 Node 启动后等待服务平稳的 3 秒缓冲期。
	webuiWarmupSettleDelay = 3 * time.Second
	// webuiWarmupGap 避免首屏预热请求同时并发压满进程或 CLI 探测。
	webuiWarmupGap = 250 * time.Millisecond
	// webuiWarmupRequestTimeout 限制单条预热请求的最长耗时。
	webuiWarmupRequestTimeout = 30 * time.Second
)

// webuiWarmupPaths 按原 WARMUP_PATHS 顺序覆盖工具箱与统计首屏路由，
// 使首个真实页面请求可直接命中各切片的内存 SWR 缓存。
var webuiWarmupPaths = []string{
	webuitoolkitextapi.NativeResourcesPath,
	webuitoolkitcoreapi.AppsPath,
	webuitoolkitcoreapi.ToolsPath,
	webuitoolkitenvapi.Path,
	webuitoolkitcoreapi.MirrorsPath,
	webuitoolkitextapi.ProviderConfigsPath,
	webuitoolkitcoreapi.ToolkitTerminalsPath,
	webuimanagementapi.UsageStatsPath,
}

type webuiWarmupConfig struct {
	settleDelay    time.Duration
	gap            time.Duration
	requestTimeout time.Duration
	paths          []string
}

func defaultWebUIWarmupConfig() webuiWarmupConfig {
	return webuiWarmupConfig{
		settleDelay:    webuiWarmupSettleDelay,
		gap:            webuiWarmupGap,
		requestTimeout: webuiWarmupRequestTimeout,
		paths:          webuiWarmupPaths,
	}
}

// StartWebUIWarmup 在服务就绪后异步触发一次进程内 WebUI 缓存预热。
//
// 所有请求通过 httptest.ResponseRecorder 直接进入 Go HTTP handler，
// 不走 TCP 环回或 Node 代理，且随 ctx 取消立即中止后续等待与请求。
func StartWebUIWarmup(ctx context.Context, handler http.Handler, internalToken func() string) {
	if handler == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	_ = startWebUIWarmupWithConfig(ctx, handler, internalToken, defaultWebUIWarmupConfig())
}

func startWebUIWarmupWithConfig(
	ctx context.Context,
	handler http.Handler,
	internalToken func() string,
	cfg webuiWarmupConfig,
) <-chan struct{} {
	done := make(chan struct{})
	if handler == nil {
		close(done)
		return done
	}
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		defer close(done)
		runWebUIWarmup(ctx, handler, internalToken, cfg)
	}()
	return done
}

func runWebUIWarmup(
	ctx context.Context,
	handler http.Handler,
	internalToken func() string,
	cfg webuiWarmupConfig,
) {
	if !waitWarmupTimer(ctx, cfg.settleDelay) {
		return
	}
	token := ""
	if internalToken != nil {
		token = strings.TrimSpace(internalToken())
	}
	if token == "" {
		return
	}

	paths := cfg.paths
	if len(paths) == 0 {
		paths = webuiWarmupPaths
	}
	requestTimeout := cfg.requestTimeout
	if requestTimeout <= 0 {
		requestTimeout = webuiWarmupRequestTimeout
	}

	for index, path := range paths {
		if ctx.Err() != nil {
			return
		}
		dispatchWarmupGET(ctx, handler, path, token, requestTimeout)
		if index < len(paths)-1 && !waitWarmupTimer(ctx, cfg.gap) {
			return
		}
	}
}

func dispatchWarmupGET(
	ctx context.Context,
	handler http.Handler,
	path string,
	token string,
	timeout time.Duration,
) {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(reqCtx)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-AIH-Warmup", "1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
}

func waitWarmupTimer(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
