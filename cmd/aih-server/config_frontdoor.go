package main

import (
	"net/url"
	"strconv"
)

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
