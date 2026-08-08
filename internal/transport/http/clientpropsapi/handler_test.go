package clientpropsapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestHandlerMatchesNodeGatewayShape 锁定与 Node 网关一致的响应形状。
//
// 两套实现同时在线期间，同一端点给出不同答案会让客户端行为随网关版本漂移；
// data 必须是显式空对象而非省略，客户端按该字段存在与否判断响应是否完整。
func TestHandlerMatchesNodeGatewayShape(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path, nil),
	)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v body = %s", err, recorder.Body.String())
	}
	object, found := payload["object"]
	if !found || string(object) != `"props"` {
		t.Fatalf("object = %s", object)
	}
	data, found := payload["data"]
	if !found || string(data) != "{}" {
		t.Fatalf("data = %s, want 显式空对象", data)
	}
}

// TestHandlerRejectsNonGet 验证只读端点拒绝写方法并声明 Allow。
func TestHandlerRejectsNonGet(t *testing.T) {
	t.Parallel()

	for _, method := range []string{
		http.MethodPost,
		http.MethodPut,
		http.MethodDelete,
	} {
		recorder := httptest.NewRecorder()
		NewHandler().ServeHTTP(
			recorder,
			httptest.NewRequest(method, Path, nil),
		)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d, want 405", method, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != http.MethodGet {
			t.Fatalf("%s Allow = %q", method, got)
		}
	}
}
