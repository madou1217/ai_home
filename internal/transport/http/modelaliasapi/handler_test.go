package modelaliasapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/modelalias"
)

// staticAuthorizer 只接受携带指定 Bearer 的请求，模拟管理面鉴权器。
type staticAuthorizer struct{ key string }

func (authorizer staticAuthorizer) Authorized(request *http.Request) bool {
	return strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ") == authorizer.key
}

type harness struct {
	handler     *Handler
	store       *modelalias.Store
	refreshes   int
	compilation inferencecatalog.AliasCompilation
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	current := &harness{store: modelalias.NewStore()}
	handler, err := NewHandler(Dependencies{
		Authorizer: staticAuthorizer{key: "management-key"},
		Store:      current.store,
		Refresh: func(context.Context) error {
			current.refreshes++
			// 模拟目录重建：把当前投影代次与已接受别名暴露出去。
			current.compilation = inferencecatalog.AliasCompilation{
				Generation:  current.store.Generation(),
				AcceptedIDs: []string{"a1"},
				Dropped: []inferencecatalog.AliasDrop{
					{ID: "a2", Alias: "gemini-best", Reason: inferencecatalog.AliasDropScopeUnsupported},
				},
			}
			return nil
		},
		Compilation: func() inferencecatalog.AliasCompilation { return current.compilation },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	current.handler = handler
	return current
}

func (current *harness) do(t *testing.T, method string, body string) *httptest.ResponseRecorder {
	t.Helper()

	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, Path, reader)
	request.Header.Set("Authorization", "Bearer management-key")
	response := httptest.NewRecorder()
	current.handler.ServeHTTP(response, request)
	return response
}

func decodeView(t *testing.T, response *httptest.ResponseRecorder) aliasView {
	t.Helper()

	var payload struct {
		Data aliasView `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解码响应失败: %v (%s)", err, response.Body.String())
	}
	return payload.Data
}

// TestPushReplacesProjectionAndReportsAppliedGeneration 锁定 Node 依赖的握手：
// 推送后 applied_generation 必须追平 generation，否则 Node 会一直保守交还别名请求。
func TestPushReplacesProjectionAndReportsAppliedGeneration(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	response := current.do(t, http.MethodPut, `{"aliases":[{"id":"a1","alias":"best","target":"gpt-5.6-sol"}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	if current.refreshes != 1 {
		t.Fatalf("刷新次数 = %d, want 1", current.refreshes)
	}
	view := decodeView(t, response)
	if view.Generation != 1 || view.AppliedGeneration != 1 {
		t.Fatalf("generation=%d applied=%d", view.Generation, view.AppliedGeneration)
	}
	if len(view.AcceptedIDs) != 1 || view.AcceptedIDs[0] != "a1" {
		t.Fatalf("accepted_ids = %#v", view.AcceptedIDs)
	}
	if len(view.Dropped) != 1 || view.Dropped[0].Reason != inferencecatalog.AliasDropScopeUnsupported {
		t.Fatalf("dropped = %#v", view.Dropped)
	}
}

// TestPushRejectsInvalidProjectionWithoutRefreshing 验证非法投影不会污染已生效的目录。
func TestPushRejectsInvalidProjectionWithoutRefreshing(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	if response := current.do(t, http.MethodPut, `{"aliases":[{"id":"a1","alias":"best","target":"gpt-5.6-sol"}]}`); response.Code != http.StatusOK {
		t.Fatalf("首次推送 status = %d", response.Code)
	}
	invalid := current.do(t, http.MethodPut, `{"aliases":[{"id":"a2","alias":"broken"}]}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", invalid.Code)
	}
	if current.refreshes != 1 {
		t.Fatalf("非法推送触发了刷新: %d", current.refreshes)
	}
	if current.store.Generation() != 1 {
		t.Fatalf("非法推送改变了投影代次: %d", current.store.Generation())
	}
}

// TestEndpointRequiresManagementKey 验证别名投影不会变成无鉴权写入口。
func TestEndpointRequiresManagementKey(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	request := httptest.NewRequest(http.MethodPut, Path, strings.NewReader(`{"aliases":[]}`))
	response := httptest.NewRecorder()
	current.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if current.store.Generation() != 0 {
		t.Fatal("未鉴权的推送改动了投影")
	}
}

// TestGetReportsStoredProjection 验证只读诊断返回已存储代次与已应用代次。
func TestGetReportsStoredProjection(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	current.do(t, http.MethodPut, `{"aliases":[{"id":"a1","alias":"best","target":"gpt-5.6-sol"}]}`)
	view := decodeView(t, current.do(t, http.MethodGet, ""))
	if view.Generation != 1 || view.AppliedGeneration != 1 {
		t.Fatalf("view = %#v", view)
	}
}

// TestNewHandlerFailsClosedWithoutDependencies 验证缺少存储或鉴权时不装配端点。
func TestNewHandlerFailsClosedWithoutDependencies(t *testing.T) {
	t.Parallel()

	if _, err := NewHandler(Dependencies{Store: modelalias.NewStore()}); err == nil {
		t.Fatal("缺少鉴权器仍创建了端点")
	}
	if _, err := NewHandler(Dependencies{Authorizer: staticAuthorizer{}}); err == nil {
		t.Fatal("缺少投影存储仍创建了端点")
	}
}
