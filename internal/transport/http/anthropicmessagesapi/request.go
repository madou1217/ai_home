package anthropicmessagesapi

import (
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

var (
	// errInvalidContentType 表示请求未使用 JSON 媒体类型。
	errInvalidContentType = inferenceapi.ErrInvalidContentType
	// errUnsupportedContentEncoding 表示请求体使用了未审计的压缩编码。
	errUnsupportedContentEncoding = inferenceapi.ErrUnsupportedContentEncoding
	// errRequestTooLarge 表示请求体超过显式内存上限。
	errRequestTooLarge = inferenceapi.ErrRequestTooLarge
	// errInvalidRequestBody 表示请求体为空或无法完整读取。
	errInvalidRequestBody = inferenceapi.ErrInvalidRequestBody
)

// readJSONBody 读取有界 JSON 请求体，不接受压缩或媒体类型猜测。
func readJSONBody(
	response http.ResponseWriter,
	request *http.Request,
	maxBodySize int64,
) ([]byte, error) {
	return inferenceapi.ReadJSONBody(response, request, maxBodySize)
}
