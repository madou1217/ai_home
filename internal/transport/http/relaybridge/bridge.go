package relaybridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// Surface 描述一个客户端入口协议与 OpenAI Chat 线协议之间的转换面。
type Surface interface {
	// ID 是入口协议标识（用于日志与错误归属）。
	ID() string
	// Path 是该入口在 HTTP 路由器上的真实路径。
	Path() string
	// Decode 把客户端请求转换为 Chat 请求，并返回用于响应渲染的 Canonical 请求。
	Decode(body []byte) (Decoded, error)
	// NewRenderer 创建流式响应渲染器。
	NewRenderer(request inference.Request) (clientprotocol.StreamRenderer, error)
	// NewAggregator 创建非流式响应聚合器。
	NewAggregator(request inference.Request) clientprotocol.ResponseAggregator
	// ErrorBody 把网关/上游错误渲染成客户端协议的错误 JSON。
	ErrorBody(status int, code string, message string) []byte
	// ErrorEvent 把流中途错误渲染成客户端协议的 SSE 错误事件。
	ErrorEvent(status int, code string, message string) (clientprotocol.RenderedEvent, bool)
}

// Decoded 是一次客户端请求的桥接结果。
type Decoded struct {
	Chat    []byte
	Request inference.Request
	Stream  bool
}

// RouteChecker 判断模型是否已有 Canonical 执行路由。
//
// 有 Canonical 路由的模型必须继续走原入口（claude/codex 原生通道），否则会改变
// 字段保真与账号选择语义；只有目录里没有 Canonical 规则的 relay-only 模型才进桥。
type RouteChecker interface {
	Resolve(ctx context.Context, request inference.Request) (inferencegateway.RoutePlan, error)
}

// DelegateSignal 是交给 relaycore.Handler 的 Fallback：透传通道服务不了时触发，
// 由 Bridge 用原始请求调用真正的下游入口。
type DelegateSignal struct {
	delegated atomic.Bool
}

// ServeHTTP 标记本次请求需要交还下游。
func (signal *DelegateSignal) ServeHTTP(http.ResponseWriter, *http.Request) {
	signal.delegated.Store(true)
}

func (signal *DelegateSignal) reset() {
	signal.delegated.Store(false)
}

func (signal *DelegateSignal) delegatedNow() bool {
	return signal != nil && signal.delegated.Load()
}

// Bridge 在 relaycore 透传通道外面加一层客户端协议转换。
type Bridge struct {
	inner    *relaycore.Handler
	signal   *DelegateSignal
	surface  Surface
	routes   RouteChecker
	fallback http.Handler
	maxBody  int64
}

// New 构造桥接入口。
//
// inner 的 Path 被固定为 surface.Path()，Fallback 被替换为内部交还信号；
// fallback 是真正承接「本桥不服务」请求的下游入口（原生 relay / Canonical）。
func New(
	dependencies relaycore.Dependencies,
	surface Surface,
	routes RouteChecker,
	fallback http.Handler,
) (*Bridge, error) {
	if surface == nil {
		return nil, relaycore.ErrInvalidDependencies
	}
	signal := &DelegateSignal{}
	dependencies.Path = surface.Path()
	dependencies.Fallback = signal
	inner, err := relaycore.NewHandler(dependencies)
	if err != nil {
		return nil, err
	}
	limit := dependencies.MaxRequestBodyBytes
	if limit <= 0 {
		limit = relaycore.MaxRequestBodyBytes
	}
	return &Bridge{
		inner:    inner,
		signal:   signal,
		surface:  surface,
		routes:   routes,
		fallback: fallback,
		maxBody:  limit,
	}, nil
}

// SetFallback 在路由器装配阶段替换下游入口。
//
// Responses 入口的下游 dispatcher 依赖 WebSocket 处理器，而它晚于透传装配创建；
// 这里允许路由器在最终挂载前补齐完整的下游，而不是在组合根里提前分叉一份。
func (bridge *Bridge) SetFallback(fallback http.Handler) {
	if bridge != nil {
		bridge.fallback = fallback
	}
}

// ServeHTTP 先做协议转换与路由门槛，再进入透传通道。
func (bridge *Bridge) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if bridge == nil || bridge.inner == nil || bridge.surface == nil {
		if bridge != nil && bridge.fallback != nil {
			bridge.fallback.ServeHTTP(response, request)
			return
		}
		http.Error(response, "relay bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	if request == nil || request.Method != http.MethodPost || request.Body == nil {
		bridge.delegate(response, request, nil)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, bridge.maxBody+1))
	if err != nil || int64(len(body)) > bridge.maxBody {
		bridge.delegate(response, request, body)
		return
	}
	decoded, err := bridge.surface.Decode(body)
	if err != nil {
		bridge.delegate(response, request, body)
		return
	}
	if bridge.routes != nil {
		if _, resolveErr := bridge.routes.Resolve(request.Context(), decoded.Request); !errors.Is(resolveErr, inferencegateway.ErrRouteNotFound) {
			// Canonical 有路由，或目录暂不可用：保持原入口的字段保真与账号选择。
			// 只有「目录明确没有该模型路由」才进桥，避免把目录故障放大成改道。
			bridge.delegate(response, request, body)
			return
		}
	}
	bridge.signal.reset()
	relayRequest := request.Clone(request.Context())
	relayRequest.Body = io.NopCloser(bytes.NewReader(decoded.Chat))
	relayRequest.ContentLength = int64(len(decoded.Chat))
	relayRequest.Header = request.Header.Clone()
	relayRequest.Header.Set("Content-Type", "application/json")
	writer := newBridgeWriter(response, bridge.surface, decoded.Request, decoded.Stream)
	bridge.inner.ServeHTTP(writer, relayRequest)
	if bridge.signal.delegatedNow() {
		writer.discard()
		bridge.delegate(response, request, body)
		return
	}
	writer.finish()
}

// delegate 把原始请求原样交给下游入口。
func (bridge *Bridge) delegate(
	response http.ResponseWriter,
	request *http.Request,
	body []byte,
) {
	if bridge.fallback == nil {
		writeJSONError(response, http.StatusServiceUnavailable, "relay_unavailable", "relay bridge unavailable")
		return
	}
	if request != nil {
		restored := request.Clone(request.Context())
		if body != nil {
			restored.Body = io.NopCloser(bytes.NewReader(body))
			restored.ContentLength = int64(len(body))
		}
		request = restored
	}
	bridge.fallback.ServeHTTP(response, request)
}

// bridgeWriter 把 relaycore 输出的 Chat 线协议转成客户端协议。
type bridgeWriter struct {
	underlying http.ResponseWriter
	surface    Surface
	request    inference.Request
	stream     bool

	status     int
	headerSent bool
	discarded  bool
	finished   bool
	failed     bool
	streamKind uint8

	body bytes.Buffer
	sse  sseFramer
	// raw 只保留流式响应的前 1 MiB，用于识别「要了流式但上游回了完整 JSON」。
	raw bytes.Buffer

	decoder      *chatEventDecoder
	renderer     clientprotocol.StreamRenderer
	aggregator   clientprotocol.ResponseAggregator
	streamOut    *inferenceapi.SSEStream
	finishReason string
}

func newBridgeWriter(
	response http.ResponseWriter,
	surface Surface,
	request inference.Request,
	stream bool,
) *bridgeWriter {
	writer := &bridgeWriter{
		underlying: response,
		surface:    surface,
		request:    request,
		stream:     stream,
		status:     http.StatusOK,
		decoder:    newChatEventDecoder("", request.Model()),
	}
	if stream {
		if renderer, err := surface.NewRenderer(request); err == nil {
			writer.renderer = renderer
		}
	} else {
		writer.aggregator = surface.NewAggregator(request)
	}
	return writer
}

// Header 返回底层响应头；Content-Type/Length 在交付时统一改写。
func (writer *bridgeWriter) Header() http.Header {
	return writer.underlying.Header()
}

// WriteHeader 只记录状态码，等确认是客户端协议响应时再提交。
func (writer *bridgeWriter) WriteHeader(status int) {
	if writer.headerSent || writer.finished {
		return
	}
	writer.status = status
}

// Write 吸收 relaycore 写出的 Chat 字节。
func (writer *bridgeWriter) Write(payload []byte) (int, error) {
	if writer.finished || writer.discarded {
		return len(payload), nil
	}
	if writer.status >= http.StatusBadRequest {
		return writer.body.Write(payload)
	}
	if writer.stream {
		switch writer.detectStreamKind(payload) {
		case streamKindJSON:
			if writer.raw.Len() < 4<<20 {
				writer.raw.Write(payload)
			}
			return len(payload), nil
		case streamKindSSE:
			for _, data := range writer.sse.Feed(payload) {
				if err := writer.consumeSSE(data); err != nil {
					writer.failStream(http.StatusBadGateway, "relay_bridge_decode_failed", err.Error())
					return len(payload), nil
				}
			}
			return len(payload), nil
		default:
			return len(payload), nil
		}
	}
	return writer.body.Write(payload)
}

// Flush 在流式已提交时刷新底层连接。
func (writer *bridgeWriter) Flush() {
	if writer.streamOut != nil {
		if flusher, ok := writer.underlying.(http.Flusher); ok {
			flusher.Flush()
		}
	}
}

func (writer *bridgeWriter) discard() {
	writer.discarded = true
}

// finish 在 relaycore 返回后完成客户端协议交付。
func (writer *bridgeWriter) finish() {
	if writer.finished || writer.discarded {
		return
	}
	writer.finished = true
	if writer.stream {
		writer.finishStream()
		return
	}
	writer.finishBuffered()
}

func (writer *bridgeWriter) finishBuffered() {
	if writer.status >= http.StatusBadRequest {
		writer.writeError(writer.status, extractErrorMessage(writer.body.Bytes()))
		return
	}
	if writer.aggregator == nil {
		writer.writeError(http.StatusBadGateway, "客户端协议渲染器不可用")
		return
	}
	payload := writer.body.Bytes()
	var completion chatWire
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &completion); err != nil {
			writer.writeError(http.StatusBadGateway, "上游响应无法解析")
			return
		}
	}
	if len(completion.Error) > 0 && string(completion.Error) != "null" {
		writer.writeError(http.StatusBadGateway, extractErrorMessage(payload))
		return
	}
	decoder := writer.decoder
	if completion.ID != "" {
		decoder.responseID = completion.ID
	}
	if completion.Model != "" {
		decoder.model = completion.Model
	}
	decoder.applyUsage(completion.Usage)
	finishReason := ""
	var message chatMessage
	if choice, ok := firstChoice(completion); ok {
		message = choice.Message
		if choice.FinishReason != nil {
			finishReason = *choice.FinishReason
		}
	}
	events, err := decoder.consumeCompletion(message)
	if err != nil {
		writer.writeError(http.StatusBadGateway, "响应内容无法转换")
		return
	}
	final, err := decoder.finish(finishReason)
	if err != nil {
		writer.writeError(http.StatusBadGateway, "响应终止状态无法转换")
		return
	}
	events = append(events, final...)
	for _, event := range events {
		if err := writer.aggregator.Add(event); err != nil {
			writer.writeError(http.StatusBadGateway, "响应事件顺序无效")
			return
		}
	}
	body, err := writer.aggregator.Marshal()
	if err != nil {
		writer.writeError(http.StatusBadGateway, "响应聚合失败")
		return
	}
	writer.commitHeaders("application/json; charset=utf-8")
	writer.underlying.WriteHeader(writer.status)
	_, _ = writer.underlying.Write(body)
}

// finishStreamFromCompletion 把「流式入口收到完整 JSON」补成客户端协议流。
func (writer *bridgeWriter) finishStreamFromCompletion(completion chatWire) {
	if len(completion.Error) > 0 && string(completion.Error) != "null" {
		writer.writeError(http.StatusBadGateway, extractErrorMessage(writer.raw.Bytes()))
		return
	}
	if writer.renderer == nil {
		writer.writeError(http.StatusBadGateway, "客户端协议渲染器不可用")
		return
	}
	decoder := writer.decoder
	if completion.ID != "" {
		decoder.responseID = completion.ID
	}
	if completion.Model != "" {
		decoder.model = completion.Model
	}
	decoder.applyUsage(completion.Usage)
	finishReason := ""
	var message chatMessage
	if choice, ok := firstChoice(completion); ok {
		message = choice.Message
		if choice.FinishReason != nil {
			finishReason = *choice.FinishReason
		}
	}
	events, err := decoder.consumeCompletion(message)
	if err != nil {
		writer.writeError(http.StatusBadGateway, "响应内容无法转换")
		return
	}
	final, err := decoder.finish(finishReason)
	if err != nil {
		writer.writeError(http.StatusBadGateway, "响应终止状态无法转换")
		return
	}
	writer.writeEvents(append(events, final...))
	if flusher, ok := writer.underlying.(http.Flusher); ok {
		flusher.Flush()
	}
}

func firstChoice(completion chatWire) (chatChoice, bool) {
	for _, choice := range completion.Choices {
		if choice.Index == 0 {
			return choice, true
		}
	}
	return chatChoice{}, false
}

func parseChatCompletion(payload []byte) (chatWire, bool) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return chatWire{}, false
	}
	var completion chatWire
	if err := json.Unmarshal(trimmed, &completion); err != nil {
		return chatWire{}, false
	}
	if len(completion.Choices) == 0 && completion.Usage == nil {
		return chatWire{}, false
	}
	return completion, true
}

func (writer *bridgeWriter) finishStream() {
	if writer.status >= http.StatusBadRequest {
		writer.writeError(writer.status, extractErrorMessage(writer.body.Bytes()))
		return
	}
	// 上游忽略 stream 参数、直接回完整 JSON 时按非流式响应补交付。
	if writer.streamKind == streamKindJSON && writer.streamOut == nil && !writer.decoder.started {
		var rawCompletion chatWire
		if json.Unmarshal(writer.raw.Bytes(), &rawCompletion) == nil &&
			len(rawCompletion.Error) > 0 && string(rawCompletion.Error) != "null" {
			writer.writeError(http.StatusBadGateway, extractErrorMessage(writer.raw.Bytes()))
			return
		}
		if completion, ok := parseChatCompletion(writer.raw.Bytes()); ok {
			writer.finishStreamFromCompletion(completion)
			return
		}
	}
	// 处理没有以空行结尾的最后一帧。
	for _, data := range writer.sse.Remaining() {
		if err := writer.consumeSSE(data); err != nil {
			writer.failStream(http.StatusBadGateway, "relay_bridge_decode_failed", err.Error())
			return
		}
	}
	if writer.failed {
		return
	}
	if writer.renderer == nil {
		writer.writeError(http.StatusBadGateway, "客户端协议渲染器不可用")
		return
	}
	final, err := writer.decoder.finish(writer.finishReason)
	if err != nil {
		writer.failStream(http.StatusBadGateway, "relay_bridge_decode_failed", "响应终止状态无法转换")
		return
	}
	writer.writeEvents(final)
	if writer.streamOut != nil {
		if flusher, ok := writer.underlying.(http.Flusher); ok {
			flusher.Flush()
		}
	}
}

// consumeSSE 处理一个 Chat SSE data 帧。
func (writer *bridgeWriter) consumeSSE(data string) error {
	if writer.failed {
		return nil
	}
	trimmed := strings.TrimSpace(data)
	if trimmed == "" {
		return nil
	}
	if trimmed == "[DONE]" {
		final, err := writer.decoder.finish(writer.finishReason)
		if err != nil {
			return err
		}
		writer.writeEvents(final)
		return nil
	}
	var chunk chatWire
	if err := json.Unmarshal([]byte(trimmed), &chunk); err != nil {
		return err
	}
	if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
		writer.failStream(http.StatusBadGateway, "relay_upstream_error", extractErrorMessage([]byte(trimmed)))
		return nil
	}
	if chunk.ID != "" {
		writer.decoder.responseID = chunk.ID
	}
	if chunk.Model != "" {
		writer.decoder.model = chunk.Model
	}
	writer.decoder.applyUsage(chunk.Usage)
	for _, choice := range chunk.Choices {
		if choice.Index != 0 {
			continue
		}
		if choice.FinishReason != nil && *choice.FinishReason != "" {
			writer.finishReason = *choice.FinishReason
		}
		events, err := writer.decoder.consumeDelta(choice.Delta)
		if err != nil {
			return err
		}
		writer.writeEvents(events)
	}
	return nil
}

// writeEvents 用客户端协议渲染器输出事件。
func (writer *bridgeWriter) writeEvents(events []inference.StreamEvent) {
	if writer.failed || writer.renderer == nil {
		return
	}
	for _, event := range events {
		frames, err := writer.renderer.Render(event)
		if err != nil {
			writer.failStream(http.StatusBadGateway, "client_protocol_render_failed", "响应无法渲染为客户端协议")
			return
		}
		writer.writeFrames(frames)
	}
}

func (writer *bridgeWriter) writeFrames(frames []clientprotocol.RenderedEvent) {
	if len(frames) == 0 {
		return
	}
	if writer.streamOut == nil {
		stream, err := inferenceapi.NewSSEStream(writer.underlying)
		if err != nil {
			// 底层不支持刷新时不能再递归走 writeError：它已经提交过流式头。
			writer.commitHeaders("application/json; charset=utf-8")
			writer.underlying.WriteHeader(http.StatusBadGateway)
			_, _ = writer.underlying.Write(writer.surface.ErrorBody(
				http.StatusBadGateway, "streaming_unsupported", "流式响应不可用",
			))
			return
		}
		writer.commitHeaders("text/event-stream")
		writer.streamOut = stream
	}
	_ = writer.streamOut.Write(frames)
}

// failStream 在已经提交流后补一个客户端协议错误事件。
func (writer *bridgeWriter) failStream(status int, code string, message string) {
	if writer.discarded || writer.failed {
		return
	}
	writer.failed = true
	frame, ok := writer.surface.ErrorEvent(status, code, message)
	if !ok {
		return
	}
	writer.writeFrames([]clientprotocol.RenderedEvent{frame})
	writer.finished = true
}

func (writer *bridgeWriter) writeError(status int, message string) {
	if writer.headerSent {
		writer.failStream(status, "relay_error", message)
		return
	}
	if message == "" {
		message = http.StatusText(status)
	}
	writer.commitHeaders("application/json; charset=utf-8")
	writer.underlying.WriteHeader(status)
	_, _ = writer.underlying.Write(writer.surface.ErrorBody(status, "relay_error", message))
}

func (writer *bridgeWriter) commitHeaders(contentType string) {
	if writer.headerSent {
		return
	}
	writer.headerSent = true
	header := writer.underlying.Header()
	header.Del("Content-Length")
	header.Set("Content-Type", contentType)
	if contentType == "text/event-stream" {
		header.Set("Cache-Control", "no-cache")
		header.Set("X-Accel-Buffering", "no")
		header.Set("X-Content-Type-Options", "nosniff")
	}
}

const (
	streamKindUnknown uint8 = iota
	streamKindSSE
	streamKindJSON
)

// detectStreamKind 在首个非空字节上决定响应线协议，避免把整段 JSON 当作 SSE 切分。
func (writer *bridgeWriter) detectStreamKind(payload []byte) uint8 {
	if writer.streamKind != streamKindUnknown {
		return writer.streamKind
	}
	trimmed := bytes.TrimLeft(payload, " \t\r\n")
	if len(trimmed) == 0 {
		return streamKindUnknown
	}
	if trimmed[0] == '{' || trimmed[0] == '[' {
		writer.streamKind = streamKindJSON
	} else {
		writer.streamKind = streamKindSSE
	}
	return writer.streamKind
}

// sseFramer 把任意切分的 Chat SSE 字节流还原成 data 帧。
type sseFramer struct {
	buffer bytes.Buffer
}

func (framer *sseFramer) Feed(payload []byte) []string {
	framer.buffer.Write(payload)
	var events []string
	for {
		data, ok := framer.take()
		if !ok {
			break
		}
		events = append(events, data)
	}
	return events
}

func (framer *sseFramer) Remaining() []string {
	var events []string
	for {
		data, ok := framer.take()
		if !ok {
			break
		}
		events = append(events, data)
	}
	if remaining := strings.TrimSpace(framer.buffer.String()); remaining != "" {
		framer.buffer.Reset()
		if data := sseDataOf(remaining); data != "" {
			events = append(events, data)
		}
	}
	return events
}

func (framer *sseFramer) take() (string, bool) {
	raw := framer.buffer.Bytes()
	index := bytes.Index(raw, []byte("\n\n"))
	separator := 2
	if index < 0 {
		index = bytes.Index(raw, []byte("\r\n\r\n"))
		separator = 4
	}
	if index < 0 {
		return "", false
	}
	block := string(raw[:index])
	framer.buffer.Next(index + separator)
	return sseDataOf(block), true
}

func sseDataOf(block string) string {
	var lines []string
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		lines = append(lines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
	}
	return strings.Join(lines, "\n")
}

// extractErrorMessage 从网关/上游错误体里取低敏消息。
func extractErrorMessage(payload []byte) string {
	var object struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(payload, &object); err != nil {
		text := strings.TrimSpace(string(payload))
		if text == "" || len(text) > 512 {
			return ""
		}
		return text
	}
	if object.Error.Message != "" {
		return object.Error.Message
	}
	return object.Message
}

func writeJSONError(response http.ResponseWriter, status int, code string, message string) {
	payload, _ := json.Marshal(map[string]any{
		"error": map[string]string{"type": code, "code": code, "message": message},
	})
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(payload)
}

// now 是响应渲染器需要的业务时钟。
func now() time.Time { return time.Now() }
