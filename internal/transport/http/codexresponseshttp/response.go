package codexresponseshttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

type outcome struct {
	completed  bool
	incomplete bool
	failure    inferencegateway.AttemptFailure
	usage      inference.Usage
}

func (handler *Handler) deliver(response http.ResponseWriter, request *http.Request, upstream *http.Response, route runtimecore.ModelRoute, selection Selection, stream bool) {
	copyHeaders(response.Header(), upstream.Header)
	setAccountHeaders(response, selection.AccountRef)
	if response.Header().Get("Cache-Control") == "" {
		response.Header().Set("Cache-Control", "no-store")
	}
	mediaType, _, _ := mime.ParseMediaType(upstream.Header.Get("Content-Type"))
	streaming := mediaType == "text/event-stream" || (mediaType == "" && stream)
	if streaming && response.Header().Get("Content-Type") == "" {
		response.Header().Set("Content-Type", "text/event-stream")
	}
	response.WriteHeader(upstream.StatusCode)
	var observed outcome
	var upstreamErr, downstreamErr error
	if streaming {
		reader, writer := io.Pipe()
		result := make(chan outcome, 1)
		go func() {
			result <- handler.observeStream(reader, upstream.Header)
			_ = reader.Close()
		}()
		upstreamErr, downstreamErr = copyBody(response, io.TeeReader(upstream.Body, &observationTap{writer: writer}))
		_ = writer.CloseWithError(upstreamErr)
		observed = <-result
	} else {
		var captured bytes.Buffer
		upstreamErr, downstreamErr = copyBody(response, io.TeeReader(upstream.Body, &boundedCapture{buffer: &captured, limit: MaxRequestBytes}))
		var envelope struct {
			Status string          `json:"status"`
			Usage  json.RawMessage `json:"usage"`
		}
		if json.Unmarshal(captured.Bytes(), &envelope) == nil {
			observed.completed = envelope.Status == "completed"
			observed.incomplete = envelope.Status == "incomplete"
			observed.usage = decodeUsage(envelope.Usage)
			classification, err := codexfailure.ObserveHTTP(&http.Response{StatusCode: upstream.StatusCode, Header: upstream.Header, Body: io.NopCloser(bytes.NewReader(captured.Bytes()))}, handler.Clock())
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
}

func (handler *Handler) observeStream(source io.Reader, header http.Header) outcome {
	reader, err := sharedsse.NewReader(source)
	if err != nil {
		return outcome{}
	}
	for {
		event, err := reader.Next()
		if err != nil {
			return outcome{}
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
		if envelope.Type == "response.completed" {
			return outcome{completed: true, usage: decodeUsage(envelope.Response.Usage)}
		}
		if envelope.Type == "response.incomplete" {
			return outcome{incomplete: true}
		}
		classification, failed, err := codexfailure.ObserveSSE(sharedfailure.SSEInput{EventType: envelope.Type, Data: bytes.NewReader(event.Data()), Header: header, ObservedAt: handler.Clock()})
		if failed && err == nil {
			failure, _ := attemptfailure.New(classification)
			return outcome{failure: failure}
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

// copyBody 逐块把上游字节交付给客户端，并在每次交付后重置空闲窗口。
//
// Server 的 WriteTimeout 是绝对截止时间，会把长推理流硬切断；这里用
// StreamDeadline 把「断开」重新定义为「持续没有数据」（见 G3）。
func copyBody(
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
