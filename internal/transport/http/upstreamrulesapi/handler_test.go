package upstreamrulesapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
)

// staticAuthorizer 只接受携带指定 Bearer 的请求，模拟管理面鉴权器。
type staticAuthorizer struct{ key string }

func (authorizer staticAuthorizer) Authorized(request *http.Request) bool {
	return strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ") == authorizer.key
}

type harness struct {
	handler *Handler
	store   *rulesapp.Store
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	store, err := rulesapp.NewStore(rulesapp.Options{SupportedProviders: []string{"codex"}})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: staticAuthorizer{key: "management-key"},
		Store:      store,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return &harness{handler: handler, store: store}
}

func (current *harness) do(t *testing.T, method string, body string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(method, Path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer management-key")
	response := httptest.NewRecorder()
	current.handler.ServeHTTP(response, request)
	return response
}

func decodeView(t *testing.T, response *httptest.ResponseRecorder) rulesView {
	t.Helper()

	var payload struct {
		Data rulesView `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解码响应失败: %v (%s)", err, response.Body.String())
	}
	return payload.Data
}

// projection 是一条命中额度耗尽的账号投影正文。
const projection = `{"accounts":[{"account_ref":"codex:acct-1","provider":"codex","rules":[
  {
    "name": "额度耗尽",
    "kind": "quota_exhausted",
    "enabled": true,
    "statuses": [429],
    "matchers": [{"source": "body", "operator": "contains", "value": "INSUFFICIENT_BALANCE"}]
  }
]}]}`

// TestPushReportsAcceptedAccounts 锁定推送握手：Node 只依据 accepted_account_refs
// 决定是否把该账号的请求交还自己处理。
func TestPushReportsAcceptedAccounts(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	response := current.do(t, http.MethodPut, projection)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	view := decodeView(t, response)
	if view.Generation != 1 {
		t.Fatalf("generation = %d, want 1", view.Generation)
	}
	if len(view.AcceptedAccountRefs) != 1 || view.AcceptedAccountRefs[0] != "codex:acct-1" {
		t.Fatalf("accepted = %#v", view.AcceptedAccountRefs)
	}
	if len(view.Dropped) != 0 {
		t.Fatalf("dropped = %#v", view.Dropped)
	}
	if len(view.SupportedProviders) != 1 || view.SupportedProviders[0] != "codex" {
		t.Fatalf("supported = %#v", view.SupportedProviders)
	}
	if _, ok := current.store.RulesFor("codex:acct-1"); !ok {
		t.Fatal("推送后投影里没有该账号")
	}
}

// TestPushReportsDroppedAccounts 验证未接入的 Provider 会被显式丢弃，
// 而不是静默接受后按无规则处理（那会丢掉账号的异常语义）。
func TestPushReportsDroppedAccounts(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	body := `{"accounts":[
	  {"account_ref":"claude:acct-2","provider":"claude","rules":[]},
	  {"account_ref":"codex:acct-1","provider":"codex","rules":[]}
	]}`
	view := decodeView(t, current.do(t, http.MethodPut, body))
	if len(view.AcceptedAccountRefs) != 1 || view.AcceptedAccountRefs[0] != "codex:acct-1" {
		t.Fatalf("accepted = %#v", view.AcceptedAccountRefs)
	}
	if len(view.Dropped) != 1 ||
		view.Dropped[0].AccountRef != "claude:acct-2" ||
		view.Dropped[0].Reason != rulesapp.DropProviderNotSupported {
		t.Fatalf("dropped = %#v", view.Dropped)
	}
}

// TestPushRejectsInvalidProjection 验证非法投影整体拒绝且不污染已生效投影。
func TestPushRejectsInvalidProjection(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	if response := current.do(t, http.MethodPut, projection); response.Code != http.StatusOK {
		t.Fatalf("首次推送 status = %d", response.Code)
	}
	broken := current.do(t, http.MethodPut, `{"accounts":[{"account_ref":"","provider":"codex","rules":[]}]}`)
	if broken.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", broken.Code)
	}
	unknown := current.do(t, http.MethodPut, `{"accounts":[{"account_ref":"codex:acct-1","provider":"codex","rules":[],"extra":1}]}`)
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("未知字段 status = %d, want 400", unknown.Code)
	}
	if current.store.Generation() != 1 {
		t.Fatalf("非法推送改变了投影代次: %d", current.store.Generation())
	}
}

// TestGetReportsStoredProjection 验证只读诊断返回已存储的规则内容。
func TestGetReportsStoredProjection(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	current.do(t, http.MethodPut, projection)
	view := decodeView(t, current.do(t, http.MethodGet, ""))
	if view.Generation != 1 || len(view.Accounts) != 1 {
		t.Fatalf("view = %#v", view)
	}
	if view.Accounts[0].AccountRef != "codex:acct-1" || len(view.Accounts[0].Rules) != 1 {
		t.Fatalf("accounts = %#v", view.Accounts)
	}
}

// TestEndpointRequiresManagementKey 验证规则投影不会变成无鉴权写入口。
func TestEndpointRequiresManagementKey(t *testing.T) {
	t.Parallel()

	current := newHarness(t)
	request := httptest.NewRequest(http.MethodPut, Path, strings.NewReader(projection))
	response := httptest.NewRecorder()
	current.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if current.store.Generation() != 0 {
		t.Fatal("未鉴权的推送改动了投影")
	}
	method := httptest.NewRequest(http.MethodDelete, Path, nil)
	method.Header.Set("Authorization", "Bearer management-key")
	rejected := httptest.NewRecorder()
	current.handler.ServeHTTP(rejected, method)
	if rejected.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rejected.Code)
	}
}

// TestNewHandlerFailsClosedWithoutDependencies 验证缺少存储或鉴权时不装配端点。
func TestNewHandlerFailsClosedWithoutDependencies(t *testing.T) {
	t.Parallel()

	store, err := rulesapp.NewStore(rulesapp.Options{})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := NewHandler(Dependencies{Store: store}); err == nil {
		t.Fatal("缺少鉴权器仍创建了端点")
	}
	if _, err := NewHandler(Dependencies{Authorizer: staticAuthorizer{}}); err == nil {
		t.Fatal("缺少投影存储仍创建了端点")
	}
}
