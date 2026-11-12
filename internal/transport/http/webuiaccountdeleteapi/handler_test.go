package webuiaccountdeleteapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type allowAuthorizer struct{}

func (allowAuthorizer) Authorized(*http.Request) bool { return true }

type denyAuthorizer struct{}

func (denyAuthorizer) Authorized(*http.Request) bool { return false }

// fakeDeletion 记录入参并按配置返回结果。
type fakeDeletion struct {
	outcome   accountapp.DeletionOutcome
	err       error
	calls     int
	lastForce bool
}

func (deletion *fakeDeletion) DeleteAccountWithOptions(
	_ context.Context,
	_ accountcore.AccountRef,
	options accountapp.DeletionOptions,
) (accountapp.DeletionOutcome, error) {
	deletion.calls++
	deletion.lastForce = options.Force
	return deletion.outcome, deletion.err
}

func newTestHandler(t *testing.T, deletion AccountDeletion) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: allowAuthorizer{}, Deletion: deletion})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

const testAccountRef = "acct_0123456789abcdef0123"

func serve(t *testing.T, handler http.Handler, method string, target string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

// TestDeleteWritesOutcomeWithNodeShape 守住响应形状与 Node 删除路由一致。
func TestDeleteWritesOutcomeWithNodeShape(t *testing.T) {
	deletion := &fakeDeletion{outcome: accountapp.DeletionOutcome{
		ServerDefault:   accountapp.ServerDefaultLanding{OK: true, Landed: false, Reason: "no_default_change"},
		HostGrantRevoke: &accountapp.GrantRevocation{OK: true, Revoked: false, Reason: "no_host_grant"},
	}}
	recorder := serve(t, newTestHandler(t, deletion), http.MethodDelete, Path+"/"+testAccountRef)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["ok"] != true {
		t.Fatalf("payload = %v", payload)
	}
	landing, _ := payload["aihServerDefault"].(map[string]any)
	if landing["reason"] != "no_default_change" {
		t.Fatalf("aihServerDefault = %v", landing)
	}
	grant, _ := payload["hostGrantRevoke"].(map[string]any)
	if grant["revoked"] != false {
		t.Fatalf("hostGrantRevoke = %v", grant)
	}
}

// TestDeleteOmitsHostGrantWhenProviderHasNoHook 守住「Node 返回 null」那一档：
// 没有宿主授权钩子的 Provider 不能凭空多出一个空对象。
func TestDeleteOmitsHostGrantWhenProviderHasNoHook(t *testing.T) {
	recorder := serve(t, newTestHandler(t, &fakeDeletion{}), http.MethodDelete, Path+"/"+testAccountRef)
	payload := decodeBody(t, recorder)
	if _, found := payload["hostGrantRevoke"]; found {
		t.Fatalf("payload = %v", payload)
	}
}

// TestDeletePassesForceThrough 守住 force 的解析：1/true 才算强制删除。
func TestDeletePassesForceThrough(t *testing.T) {
	cases := []struct {
		query string
		want  bool
	}{
		{query: "", want: false},
		{query: "?force=1", want: true},
		{query: "?force=true", want: true},
		{query: "?force=TRUE", want: true},
		{query: "?force=0", want: false},
	}
	for _, test := range cases {
		deletion := &fakeDeletion{}
		recorder := serve(t, newTestHandler(t, deletion), http.MethodDelete, Path+"/"+testAccountRef+test.query)
		if recorder.Code != http.StatusOK {
			t.Fatalf("query %q status = %d", test.query, recorder.Code)
		}
		if deletion.lastForce != test.want {
			t.Fatalf("query %q force = %v, want %v", test.query, deletion.lastForce, test.want)
		}
	}
}

// TestDeleteRejectsUnknownForceValue 守住拼错的参数不被当成「不强杀」。
func TestDeleteRejectsUnknownForceValue(t *testing.T) {
	recorder := serve(t, newTestHandler(t, &fakeDeletion{}), http.MethodDelete, Path+"/"+testAccountRef+"?force=yes")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", recorder.Code)
	}
}

// TestDeleteWritesOccupantsOnRuntimeActive 守住 409 的载荷：前端按 occupants 渲染
// 确认框，缺了它用户就只能看到一句没有信息量的提示。
func TestDeleteWritesOccupantsOnRuntimeActive(t *testing.T) {
	deletion := &fakeDeletion{err: &accountapp.RuntimeActiveError{Blockers: []accountapp.DeletionBlocker{
		{Kind: "persistent_session", Label: "挂起的持久会话（tmux）", Session: "s-main"},
		{Kind: "persistent_session", Label: "挂起的持久会话（tmux）", Session: "s-other"},
	}}}
	recorder := serve(t, newTestHandler(t, deletion), http.MethodDelete, Path+"/"+testAccountRef)

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["error"] != "account_runtime_active" {
		t.Fatalf("payload = %v", payload)
	}
	occupants, _ := payload["occupants"].([]any)
	if len(occupants) != 2 {
		t.Fatalf("occupants = %v", payload["occupants"])
	}
	message, _ := payload["message"].(string)
	if message != "该账号有 挂起的持久会话（tmux） 正在占用（s-main、s-other），删除会终止它们。" {
		t.Fatalf("message = %q", message)
	}
}

// TestDeleteMapsDomainErrorsToStatus 守住 404/503/502 的映射，避免统一压成 500。
func TestDeleteMapsDomainErrorsToStatus(t *testing.T) {
	cases := []struct {
		err        error
		wantStatus int
		wantCode   string
	}{
		{err: accountapp.ErrAccountNotFound, wantStatus: http.StatusNotFound, wantCode: "account_not_found"},
		{err: accountapp.ErrAccountRuntimeUnverifiable, wantStatus: http.StatusServiceUnavailable, wantCode: "account_runtime_unverifiable"},
		{err: accountapp.ErrAccountDeletionPreparationFailed, wantStatus: http.StatusServiceUnavailable, wantCode: "account_deletion_preparation_failed"},
		{err: accountapp.ErrAccountHostCleanupFailed, wantStatus: http.StatusServiceUnavailable, wantCode: "account_host_cleanup_failed"},
		{err: accountapp.ErrInvalidDeletionRequest, wantStatus: http.StatusBadRequest, wantCode: "invalid_account_delete_request"},
		{err: errors.New("boom"), wantStatus: http.StatusBadGateway, wantCode: "delete_account_failed"},
	}
	for _, test := range cases {
		recorder := serve(t, newTestHandler(t, &fakeDeletion{err: test.err}), http.MethodDelete, Path+"/"+testAccountRef)
		if recorder.Code != test.wantStatus {
			t.Fatalf("err %v status = %d, want %d", test.err, recorder.Code, test.wantStatus)
		}
		payload := decodeBody(t, recorder)
		if payload["error"] != test.wantCode {
			t.Fatalf("err %v payload = %v", test.err, payload)
		}
	}
}

// TestDeleteRejectsInvalidPathAndMethod 守住协议层的两条硬约束。
func TestDeleteRejectsInvalidPathAndMethod(t *testing.T) {
	handler := newTestHandler(t, &fakeDeletion{})
	if recorder := serve(t, handler, http.MethodDelete, Path+"/not-a-ref"); recorder.Code != http.StatusBadRequest {
		t.Fatalf("非法账号引用 status = %d", recorder.Code)
	}
	if recorder := serve(t, handler, http.MethodGet, Path+"/"+testAccountRef); recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("错误方法 status = %d", recorder.Code)
	}
}

// TestDeleteRequiresManagementKey 守住鉴权：删除是不可逆动作，不能被匿名调用。
func TestDeleteRequiresManagementKey(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: denyAuthorizer{}, Deletion: &fakeDeletion{}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	if recorder := serve(t, handler, http.MethodDelete, Path+"/"+testAccountRef); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}
}
