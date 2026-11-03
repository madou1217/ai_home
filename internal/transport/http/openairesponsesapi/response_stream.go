package openairesponsesapi

import (
	"errors"
	"math"
	"net/http"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

var (
	// errInvalidPreCommitFailure 表示启动前失败事件违反 Canonical 序号或值合同。
	errInvalidPreCommitFailure = errors.New("提交前 Canonical 失败事件无效")
)

// streamFailure 保存传输层补全失败终态所需的安全公开信息。
type streamFailure struct {
	status  int
	code    string
	message string
}

// responseStream 组合 Renderer、SSE 背压和缺失终态恢复状态。
type responseStream struct {
	response          http.ResponseWriter
	stream            *inferenceapi.SSEStream
	renderer          clientprotocol.StreamRenderer
	lastSequence      uint64
	observed          bool
	renderErr         error
	writeErr          error
	pendingFailure    inference.ResponseFailure
	hasPendingFailure bool
}

// newResponseStream 创建只在当前请求 goroutine 内使用的流执行状态。
func newResponseStream(
	response http.ResponseWriter,
	stream *inferenceapi.SSEStream,
	renderer clientprotocol.StreamRenderer,
) *responseStream {
	return &responseStream{
		response: response,
		stream:   stream,
		renderer: renderer,
	}
}

// Accept 渲染一个 Canonical 事件并同步传播客户端写入背压。
func (stream *responseStream) Accept(event inference.StreamEvent) error {
	if failed, ok := event.(inference.ResponseFailedEvent); ok &&
		!stream.observed &&
		!stream.stream.Committed() {
		failure := failed.Failure()
		if event.Sequence() != 0 || !failure.IsValid() {
			stream.renderErr = errInvalidPreCommitFailure
			return stream.renderErr
		}
		stream.lastSequence = event.Sequence()
		stream.observed = true
		stream.pendingFailure = failure
		stream.hasPendingFailure = true
		return nil
	}
	frames, err := stream.renderer.Render(event)
	if err != nil {
		stream.renderErr = err
		return err
	}
	stream.lastSequence = event.Sequence()
	stream.observed = true
	if err := stream.stream.Write(frames); err != nil {
		stream.writeErr = err
		return err
	}
	return nil
}

// Terminal 表示 Renderer 已经收到成功或失败终态。
func (stream *responseStream) Terminal() bool {
	return stream != nil &&
		(stream.hasPendingFailure ||
			stream.renderer != nil && stream.renderer.Terminal())
}

// PreCommitFailure 返回尚未提交 SSE 时收到的唯一 Canonical 失败。
func (stream *responseStream) PreCommitFailure() (
	inference.ResponseFailure,
	bool,
) {
	if stream == nil || !stream.hasPendingFailure {
		return inference.ResponseFailure{}, false
	}
	return stream.pendingFailure, true
}

// RenderFailed 表示 Canonical 事件无法按 Responses 合同表达。
func (stream *responseStream) RenderFailed() bool {
	return stream != nil && stream.renderErr != nil
}

// WriteFailed 表示客户端连接不再接受 SSE 输出。
func (stream *responseStream) WriteFailed() bool {
	return stream != nil && stream.writeErr != nil
}

// Finish 在提交前返回 JSON，提交后生成合法 response.failed 终态。
func (stream *responseStream) Finish(failure streamFailure) {
	if stream == nil ||
		stream.stream == nil ||
		stream.renderer == nil ||
		stream.response == nil {
		return
	}
	if !stream.stream.Committed() {
		writeAPIError(
			stream.response,
			failure.status,
			"server_error",
			failure.code,
			failure.message,
		)
		return
	}
	if !stream.observed || stream.lastSequence == math.MaxUint64 {
		return
	}
	canonicalFailure, err := inference.NewResponseFailure(
		failure.code,
		failure.message,
		true,
	)
	if err != nil {
		return
	}
	failed, err := inference.NewResponseFailedEvent(
		stream.lastSequence+1,
		canonicalFailure,
	)
	if err != nil {
		return
	}
	frames, err := stream.renderer.Render(failed)
	if err != nil {
		return
	}
	_ = stream.stream.Write(frames)
}
