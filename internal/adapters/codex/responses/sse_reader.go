package responses

import (
	"errors"
	"io"

	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
)

const (
	// maxSSEEventBytes 保留原包内测试使用的共享事件上限。
	maxSSEEventBytes = sharedsse.MaxEventBytes
)

// sseEvent 保持 Codex Decoder 与共享 SSE 读取职责解耦。
type sseEvent struct {
	eventType string
	data      []byte
}

// sseReader 是共享 SSE Reader 的 Codex 协议薄适配层。
type sseReader struct {
	reader  *sharedsse.Reader
	initErr error
}

// newSSEReader 创建不改变既有 Codex 调用合同的共享 Reader 包装。
func newSSEReader(source io.Reader) *sseReader {
	reader, err := sharedsse.NewReader(source)
	return &sseReader{
		reader:  reader,
		initErr: err,
	}
}

// Next 把共享解析错误映射回 Codex Adapter 的既有错误分类。
func (reader *sseReader) Next() (sseEvent, error) {
	if reader == nil || reader.initErr != nil || reader.reader == nil {
		return sseEvent{}, ErrInvalidUpstreamResponse
	}
	event, err := reader.reader.Next()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return sseEvent{}, io.EOF
		}
		if errors.Is(err, sharedsse.ErrInvalidEvent) ||
			errors.Is(err, sharedsse.ErrInvalidSource) {
			return sseEvent{}, ErrInvalidUpstreamResponse
		}
		var readErr *sharedsse.ReadError
		if errors.As(err, &readErr) {
			return sseEvent{}, upstreamReadError{
				cause: readErr.Cause(),
			}
		}
		return sseEvent{}, ErrInvalidUpstreamResponse
	}
	return sseEvent{
		eventType: event.Type(),
		data:      event.Data(),
	}, nil
}
