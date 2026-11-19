package aihserver

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/frontdoorapi"
)

// newFrontDoorHandler 在公开端口模式下把 Go 未注册的路径交还给 Node 宿主。
//
// 目标为空表示当前进程不拥有公开端口（Go Core 跑在私有端口、由 Node 转发），
// 此时返回 nil，路由表保持「未命中即 404」，与迁移前完全一致。
//
// 返回类型是 http.Handler 而不是 *frontdoorapi.Handler：返回具体指针的 nil 装进
// 接口会得到「非空接口 + 空指针」，路由表的 nil 判定失效，请求一律 panic。
func newFrontDoorHandler(target string) (http.Handler, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return nil, nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("解析前置门地址失败: %w", err)
	}
	// 前置门是宿主内部拓扑：只有 loopback 目标才允许，避免把管理面暴露到网络中。
	if !isLoopbackFrontDoorHost(parsed.Hostname()) {
		return nil, fmt.Errorf("前置门目标必须是 loopback 地址: %s", trimmed)
	}
	handler, err := frontdoorapi.New(trimmed)
	if err != nil {
		return nil, err
	}
	return handler, nil
}

// isLoopbackFrontDoorHost 判定回环主机名，与 Node 监督器的 loopback 判定同源。
func isLoopbackFrontDoorHost(host string) bool {
	trimmed := strings.TrimSpace(host)
	if trimmed == "localhost" {
		return true
	}
	ip := net.ParseIP(trimmed)
	return ip != nil && ip.IsLoopback()
}
