package anthropicmessagesapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
)

var (
	// errInvalidContentType 表示请求未使用 JSON 媒体类型。
	errInvalidContentType = errors.New("Messages 请求媒体类型无效")
	// errUnsupportedContentEncoding 表示请求体使用了未审计的压缩编码。
	errUnsupportedContentEncoding = errors.New("Messages 请求内容编码不受支持")
	// errRequestTooLarge 表示请求体超过显式内存上限。
	errRequestTooLarge = errors.New("Messages 请求体过大")
	// errInvalidRequestBody 表示请求体为空或无法完整读取。
	errInvalidRequestBody = errors.New("Messages 请求体无效")
)

// readJSONBody 读取有界 JSON 请求体，不接受压缩或媒体类型猜测。
func readJSONBody(
	response http.ResponseWriter,
	request *http.Request,
	maxBodySize int64,
) ([]byte, error) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return nil, errInvalidContentType
	}
	contentEncoding := strings.TrimSpace(request.Header.Get("Content-Encoding"))
	if contentEncoding != "" && !strings.EqualFold(contentEncoding, "identity") {
		return nil, errUnsupportedContentEncoding
	}
	if request.ContentLength > maxBodySize {
		return nil, errRequestTooLarge
	}
	limitedBody := http.MaxBytesReader(response, request.Body, maxBodySize)
	body, err := io.ReadAll(limitedBody)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return nil, errRequestTooLarge
		}
		return nil, errInvalidRequestBody
	}
	if len(body) == 0 {
		return nil, errInvalidRequestBody
	}
	return body, nil
}
