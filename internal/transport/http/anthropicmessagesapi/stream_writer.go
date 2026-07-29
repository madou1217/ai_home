package anthropicmessagesapi

import (
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// sseStream 复用推理 HTTP 边界的延迟提交 SSE 传输。
type sseStream = inferenceapi.SSEStream

// newSSEStream 要求底层连接支持即时刷新。
func newSSEStream(response http.ResponseWriter) (*sseStream, error) {
	return inferenceapi.NewSSEStream(response)
}
