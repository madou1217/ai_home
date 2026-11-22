// Package relayegress 声明透传通道共享的账号出口端口。
//
// Claude Native Relay 与 relaycore 使用同一套「按账号取上游客户端」语义；
// 端口放在这里，避免两个包各定义一份近似接口，也让宿主的实现只写一次。
package relayegress

import (
	"context"
	"net/http"
)

// HTTPClient 是透传通道发起单个上游请求所需的最小端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// AccountEgress 按本次尝试的账号解析出站客户端。
//
// bound=false 表示账号没有出口绑定，调用方继续使用默认 Client；
// bound=true 时必须使用返回的客户端，不能回落到默认网络。
// 解析失败同样以 bound=true 返回，由调用方失败关闭。
type AccountEgress interface {
	ClientForAccount(ctx context.Context, provider, accountRef string) (HTTPClient, bool, error)
}
