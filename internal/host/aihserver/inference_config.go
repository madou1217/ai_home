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

// ConfigureAgyFirstByteTimeout 设置 agy 等待响应头的上限。
//
// 默认 12s 用于快速跳过卡住不回首包的账号；思考型模型可能在更久之后才产生
// 首个事件，需要按部署调大。config:server.agyFirstByteTimeoutMs 在启动期设置。
func ConfigureAgyFirstByteTimeout(timeout time.Duration) error {
	if timeout < time.Second || timeout > 30*time.Minute {
		return errors.New("agy 首包超时必须在 1s 到 30min 之间")
	}
	agyFirstByteTimeout = timeout
	return nil
}
