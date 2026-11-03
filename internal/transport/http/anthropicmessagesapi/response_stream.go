package anthropicmessagesapi

import (
	"errors"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

var (
	// errInvalidPreCommitFailure 表示启动前失败事件违反 Canonical 序号或值合同。
	errInvalidPreCommitFailure = errors.New("提交前 Canonical 失败事件无效")
)

// responseStream 组合 Messages Renderer、SSE 背压和启动前失败状态。
type responseStream struct {
	stream            *sseStream
	renderer          clientprotocol.StreamRenderer
	observed          bool
	renderErr         error
	writeErr          error
	pendingFailure    inference.ResponseFailure
	hasPendingFailure bool
}

// newResponseStream 创建只在当前请求 goroutine 内使用的流执行状态。
func newResponseStream(
	stream *sseStream,
	renderer clientprotocol.StreamRenderer,
) *responseStream {
	return &responseStream{stream: stream, renderer: renderer}
}

// Accept 在提交 SSE 前截获唯一首失败，否则按 Messages 协议即时渲染。
func (stream *responseStream) Accept(event inference.StreamEvent) error {
	if failed, ok := event.(inference.ResponseFailedEvent); ok &&
		!stream.observed &&
		!stream.stream.Committed() {
		failure := failed.Failure()
		if event.Sequence() != 0 || !failure.IsValid() {
			stream.renderErr = errInvalidPreCommitFailure
			return stream.renderErr
		}
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
	stream.observed = true
	if err := stream.stream.Write(frames); err != nil {
		stream.writeErr = err
		return err
	}
	return nil
}

// Terminal 表示 Renderer 或启动前失败已经形成终态。
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

// RenderFailed 表示 Canonical 事件无法按 Messages 合同表达。
func (stream *responseStream) RenderFailed() bool {
	return stream != nil && stream.renderErr != nil
}

// WriteFailed 表示客户端连接不再接受 SSE 输出。
func (stream *responseStream) WriteFailed() bool {
	return stream != nil && stream.writeErr != nil
}
