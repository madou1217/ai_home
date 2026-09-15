// Package gemini 实现 Gemini generateContent 客户端协议边界。
//
// 本包只负责线协议 DTO 与 Canonical Contract 的双向转换，不能访问账号、Provider
// 凭据、路由状态、数据库或 HTTP Server 生命周期。
//
// 与其它客户端协议的关键差异：Gemini 的模型名在 URL 路径里（`/v1/models/{model}:generateContent`），
// 不在请求体里。因此本包提供 DecodeWithModel/BindWithModel，而不是只提供
// clientprotocol.Adapter 的无模型入口。
package gemini

import (
	"errors"
	"fmt"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

var (
	// ErrInvalidGenerateContentRequest 表示请求 JSON 或字段组合无效。
	ErrInvalidGenerateContentRequest = errors.New("Gemini generateContent 请求无效")
	// ErrUnsupportedFeature 表示合法字段尚无无损 Canonical 语义。
	ErrUnsupportedFeature = errors.New("Gemini generateContent 功能暂不支持")
	// ErrInvalidEventSequence 表示 Canonical 事件缺失、乱序或引用错误。
	ErrInvalidEventSequence = errors.New("Canonical 响应事件顺序无效")
	// ErrUnsupportedResponseEvent 表示 Gemini 无法无损表达响应事件。
	ErrUnsupportedResponseEvent = errors.New("Gemini generateContent 无法表达响应事件")
	// ErrResponseNotCompleted 表示非流式聚合器尚未收到成功终态。
	ErrResponseNotCompleted = errors.New("Gemini generateContent 响应尚未完成")
	// ErrResponseFailed 表示非流式聚合器收到失败终态。
	ErrResponseFailed = errors.New("Gemini generateContent 响应失败")
	// ErrModelRequired 表示调用方没有提供路径中的模型名。
	ErrModelRequired = errors.New("Gemini generateContent 缺少模型名")
)

// DecodeError 是不包含请求正文和敏感值的低敏 Decoder 错误。
type DecodeError struct {
	kind  error
	field string
}

// Error 返回只包含错误类别和字段路径的安全说明。
func (decodeError *DecodeError) Error() string {
	return fmt.Sprintf("%v: %s", decodeError.kind, decodeError.field)
}

// Unwrap 允许调用方使用 errors.Is 判断错误类别。
func (decodeError *DecodeError) Unwrap() error {
	return decodeError.kind
}

// invalidField 创建不会泄露字段值的请求无效错误。
func invalidField(field string) error {
	return &DecodeError{kind: ErrInvalidGenerateContentRequest, field: field}
}

// unsupportedField 创建不会泄露字段值的功能未支持错误。
func unsupportedField(field string) error {
	return &DecodeError{kind: ErrUnsupportedFeature, field: field}
}

// Adapter 把 Gemini Decoder 和两种 Renderer 注册为统一协议策略。
type Adapter struct {
	clock func() time.Time
}

// exchange 绑定一次 generateContent 请求及其无共享状态的响应策略。
type exchange struct {
	adapter Adapter
	request inference.Request
}

// NewAdapter 创建从注入时钟读取响应时间的 Gemini Adapter。
func NewAdapter(clock func() time.Time) (Adapter, error) {
	if clock == nil {
		return Adapter{}, clientprotocol.ErrInvalidAdapter
	}
	return Adapter{clock: clock}, nil
}

// ProtocolID 返回 generateContent 的 Canonical 客户端协议身份。
func (Adapter) ProtocolID() inference.ClientProtocolID {
	return inference.ClientProtocolGeminiGenerateContent
}

// Decode 永远失败：Gemini 的模型名在 URL 路径里，不在请求体中。
//
// 保留该方法是 clientprotocol.Adapter 的合同要求。调用方必须使用 DecodeWithModel，
// 否则会得到一个模型为空的 Canonical Request。
func (Adapter) Decode([]byte) (inference.Request, error) {
	return inference.Request{}, ErrModelRequired
}

// Bind 永远失败，原因同 Decode。
func (adapter Adapter) Bind([]byte) (clientprotocol.Exchange, error) {
	return nil, ErrModelRequired
}

// DecodeWithModel 把路径中的模型名与完整请求体转换为 Canonical Request。
func (Adapter) DecodeWithModel(
	model string,
	body []byte,
	stream bool,
) (inference.Request, error) {
	return NewRequestDecoder().DecodeWithModel(model, body, stream)
}

// BindWithModel 解析一次请求，并把 Canonical Request 与本协议 Renderer 绑定。
func (adapter Adapter) BindWithModel(
	model string,
	body []byte,
	stream bool,
) (clientprotocol.Exchange, error) {
	request, err := adapter.DecodeWithModel(model, body, stream)
	if err != nil {
		return nil, err
	}
	return exchange{adapter: adapter, request: request}, nil
}

// CanonicalRequest 返回供路由与 Provider Adapter 使用的协议中立请求。
func (bound exchange) CanonicalRequest() inference.Request {
	return bound.request
}

// NewStreamRenderer 创建当前请求独占的 Gemini SSE Renderer。
func (bound exchange) NewStreamRenderer() clientprotocol.StreamRenderer {
	return bound.adapter.NewStreamRenderer(bound.request)
}

// NewResponseAggregator 创建当前请求独占的 Gemini 聚合器。
func (bound exchange) NewResponseAggregator() clientprotocol.ResponseAggregator {
	return bound.adapter.NewResponseAggregator(bound.request)
}

// NewStreamRenderer 创建固定响应时间的 Gemini SSE Renderer。
func (adapter Adapter) NewStreamRenderer(
	request inference.Request,
) clientprotocol.StreamRenderer {
	return NewStreamRenderer(request, adapter.clock())
}

// NewResponseAggregator 创建固定响应时间的 Gemini 非流式聚合器。
func (adapter Adapter) NewResponseAggregator(
	request inference.Request,
) clientprotocol.ResponseAggregator {
	return NewResponseAggregator(request, adapter.clock())
}
