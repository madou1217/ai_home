package aihserver_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// waitForRealModelCatalog 等待注册提交后的异步模型刷新完成。
//
// 该轮询只访问临时 Go Server 的本地 /v1/models，不会再次访问 Provider
// 上游；因此不会把异步刷新误计为额外的真实目录请求，也不会扩大真实凭据
// 的网络预算。
func waitForRealModelCatalog(
	t *testing.T,
	client *http.Client,
	endpoint string,
) httpExchange {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last httpExchange
	for time.Now().Before(deadline) {
		last = performRequest(t, client, http.MethodGet, endpoint, testClientKey, nil)
		if last.status == http.StatusOK && hasRealModelCatalogEntries(last.body) {
			return last
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf(
		"等待真实异步模型目录超时: status=%d body_bytes=%d",
		last.status,
		len(last.body),
	)
	return last
}

// hasRealModelCatalogEntries 只判断目录是否有条目，不把上游响应正文写入失败日志。
func hasRealModelCatalogEntries(body string) bool {
	var document struct {
		Data []json.RawMessage `json:"data"`
	}
	return json.Unmarshal([]byte(body), &document) == nil && len(document.Data) > 0
}

// TestSelectRealCodexModelFromCatalog 证明真实 Codex 模型只能来自目录，且偏好模型不可用时安全降级。
func TestSelectRealCodexModelFromCatalog(t *testing.T) {
	t.Parallel()

	model, count := selectRealCodexModelFromCatalog(t, `{"object":"list","data":[{"id":"claude-opus-5"},{"id":"gpt-5.4"},{"id":"gpt-5.6-sol"}]}`)
	if model != "gpt-5.6-sol" || count != 3 {
		t.Fatalf("模型目录偏好选择错误: model=%q count=%d", model, count)
	}

	model, count = selectRealCodexModelFromCatalog(t, `{"object":"list","data":[{"id":"gpt-zeta"},{"id":"gpt-alpha"}]}`)
	if model != "gpt-alpha" || count != 2 {
		t.Fatalf("模型目录安全降级错误: model=%q count=%d", model, count)
	}
}

// TestSelectRealClaudeModelFromCatalog 证明 Claude reasoning 与普通请求共用已发现模型。
func TestSelectRealClaudeModelFromCatalog(t *testing.T) {
	t.Parallel()

	model, count := selectRealClaudeModelFromCatalog(t, `{"object":"list","data":[{"id":"claude-3-7-sonnet"},{"id":"claude-opus-5"}]}`)
	if model != "claude-opus-5" || count != 2 {
		t.Fatalf("Claude 模型目录偏好选择错误: model=%q count=%d", model, count)
	}

	model, count = selectRealClaudeModelFromCatalog(t, `{"object":"list","data":[{"id":"claude-zeta"},{"id":"gpt-5.6-sol"}]}`)
	if model != "claude-zeta" || count != 2 {
		t.Fatalf("Claude 模型目录安全降级错误: model=%q count=%d", model, count)
	}
}
