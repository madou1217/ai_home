package inferenceapi

import (
	"errors"
	"net/http"
)

// DecodeRejectedHeader 标记协议解码拒收的 4xx 响应。
//
// 解码发生在选账号和请求上游之前，因此带该标记的请求没有任何副作用；前置宿主可以
// 据此把同一请求原样交给能处理该线协议形状的实现，而其它失败一律不得重放。
const DecodeRejectedHeader = "X-AIH-Decode-Rejected"

// MarkDecodeRejected 在写出错误响应前标记本次拒收只发生在协议解码阶段。
func MarkDecodeRejected(response http.ResponseWriter) {
	response.Header().Set(DecodeRejectedHeader, "1")
}

// IsUnsupportedRequestBodyShape 报告请求体边界错误是否属于「Go 不支持这种请求形状」。
//
// 媒体类型或内容编码不受支持时，请求体尚未解码，也没有联系上游或选账号，因此这类
// 失败可以带上 DecodeRejectedHeader 交还前置宿主重放（例如 Node 支持 /v1/responses
// 的 gzip/zstd，而 Go 的 Canonical 路径不支持）。
func IsUnsupportedRequestBodyShape(err error) bool {
	return errors.Is(err, ErrInvalidContentType) ||
		errors.Is(err, ErrUnsupportedContentEncoding)
}
