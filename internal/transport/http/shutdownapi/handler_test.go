package shutdownapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// staticAuthorizer 只接受携带指定 Bearer 的请求，模拟管理面鉴权器。
type staticAuthorizer struct{ key string }

func (authorizer staticAuthorizer) Authorized(request *http.Request) bool {
	return strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ") == authorizer.key
}

func newTestHandler(t *testing.T, called chan struct{}) *Handler {
	t.Helper()

	handler, err := NewHandler(Dependencies{
		Authorizer: staticAuthorizer{key: "management-key"},
		RequestShutdown: func() {
			if called != nil {
				close(called)
			}
		},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func waitForShutdown(t *testing.T, called chan struct{}) {
	t.Helper()

	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("优雅退出没有被触发")
	}
}

// TestShutdownAcceptsAnAuthorizedPostAndAcknowledgesBeforeExiting 锁定调用方依赖的顺序：
// 宿主必须先拿到 202 再看到进程退出，否则它会把正常退出读成端点不可用而退回强杀。
func TestShutdownAcceptsAnAuthorizedPostAndAcknowledgesBeforeExiting(t *testing.T) {
	t.Parallel()

	called := make(chan struct{})
	handler := newTestHandler(t, called)
	request := httptest.NewRequest(http.MethodPost, Path, nil)
	request.Header.Set("Authorization", "Bearer management-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", response.Code)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	if !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("body = %s", response.Body.String())
	}
	waitForShutdown(t, called)
}

// TestShutdownRejectsUnauthorizedAndWrongMethod 验证关闭端点不会变成无鉴权的进程杀手。
func TestShutdownRejectsUnauthorizedAndWrongMethod(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		method  string
		headers map[string]string
		status  int
	}{
		{name: "no key", method: http.MethodPost, status: http.StatusUnauthorized},
		{name: "wrong key", method: http.MethodPost, headers: map[string]string{"Authorization": "Bearer nope"}, status: http.StatusUnauthorized},
		{name: "get", method: http.MethodGet, headers: map[string]string{"Authorization": "Bearer management-key"}, status: http.StatusMethodNotAllowed},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			called := make(chan struct{})
			handler := newTestHandler(t, called)
			request := httptest.NewRequest(testCase.method, Path, nil)
			for name, value := range testCase.headers {
				request.Header.Set(name, value)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != testCase.status {
				t.Fatalf("status = %d, want %d", response.Code, testCase.status)
			}
			select {
			case <-called:
				t.Fatal("被拒绝的请求触发了退出")
			case <-time.After(50 * time.Millisecond):
			}
		})
	}
}

// TestNewHandlerFailsClosedWithoutDependencies 验证缺少鉴权器或退出回调时不装配端点。
func TestNewHandlerFailsClosedWithoutDependencies(t *testing.T) {
	t.Parallel()

	if _, err := NewHandler(Dependencies{RequestShutdown: func() {}}); err == nil {
		t.Fatal("缺少鉴权器仍创建了关闭端点")
	}
	if _, err := NewHandler(Dependencies{Authorizer: staticAuthorizer{}}); err == nil {
		t.Fatal("缺少退出回调仍创建了关闭端点")
	}
}
