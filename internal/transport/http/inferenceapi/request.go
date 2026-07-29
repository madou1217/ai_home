// Package inferenceapi 提供推理 HTTP 入站适配器共享的有界请求和 SSE 传输原语。
package inferenceapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

var (
	// ErrInvalidContentType 表示推理请求未使用 JSON 媒体类型。
	ErrInvalidContentType = errors.New("推理请求媒体类型无效")
	// ErrUnsupportedContentEncoding 表示请求体使用了未审计的压缩编码。
	ErrUnsupportedContentEncoding = errors.New("推理请求内容编码不受支持")
	// ErrRequestTooLarge 表示请求体超过显式内存上限。
	ErrRequestTooLarge = errors.New("推理请求体过大")
	// ErrInvalidRequestBody 表示请求体为空或无法完整读取。
	ErrInvalidRequestBody = errors.New("推理请求体无效")
)

// ReadJSONBody 读取有界 JSON 请求体，不接受压缩或媒体类型猜测。
func ReadJSONBody(
	response http.ResponseWriter,
	request *http.Request,
	maxBodySize int64,
) ([]byte, error) {
	if response == nil || request == nil || request.Body == nil || maxBodySize < 1 {
		return nil, ErrInvalidRequestBody
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return nil, ErrInvalidContentType
	}
	contentEncoding := strings.TrimSpace(request.Header.Get("Content-Encoding"))
	if contentEncoding != "" && !strings.EqualFold(contentEncoding, "identity") {
		return nil, ErrUnsupportedContentEncoding
	}
	if request.ContentLength > maxBodySize {
		return nil, ErrRequestTooLarge
	}
	limitedBody := http.MaxBytesReader(response, request.Body, maxBodySize)
	body, err := io.ReadAll(limitedBody)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return nil, ErrRequestTooLarge
		}
		return nil, ErrInvalidRequestBody
	}
	if len(body) == 0 {
		return nil, ErrInvalidRequestBody
	}
	if err := httpjson.ValidateDocument(body); err != nil {
		return nil, ErrInvalidRequestBody
	}
	return body, nil
}
