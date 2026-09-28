package inferenceapi

import "net/http"

// DecodeRejectedHeader 标记协议解码拒收的 4xx 响应。
//
// 解码发生在选账号和请求上游之前，因此带该标记的请求没有任何副作用；前置宿主可以
// 据此把同一请求原样交给能处理该线协议形状的实现，而其它失败一律不得重放。
const DecodeRejectedHeader = "X-AIH-Decode-Rejected"

// MarkDecodeRejected 在写出错误响应前标记本次拒收只发生在协议解码阶段。
func MarkDecodeRejected(response http.ResponseWriter) {
	response.Header().Set(DecodeRejectedHeader, "1")
}
