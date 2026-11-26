package inferencegateway

// 请求级失败的进程汇点：Canonical 编排在「没有交给任何上游尝试」或「最终放弃」
// 时返回错误，这些错误不会产生账号级失败证据；用户报错时只能看到 HTTP 状态。
// 这里把 surface、模型、Request ID 与低敏错误摘要交给组合根写按天日志。

import (
	"context"
	"sync"
)

// RequestFailure 描述一次在网关层终止的请求失败。
type RequestFailure struct {
	// Surface 是客户端协议入口，例如 canonical:anthropic.messages。
	Surface string
	// Model 是请求声明的模型（可能是别名）。
	Model string
	// Error 是网关错误摘要；调用方保证不含提示词、响应正文或凭据。
	Error string
}

// RequestFailureSink 接收请求级失败。
type RequestFailureSink interface {
	RecordRequestFailure(ctx context.Context, failure RequestFailure)
}

var (
	requestFailureMu   sync.RWMutex
	requestFailureSink RequestFailureSink
)

// ConfigureRequestFailureSink 替换请求级失败汇点；nil 表示关闭记录。
func ConfigureRequestFailureSink(sink RequestFailureSink) {
	requestFailureMu.Lock()
	requestFailureSink = sink
	requestFailureMu.Unlock()
}

func emitRequestFailure(ctx context.Context, failure RequestFailure) {
	requestFailureMu.RLock()
	sink := requestFailureSink
	requestFailureMu.RUnlock()
	if sink == nil {
		return
	}
	sink.RecordRequestFailure(ctx, failure)
}
