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
func applySystemProxy(ctx context.Context, cmdRuntime commandRuntime, address, service string, dryRun, force bool) (func(), error) {
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
			Service: service, HTTP: endpoint, HTTPS: endpoint, Bypass: loopbackBypassDomains(), DryRun: true,
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
	if !force && systemProxyAlreadyEnabled(snapshot, service) {
		_, _ = fmt.Fprintf(cmdRuntime.stderr, "[aih] 系统代理已由其他程序启用；跳过 --system 写入。确认要接管请加 --system-force。\n")
		return nil, nil
	}
	result, err := systemproxy.Apply(ctx, systemproxy.ApplyOptions{
		Service: service, HTTP: endpoint, HTTPS: endpoint, Bypass: loopbackBypassDomains(),
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
	if applied, detail := systemProxyMatches(ctx, service, host, port); !applied {
		_, _ = fmt.Fprintf(cmdRuntime.stderr, "[aih] 警告：系统代理应用后已被其他程序改写（%s）；AIH 不会与其抢占，退出时也不会覆盖当前设置。\n", detail)
	}
	return func() {
		if applied, detail := systemProxyMatches(context.Background(), service, host, port); !applied {
			_, _ = fmt.Fprintf(cmdRuntime.stderr, "[aih] 系统代理已由其他程序接管（%s），跳过恢复。\n", detail)
			return
		}
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

// systemProxyMatches 确认系统当前仍指向本次应用的 loopback 入口。
// 其他代理管理器（例如 Clash Verge）可能在我们写入后立即改写系统代理；
// 这时 AIH 只报告冲突，不反复争抢。
// loopbackBypassDomains 让系统代理始终绕过本机回环：否则 Codex/CodeBuddy 这类
// 会遵守系统代理的客户端会把发往 127.0.0.1:9527 的网关请求也交给远端出口，
// 远端只能连到它自己的 loopback，网关侧表现为 upstream proxy unavailable。
func loopbackBypassDomains() []string {
	return []string{"127.0.0.1", "localhost", "::1"}
}

func systemProxyMatches(ctx context.Context, service, host string, port int) (bool, string) {
	snapshot, err := systemproxy.Capture(ctx)
	if err != nil {
		return false, err.Error()
	}
	target := strings.TrimSpace(service)
	if target == "" {
		for _, item := range snapshot.Services {
			if item.HTTP.Enabled {
				target = item.Service
				break
			}
		}
		if target == "" && len(snapshot.Services) == 1 {
			target = snapshot.Services[0].Service
		}
	}
	state, found := snapshot.Service(target)
	if !found {
		return false, "找不到目标网络服务"
	}
	if !state.HTTP.Enabled || state.HTTP.Host != host || state.HTTP.Port != port {
		return false, fmt.Sprintf("当前 HTTP 代理为 %s:%d enabled=%v", state.HTTP.Host, state.HTTP.Port, state.HTTP.Enabled)
	}
	if !state.HTTPS.Enabled || state.HTTPS.Host != host || state.HTTPS.Port != port {
		return false, fmt.Sprintf("当前 HTTPS 代理为 %s:%d enabled=%v", state.HTTPS.Host, state.HTTPS.Port, state.HTTPS.Enabled)
	}
	return true, ""
}

func systemProxyAlreadyEnabled(snapshot systemproxy.Snapshot, service string) bool {
	service = strings.TrimSpace(service)
	for _, item := range snapshot.Services {
		if service != "" && item.Service != service {
			continue
		}
		if item.HTTP.Enabled || item.HTTPS.Enabled {
			return true
		}
	}
	return false
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
