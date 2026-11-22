package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	goruntime "runtime"

	"github.com/madou1217/ai_home/internal/runtime/systemproxy"
)

// applySystemProxy 把本机 lease 入口写入系统 HTTP/HTTPS 代理。
// 只接受显式服务名（macOS 有多个网络服务），退出时用快照恢复。
func applySystemProxy(ctx context.Context, cmdRuntime commandRuntime, address, service string, dryRun bool) (func(), error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("代理入口地址无效")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 || port > 65535 {
		return nil, errors.New("代理入口端口无效")
	}
	service = strings.TrimSpace(service)
	if service == "" && goruntime.GOOS == "darwin" {
		services, listErr := systemproxy.ListServices(ctx)
		if listErr != nil {
			return nil, listErr
		}
		names := make([]string, 0, len(services))
		for _, item := range services {
			names = append(names, item.Name)
		}
		return nil, fmt.Errorf("--system 需要显式 --system-service；可选：%s", strings.Join(names, "、"))
	}
	// 系统代理入口是 loopback 匿名的；上游租约认证由 ingress 注入，
	// 不把租约令牌写进系统配置。
	endpoint := systemproxy.Endpoint{Host: host, Port: port}
	if dryRun {
		result, applyErr := systemproxy.Apply(ctx, systemproxy.ApplyOptions{
			Service: service, HTTP: endpoint, HTTPS: endpoint, DryRun: true,
		})
		if applyErr != nil {
			return nil, applyErr
		}
		writeSystemProxyActions(cmdRuntime, result)
		return nil, nil
	}
	snapshot, err := systemproxy.Capture(ctx)
	if err != nil {
		return nil, err
	}
	result, err := systemproxy.Apply(ctx, systemproxy.ApplyOptions{
		Service: service, HTTP: endpoint, HTTPS: endpoint,
	})
	if err != nil {
		restoreCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if _, restoreErr := systemproxy.Restore(restoreCtx, snapshot, systemproxy.RestoreOptions{Service: service}); restoreErr != nil {
			cancel()
			return nil, fmt.Errorf("系统代理应用失败且恢复失败: %w；%v", err, restoreErr)
		}
		cancel()
		return nil, err
	}
	writeSystemProxyResult(cmdRuntime, "已应用系统代理", result)
	return func() {
		restoreCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		restored, restoreErr := systemproxy.Restore(restoreCtx, snapshot, systemproxy.RestoreOptions{Service: service})
		if restoreErr != nil {
			_, _ = fmt.Fprintf(cmdRuntime.stderr, "[aih] 系统代理恢复失败：%v\n", restoreErr)
			return
		}
		writeSystemProxyResult(cmdRuntime, "已恢复系统代理", restored)
	}, nil
}

func writeSystemProxyResult(runtime commandRuntime, prefix string, result systemproxy.Result) {
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] %s：服务=%s changed=%v actions=%d\n", prefix, result.Scope, result.Changed, len(result.Actions))
	if result.DryRun {
		writeSystemProxyActions(runtime, result)
	}
}

func writeSystemProxyActions(runtime commandRuntime, result systemproxy.Result) {
	for _, action := range result.Actions {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih]   %s %s %s\n", action.Kind, action.Command, strings.Join(action.Args, " "))
	}
}
