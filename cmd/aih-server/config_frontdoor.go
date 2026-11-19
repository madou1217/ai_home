package main

import (
	"net/url"
	"strconv"
)

// frontDoorBaseURL 只在公开端口模式下返回 Node 私有地址；其余情况为空，
// 让 Go 保持「私有端口 + 未注册路径 404」的既有合同。
//
// 开关与目标分开表达：「拥有公开端口」是拓扑事实，Node 地址可能暂时缺席
// （宿主未启动或由监督器稍后分配）。此时仍然没有回退目标，未注册路径按 404
// 失败关闭，而不是把空地址当成合法上游。
func (config commandConfig) frontDoorBaseURL() string {
	if !config.frontDoor {
		return ""
	}
	return config.nodeBaseURL
}

// loopbackURLPort 返回回环基址里显式写明的端口。
//
// 前置门目标必须是「协议 + 主机 + 端口」的完整基址：缺端口会落到 80/443，而宿主内部
// 没有这两个端口上的 Node，故障会推迟到首个请求才以 502 暴露。
func loopbackURLPort(baseURL string) (int, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return 0, errInvalidCommandConfig
	}
	raw := parsed.Port()
	if raw == "" {
		return 0, errInvalidCommandConfig
	}
	port, convErr := strconv.Atoi(raw)
	if convErr != nil || port < 1 || port > 65535 {
		return 0, errInvalidCommandConfig
	}
	return port, nil
}
