package inferenceapi

import (
	"errors"
	"io"
	"net/http"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// ErrStreamingUnsupported 表示 ResponseWriter 不能即时刷新 SSE。
var ErrStreamingUnsupported = errors.New("HTTP ResponseWriter 不支持流式刷新")

// SSEStream 延迟提交响应头，使执行器启动失败仍能返回 JSON 错误。
type SSEStream struct {
	response  http.ResponseWriter
	flusher   http.Flusher
	committed bool
}

// NewSSEStream 要求底层连接支持即时刷新。
func NewSSEStream(response http.ResponseWriter) (*SSEStream, error) {
	if response == nil {
		return nil, ErrStreamingUnsupported
	}
	flusher, ok := response.(http.Flusher)
	if !ok {
		return nil, ErrStreamingUnsupported
	}
	return &SSEStream{
		response: response,
		flusher:  flusher,
	}, nil
}

// Committed 表示至少一个 SSE 事件已经对客户端可见。
func (stream *SSEStream) Committed() bool {
	return stream != nil && stream.committed
}

// Write 按顺序写入一批 SSE 事件并在批次末尾刷新。
func (stream *SSEStream) Write(
	frames []clientprotocol.RenderedEvent,
) error {
	if stream == nil || stream.response == nil || stream.flusher == nil {
		return ErrStreamingUnsupported
	}
	if len(frames) == 0 {
		return nil
	}
	if !stream.committed {
		stream.response.Header().Set("Cache-Control", "no-cache")
		stream.response.Header().Set("Content-Type", "text/event-stream")
		stream.response.Header().Set("X-Accel-Buffering", "no")
		stream.response.Header().Set("X-Content-Type-Options", "nosniff")
		stream.response.WriteHeader(http.StatusOK)
		stream.committed = true
	}
	for _, frame := range frames {
		if err := writeSSEFrame(stream.response, frame); err != nil {
			return err
		}
	}
	stream.flusher.Flush()
	return nil
}

// writeSSEFrame 写入构造时已保证单行的 JSON 数据。
func writeSSEFrame(
	output io.Writer,
	frame clientprotocol.RenderedEvent,
) error {
	if _, err := io.WriteString(output, "event: "+frame.Name()+"\n"); err != nil {
		return err
	}
	if _, err := io.WriteString(output, "data: "); err != nil {
		return err
	}
	if err := frame.WriteDataTo(output); err != nil {
		return err
	}
	_, err := io.WriteString(output, "\n\n")
	return err
}
