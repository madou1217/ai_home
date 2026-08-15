package claudenativerelay

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
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	claudefailure "github.com/madou1217/ai_home/internal/adapters/claude/upstreamfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// nativeStreamObservation 是旁路 SSE 观察器生成的唯一运行态终态。
type nativeStreamObservation struct {
	failure     inferencegateway.AttemptFailure
	failed      bool
	completed   bool
	completedAt time.Time
}

// responseCopyResult 区分上游读取失败和下游客户端写入失败。
//
// 只有前者属于账号模型运行态；下游断开不能惩罚所选账号。
type responseCopyResult struct {
	upstreamErr   error
	downstreamErr error
}

// shouldObserveNativeStream 按响应媒体类型识别 SSE；缺失类型时尊重请求 stream。
func shouldObserveNativeStream(header http.Header, requested bool) bool {
	value := strings.TrimSpace(header.Get("Content-Type"))
	if value == "" {
		return requested
	}
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && mediaType == "text/event-stream"
}

// copyAndObserveNativeStream 保持原始 SSE 字节直通，同时旁路识别失败和完成事件。
func copyAndObserveNativeStream(
	response http.ResponseWriter,
	body io.Reader,
	header http.Header,
	clock func() time.Time,
) (responseCopyResult, nativeStreamObservation) {
	reader, writer := io.Pipe()
	observed := make(chan nativeStreamObservation, 1)
	go func() {
		observed <- observeNativeStream(reader, header, clock)
		_ = reader.Close()
	}()
	result := copyResponseBody(response, io.TeeReader(body, writer))
	if result.upstreamErr != nil {
		_ = writer.CloseWithError(result.upstreamErr)
	} else {
		_ = writer.Close()
	}
	return result, <-observed
}

// observeNativeStream 复用统一 Claude 失败分类器，但不修改或重新编码事件。
func observeNativeStream(
	source io.Reader,
	header http.Header,
	clock func() time.Time,
) nativeStreamObservation {
	if clock == nil {
		return malformedNativeStreamObservation()
	}
	reader, err := sharedsse.NewReader(source)
	if err != nil {
		return malformedNativeStreamObservation()
	}
	terminal := false
	var observed nativeStreamObservation
	for {
		event, readErr := reader.Next()
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) && !observed.failed && !terminal {
				observed = nativeStreamReadFailure(readErr)
			}
			if !observed.failed && !terminal {
				observed = incompleteNativeStreamObservation(io.EOF)
			}
			if !observed.failed && terminal {
				observed.completed = true
			}
			return observed
		}
		if bytes.Equal(bytes.TrimSpace(event.Data()), []byte("[DONE]")) {
			if !observed.failed {
				observed = incompleteNativeStreamObservation(io.EOF)
			}
			continue
		}
		eventAt := clock()
		classification, failed, observeErr := claudefailure.ObserveSSE(
			sharedfailure.SSEInput{
				EventType:  event.Type(),
				Data:       bytes.NewReader(event.Data()),
				Header:     header,
				ObservedAt: eventAt,
			},
		)
		if observeErr != nil && !observed.failed {
			observed = malformedNativeStreamObservation()
		} else if failed && !observed.failed {
			failure, mapErr := attemptfailure.New(classification)
			if mapErr != nil {
				observed = malformedNativeStreamObservation()
			} else {
				observed = nativeStreamObservation{
					failure: failure,
					failed:  true,
				}
			}
		}
		if isNativeMessageStop(event) {
			terminal = true
			if observed.completedAt.IsZero() {
				observed.completedAt = eventAt
			}
		}
	}
}

// nativeStreamReadFailure 把 SSE 分帧错误映射为格式或断流失败。
func nativeStreamReadFailure(err error) nativeStreamObservation {
	if errors.Is(err, sharedsse.ErrInvalidEvent) ||
		errors.Is(err, sharedsse.ErrInvalidSource) {
		return malformedNativeStreamObservation()
	}
	var upstreamRead *sharedsse.ReadError
	if errors.As(err, &upstreamRead) {
		return incompleteNativeStreamObservation(upstreamRead.Cause())
	}
	return malformedNativeStreamObservation()
}

// incompleteNativeStreamObservation 创建不包含上游原文的断流终态。
func incompleteNativeStreamObservation(err error) nativeStreamObservation {
	failure, classifyErr := attemptfailure.NewIncompleteStream(err)
	if classifyErr != nil {
		return malformedNativeStreamObservation()
	}
	return nativeStreamObservation{failure: failure, failed: true}
}

// malformedNativeStreamObservation 创建稳定的响应格式失败。
func malformedNativeStreamObservation() nativeStreamObservation {
	failure, err := attemptfailure.NewClassified(
		runtimecore.FailureMalformedResponse,
	)
	return nativeStreamObservation{failure: failure, failed: err == nil}
}

// isNativeMessageStop 同时接受标准 event 字段和正文 type 终态。
func isNativeMessageStop(event sharedsse.Event) bool {
	if event.Type() == "message_stop" {
		return true
	}
	var envelope struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(event.Data(), &envelope) == nil &&
		envelope.Type == "message_stop"
}

// copyResponseBody 逐块刷新 SSE，也兼容普通 JSON 错误响应。
func copyResponseBody(
	response http.ResponseWriter,
	body io.Reader,
) responseCopyResult {
	buffer := make([]byte, 32*1024)
	flusher, canFlush := response.(http.Flusher)
	for {
		read, readErr := body.Read(buffer)
		if read > 0 {
			if _, writeErr := response.Write(buffer[:read]); writeErr != nil {
				return responseCopyResult{downstreamErr: writeErr}
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return responseCopyResult{}
			}
			return responseCopyResult{upstreamErr: readErr}
		}
	}
}
