// Package inferencegateway 定义 Canonical 推理请求的应用层执行端口。
package inferencegateway

import (
	"context"

	"github.com/madou1217/ai_home/core/inference"
)

// EventSink 按严格顺序接收一个 Canonical 响应事件。
//
// 执行器必须在 EventSink 返回错误时立即停止，避免继续读取上游并扩大背压。
type EventSink func(inference.StreamEvent) error

// Executor 执行一次 Canonical 请求，不感知客户端 HTTP 或 SSE 协议。
//
// 账号征召、凭据解析、上游 Adapter 和失败观察都应在该端口的实现中组合。
type Executor interface {
	Execute(
		ctx context.Context,
		request inference.Request,
		emit EventSink,
	) error
}
