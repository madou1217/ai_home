package codexresponseshttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

type outcome struct {
	completed  bool
	incomplete bool
	failure    inferencegateway.AttemptFailure
	usage      inference.Usage
	// sawContent 表示已经出现过正文事件（非 response.created/in_progress/queued）。
	// 提前提交的流在还没有正文时中断，需要补一帧流内错误，而不是静默截断。
	sawContent bool
}

// isStreamingResponse 判断上游返回的是否为 SSE 流。
func isStreamingResponse(upstream *http.Response, stream bool) bool {
	mediaType, _, _ := mime.ParseMediaType(upstream.Header.Get("Content-Type"))
	return mediaType == "text/event-stream" || (mediaType == "" && stream)
}

// writeResponseHeaders 写出交付所需的响应头（含账号标记与缓存策略）。
//
// 正常路径由 deliver 调用；probe 窗口到期时由调用方先调用一次，以便立即开始
// 心跳。两处必须共用同一实现，否则提前交付与常规交付的头部会漂移。
func writeResponseHeaders(response http.ResponseWriter, upstream *http.Response, ref accountcore.AccountRef, stream bool) {
	copyHeaders(response.Header(), upstream.Header)
	setAccountHeaders(response, ref)
	if response.Header().Get("Cache-Control") == "" {
		response.Header().Set("Cache-Control", "no-store")
	}
	if isStreamingResponse(upstream, stream) && response.Header().Get("Content-Type") == "" {
		response.Header().Set("Content-Type", "text/event-stream")
	}
	response.WriteHeader(upstream.StatusCode)
}

// deliver 交付上游响应体；committed 表示响应头已由提前交付写出，这里不能再写。
func (handler *Handler) deliver(
	response http.ResponseWriter,
	request *http.Request,
	upstream *http.Response,
	route runtimecore.ModelRoute,
	selection Selection,
	stream bool,
	committed bool,
	trail *failureTrail,
) {
	if !committed {
		writeResponseHeaders(response, upstream, selection.AccountRef, stream)
	}
	streaming := isStreamingResponse(upstream, stream)
	var observed outcome
	var upstreamErr, downstreamErr error
	if streaming {
		reader, writer := io.Pipe()
		result := make(chan outcome, 1)
		go func() {
			result <- handler.observeStream(reader, upstream.Header, string(selection.AccountRef))
			_ = reader.Close()
		}()
		upstreamErr, downstreamErr = copyBody(response, io.TeeReader(upstream.Body, &observationTap{writer: writer}), streamHeartbeatInterval)
		_ = writer.CloseWithError(upstreamErr)
		observed = <-result
	} else {
		var captured bytes.Buffer
		upstreamErr, downstreamErr = copyBody(response, io.TeeReader(upstream.Body, &boundedCapture{buffer: &captured, limit: MaxRequestBytes}), 0)
		var envelope struct {
			Status string          `json:"status"`
			Usage  json.RawMessage `json:"usage"`
		}
		if json.Unmarshal(captured.Bytes(), &envelope) == nil {
			observed.completed = envelope.Status == "completed"
			observed.incomplete = envelope.Status == "incomplete"
			observed.usage = decodeUsage(envelope.Usage)
			observedResponse := http.Response{StatusCode: upstream.StatusCode, Header: upstream.Header, Body: io.NopCloser(bytes.NewReader(captured.Bytes()))}
			classification, err := configured.ClassifyWithRules(
				handler.Rules,
				string(selection.AccountRef),
				observedResponse.StatusCode,
				captured.Bytes(),
				func() (sharedfailure.Classification, error) {
					return codexfailure.ObserveHTTP(&observedResponse, handler.Clock())
				},
			)
			if err == nil {
				observed.failure, _ = attemptfailure.New(classification)
			}
		}
	}
	if downstreamErr != nil || request.Context().Err() != nil {
		return
	}
	if observed.failure.IsValid() {
		handler.recordFailure(request.Context(), route, selection, observed.failure)
	} else if observed.completed {
		success, err := inferencegateway.NewAttemptSuccess(handler.Clock())
		if err == nil {
			if observed.usage.TotalTokens() > 0 {
				success = success.WithUsage(observed.usage)
			}
			_, _ = handler.observed.RecordSuccess(request.Context(), route, selection.Observation, success)
		}
	} else if !observed.incomplete {
		if upstreamErr == nil {
			upstreamErr = io.ErrUnexpectedEOF
		}
		failure, err := attemptfailure.NewIncompleteStream(upstreamErr)
		if err == nil {
			handler.recordFailure(request.Context(), route, selection, failure)
		}
	}
	// 提前提交的流在还没有正文时中断：客户端已经拿到 200 头，只能补一帧流内错误，
	// 不能再改写成 HTTP 502。上游自己发过错误帧（observed.failure）时不重复补。
	if committed && !observed.sawContent && !observed.completed && !observed.incomplete && !observed.failure.IsValid() {
		writeStreamFailureFrame(response)
		if trail != nil {
			trail.finish(http.StatusOK, "upstream_stream_interrupted")
		}
	}
}

// flushResponse 立即把已写出的响应头/数据推给客户端。
func flushResponse(response http.ResponseWriter) {
	if err := http.NewResponseController(response).Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return
	}
}

// writeStreamFailureFrame 在已经提交的 SSE 流里补一帧协议级 error 事件。
//
// Responses 的流内错误既可以是 error，也可以是 response.failed；这里选 error，
// 因为它不要求完整的 response 对象，形状更稳定，上游失败分类器也按同一语义识别。
func writeStreamFailureFrame(response http.ResponseWriter) {
	payload, err := json.Marshal(map[string]any{
		"type":    "error",
		"code":    "upstream_stream_interrupted",
		"message": "上游响应流中断",
		"param":   nil,
	})
	if err != nil {
		return
	}
	if _, err := response.Write([]byte("event: error\ndata: " + string(payload) + "\n\n")); err != nil {
		return
	}
	if err := http.NewResponseController(response).Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return
	}
}

func (handler *Handler) observeStream(source io.Reader, header http.Header, accountRef string) outcome {
	reader, err := sharedsse.NewReader(source)
	if err != nil {
		return outcome{}
	}
	sawContent := false
	for {
		event, err := reader.Next()
		if err != nil {
			return outcome{sawContent: sawContent}
		}
		var envelope struct {
			Type     string `json:"type"`
			Response struct {
				Usage json.RawMessage `json:"usage"`
			} `json:"response"`
		}
		if json.Unmarshal(event.Data(), &envelope) != nil {
			continue
		}
		if envelope.Type == "" {
			envelope.Type = event.Type()
		}
		switch envelope.Type {
		case "response.created", "response.in_progress", "response.queued":
		default:
			sawContent = true
		}
		if envelope.Type == "response.completed" {
			return outcome{completed: true, usage: decodeUsage(envelope.Response.Usage), sawContent: sawContent}
		}
		if envelope.Type == "response.incomplete" {
			return outcome{incomplete: true, sawContent: sawContent}
		}
		classification, failed, err := configured.ClassifySSEWithRules(
			handler.Rules,
			accountRef,
			http.StatusOK,
			event.Data(),
			func() (sharedfailure.Classification, bool, error) {
				return codexfailure.ObserveSSE(sharedfailure.SSEInput{EventType: envelope.Type, Data: bytes.NewReader(event.Data()), Header: header, ObservedAt: handler.Clock()})
			},
		)
		if failed && err == nil {
			failure, _ := attemptfailure.New(classification)
			return outcome{failure: failure, sawContent: sawContent}
		}
	}
}

func decodeUsage(payload []byte) inference.Usage {
	var raw struct {
		Input        uint64 `json:"input_tokens"`
		Output       uint64 `json:"output_tokens"`
		InputDetails struct {
			Cached     uint64 `json:"cached_tokens"`
			CacheWrite uint64 `json:"cache_write_tokens"`
		} `json:"input_tokens_details"`
		OutputDetails struct {
			Reasoning uint64 `json:"reasoning_tokens"`
		} `json:"output_tokens_details"`
	}
	if json.Unmarshal(payload, &raw) != nil {
		return inference.Usage{}
	}
	usage, _ := inference.NewUsage(inference.UsageInput{InputTokens: raw.Input, OutputTokens: raw.Output, CachedInputTokens: raw.InputDetails.Cached, CacheWriteInputTokens: raw.InputDetails.CacheWrite, ReasoningTokens: raw.OutputDetails.Reasoning})
	return usage
}

type observationTap struct {
	writer *io.PipeWriter
	closed bool
}

func (tap *observationTap) Write(payload []byte) (int, error) {
	if !tap.closed {
		_, err := tap.writer.Write(payload)
		tap.closed = err != nil
	}
	return len(payload), nil
}

type boundedCapture struct {
	buffer *bytes.Buffer
	limit  int64
}

func (capture *boundedCapture) Write(payload []byte) (int, error) {
	remaining := int(capture.limit) - capture.buffer.Len()
	if remaining > 0 {
		_, _ = capture.buffer.Write(payload[:min(remaining, len(payload))])
	}
	return len(payload), nil
}

// streamHeartbeatInterval 是 SSE 流持续没有上游数据时的保活帧间隔。
//
// Cloudflare 等中间层对静默连接有 100s 左右的存活上限，而一次长推理很容易
// 超过这个窗口；心跳只写 SSE 注释行，不产生事件、不改变客户端看到的事件序列。
const streamHeartbeatInterval = 15 * time.Second

// streamHeartbeatLine 是注释行本体（含换行，不含事件终止空行）。
const streamHeartbeatLine = ": keepalive\n"

// copyBody 逐块把上游字节交付给客户端，并在每次交付后重置空闲窗口。
//
// Server 的 WriteTimeout 是绝对截止时间，会把长推理流硬切断；这里用
// StreamDeadline 把「断开」重新定义为「持续没有数据」（见 G3）。
// heartbeat > 0 时（仅 SSE 响应）在静默期插入注释帧保活。
func copyBody(
	response http.ResponseWriter,
	source io.Reader,
	heartbeat time.Duration,
) (error, error) {
	if heartbeat <= 0 {
		return copyBodyOnce(response, source)
	}
	return copyBodyWithHeartbeat(response, source, heartbeat)
}

// copyBodyOnce 是「来一块写一块」的基础实现，用于非流式响应与已收尾的错误体。
func copyBodyOnce(
	response http.ResponseWriter,
	source io.Reader,
) (error, error) {
	buffer := make([]byte, 32*1024)
	controller := http.NewResponseController(response)
	deadline := inferenceapi.NewStreamDeadline(response)
	for {
		count, readErr := source.Read(buffer)
		if count > 0 {
			if _, err := response.Write(buffer[:count]); err != nil {
				return nil, err
			}
			if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
				return nil, err
			}
			deadline.Refresh()
		}
		if errors.Is(readErr, io.EOF) {
			return nil, nil
		}
		if readErr != nil {
			return readErr, nil
		}
	}
}

// copyBodyWithHeartbeat 在读取上游的同时按静默间隔写 SSE 注释帧。
//
// 读与写必须分开：上游可能长时间一个字节都不产出，阻塞式 Read 无法同时写心跳。
// reader goroutine 只负责读，写只发生在当前 goroutine，避免并发写 ResponseWriter。
func copyBodyWithHeartbeat(
	response http.ResponseWriter,
	source io.Reader,
	heartbeat time.Duration,
) (error, error) {
	controller := http.NewResponseController(response)
	deadline := inferenceapi.NewStreamDeadline(response)
	// 先武装空闲截止时间：心跳不刷新它，否则上游彻底卡死时这条保护失效。
	// 首批上游数据到达后会按正常节奏继续刷新。
	deadline.Refresh()
	type readResult struct {
		payload []byte
		err     error
	}
	results := make(chan readResult)
	done := make(chan struct{})
	defer close(done)
	go func() {
		buffer := make([]byte, 32*1024)
		for {
			count, readErr := source.Read(buffer)
			result := readResult{err: readErr}
			if count > 0 {
				// 交付所有权给写侧；缓冲区留在本 goroutine 复用。
				result.payload = append([]byte(nil), buffer[:count]...)
			}
			select {
			case results <- result:
			case <-done:
				return
			}
			if readErr != nil {
				return
			}
		}
	}()

	// trailer 记录已写出内容的最后两个字节，用于判断注释帧能否安全插入：
	// SSE 以行/空行分帧，只有行边界才能写注释；空行（\n\n）才是事件边界。
	var trailer [2]byte
	written := 0
	write := func(payload []byte, refreshDeadline bool) error {
		if len(payload) == 0 {
			return nil
		}
		if _, err := response.Write(payload); err != nil {
			return err
		}
		for _, value := range payload {
			trailer[0], trailer[1] = trailer[1], value
		}
		written += len(payload)
		if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
			return err
		}
		// 心跳只是给中间层续命，不代表上游还活着：不能刷新空闲截止时间，
		// 否则 StreamIdleTimeout 对「上游彻底卡死」失效，只剩 60 分钟总兜底。
		if refreshDeadline {
			deadline.Refresh()
		}
		return nil
	}

	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case result := <-results:
			if err := write(result.payload, true); err != nil {
				return nil, err
			}
			if errors.Is(result.err, io.EOF) {
				return nil, nil
			}
			if result.err != nil {
				return result.err, nil
			}
			ticker.Reset(heartbeat)
		case <-ticker.C:
			if frame := streamHeartbeatFrame(trailer, written); frame != "" {
				if err := write([]byte(frame), false); err != nil {
					return nil, err
				}
			}
			ticker.Reset(heartbeat)
		}
	}
}

// streamHeartbeatFrame 根据已写出的尾部字节返回可安全插入的注释帧。
//
// 帧首不能落在半行中间（会被当成上一行内容），因此：
//   - 还没写过内容：直接写完整注释帧；
//   - 上一个字节不是换行：跳过本次心跳，等下一个静默窗口；
//   - 行尾但不是事件边界：只写注释行，避免提前终止尚未结束的事件（多行 data）；
//   - 空行之后（\n\n）：写注释帧并用空行收尾。
func streamHeartbeatFrame(trailer [2]byte, written int) string {
	if written == 0 {
		return streamHeartbeatLine + "\n"
	}
	if trailer[1] != '\n' {
		return ""
	}
	if trailer[0] == '\n' {
		return streamHeartbeatLine + "\n"
	}
	return streamHeartbeatLine
}

func copyHeaders(destination, source http.Header) {
	excluded := map[string]bool{"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true, "Proxy-Connection": true, "Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true, "Set-Cookie": true}
	for _, value := range source.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			excluded[http.CanonicalHeaderKey(strings.TrimSpace(name))] = true
		}
	}
	for name, values := range source {
		canonical := http.CanonicalHeaderKey(name)
		if excluded[canonical] || strings.HasPrefix(canonical, "X-Aih-") {
			continue
		}
		destination[canonical] = append([]string(nil), values...)
	}
}

func setAccountHeaders(response http.ResponseWriter, ref accountcore.AccountRef) {
	response.Header().Set("X-Aih-Server-Account-Ref", string(ref))
	response.Header().Set("X-Aih-Server-Provider", "codex")
}
