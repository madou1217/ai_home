package aihserver

import (
	"errors"
	"time"
)

// ConfigureUpstreamTimeout 设置上游推理客户端超时。
//
// aih server serve 的 --upstream-timeout-ms 通过环境变量在启动期设置；
// 直接启动 aih-server 时保持 Go 的长流默认值。http.Client.Timeout 覆盖到
// 响应正文读完，因此这里设置的是单次上游尝试的绝对上限。
func ConfigureUpstreamTimeout(timeout time.Duration) error {
	if timeout < time.Second || timeout > 24*time.Hour {
		return errors.New("上游超时必须在 1s 到 24h 之间")
	}
	inferenceHTTPTimeout = timeout
	return nil
}
