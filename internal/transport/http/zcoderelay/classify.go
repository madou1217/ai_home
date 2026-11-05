package zcoderelay

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// 上游的业务失败是 **HTTP 200 + JSON**（例如 {"code":1005,"msg":"exceed quota limit"}）。
// 不识别就会被当成模型答案；识别得太晚（记账之后）账号又会被记成健康。
// relaycore 在 recordSuccess 之前调用本方法，只对 JSON 响应嗅探。
func (*Provider) ClassifyBusinessFailure(
	statusCode int,
	header http.Header,
	body []byte,
) (sharedfailure.Classification, bool) {
	if statusCode < 200 || statusCode >= 300 {
		return sharedfailure.Classification{}, false
	}
	failure, ok := detectBusinessFailure(body)
	if !ok {
		return sharedfailure.Classification{}, false
	}
	kind := runtimecore.FailureUpstreamUnavailable
	if failure.Quota {
		kind = runtimecore.FailureQuotaExhausted
	}
	var classification sharedfailure.Classification
	var err error
	if kind == runtimecore.FailureQuotaExhausted {
		// 额度耗尽必须显式声明作用域（账号级），否则分类构造会拒绝。
		classification, err = sharedfailure.NewBlockingClassification(kind, runtimecore.BlockScopeAccount)
	} else {
		classification, err = sharedfailure.NewClassification(kind, 0)
	}
	if err != nil {
		return sharedfailure.Classification{}, false
	}
	return classification, true
}

type businessFailure struct {
	Code    string
	Message string
	Quota   bool
}

// detectBusinessFailure 只认「JSON 对象 + 数字 code + 字符串 msg，且没有 chat 结果字段」。
func detectBusinessFailure(body []byte) (businessFailure, bool) {
	trimmed := strings.TrimSpace(string(body))
	if !strings.HasPrefix(trimmed, "{") {
		return businessFailure{}, false
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
		return businessFailure{}, false
	}
	if _, ok := document["choices"]; ok {
		return businessFailure{}, false
	}
	if _, ok := document["content"]; ok {
		return businessFailure{}, false
	}
	code, ok := document["code"]
	if !ok {
		return businessFailure{}, false
	}
	message := ""
	if text, ok := document["msg"].(string); ok {
		message = strings.TrimSpace(text)
	} else if text, ok := document["message"].(string); ok {
		message = strings.TrimSpace(text)
	}
	if message == "" {
		return businessFailure{}, false
	}
	codeText := fmt.Sprint(code)
	lower := strings.ToLower(message)
	quota := codeText == "1005" || strings.Contains(lower, "quota") || strings.Contains(lower, "limit")
	return businessFailure{Code: codeText, Message: message, Quota: quota}, true
}
