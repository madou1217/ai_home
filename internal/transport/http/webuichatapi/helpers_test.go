package webuichatapi

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"testing"
)

// intToString 只用于把序号拼成字符串，避免测试里到处出现 fmt。
func intToString(value int) string { return strconv.Itoa(value) }

// jsonUnmarshal 是断言用的字符串解码入口。
func jsonUnmarshal(document string, target any) error {
	return json.Unmarshal([]byte(document), target)
}

// decodeRouteError 读出 JSON 错误体。
func decodeRouteError(t *testing.T, recorder *httptest.ResponseRecorder) routeErrorBody {
	t.Helper()
	body := routeErrorBody{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("错误体解码失败: %v (%s)", err, recorder.Body.String())
	}
	return body
}
