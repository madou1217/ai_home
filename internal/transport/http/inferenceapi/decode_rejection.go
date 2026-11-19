package inferenceapi

import (
	"errors"
	"net/http"
)

// DecodeRejectedHeader 标记协议解码拒收的 4xx 响应。
//
// 解码发生在选账号和请求上游之前，因此带该标记的请求没有任何副作用。前置宿主据此
// 区分「请求形状不被本入口支持」和真实的上游失败；只有前者才可能启用字段级兼容，
// 后者一律不得重试。
const DecodeRejectedHeader = "X-AIH-Decode-Rejected"

// MarkDecodeRejected 在写出错误响应前标记本次拒收只发生在协议解码阶段。
func MarkDecodeRejected(response http.ResponseWriter) {
	response.Header().Set(DecodeRejectedHeader, "1")
}

// IsUnsupportedRequestBodyShape 报告请求体边界错误是否属于「Go 不支持这种请求形状」。
//
// 媒体类型或内容编码不受支持时，请求体尚未解码，也没有联系上游或选账号，因此可以
// 带上 DecodeRejectedHeader 让前置宿主识别这类失败（例如 /v1/responses 的
// gzip/zstd 归一化）。
func IsUnsupportedRequestBodyShape(err error) bool {
	return errors.Is(err, ErrInvalidContentType) ||
		errors.Is(err, ErrUnsupportedContentEncoding)
}
