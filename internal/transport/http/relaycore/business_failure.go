package relaycore

import (
	"net/http"

	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// BusinessFailureClassifier 识别「HTTP 2xx 但业务失败」的响应。
//
// 为什么需要它：有些上游用 200 + 业务错误体表达拒绝（zcode: {"code":1005,"msg":...}）。
// 这类响应如果在**记账之后**才被发现，账号会被错误地记为成功；如果在交付阶段改写成
// 错误，客户端看到的是错误、但运行态仍认为账号健康。所以判定必须发生在 recordSuccess
// 之前，并且只对 JSON 响应做（SSE 成功流不能被读走）。
type BusinessFailureClassifier interface {
	// ClassifyBusinessFailure 返回 ok=true 表示这确实是业务失败。
	ClassifyBusinessFailure(
		statusCode int,
		header http.Header,
		body []byte,
	) (sharedfailure.Classification, bool)
}
