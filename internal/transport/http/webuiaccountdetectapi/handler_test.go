package webuiaccountdetectapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeDetector struct {
	status int
	body   string
	err    error
	calls  int
}

func (fake *fakeDetector) Detect(context.Context) (int, []byte, error) {
	fake.calls++
	if fake.err != nil {
		return 0, nil, fake.err
	}
	return fake.status, []byte(fake.body), nil
}

func TestDetectProxiesHostScanResult(t *testing.T) {
	detector := &fakeDetector{status: 200, body: `{"ok":true,"scanned":2,"updated":1}`}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Detector:   detector,
	})
	if err != nil {
		t.Fatalf("创建接口失败: %v", err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{}`))
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态 = %d, want 200", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"updated":1`) {
		t.Fatalf("响应体 = %s", recorder.Body.String())
	}
	if detector.calls != 1 {
		t.Fatalf("detector calls = %d", detector.calls)
	}
}

func TestDetectPreservesHostScanUnavailableStatus(t *testing.T) {
	detector := &fakeDetector{status: 500, body: `{"ok":false,"error":"detect_host_accounts_unavailable"}`}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Detector:   detector,
	})
	if err != nil {
		t.Fatalf("创建接口失败: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("状态 = %d, want 500", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "detect_host_accounts_unavailable") {
		t.Fatalf("响应体 = %s", recorder.Body.String())
	}
}

func TestDetectRejectsUnauthorizedAndWrongMethod(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: false}})
	if err != nil {
		t.Fatalf("创建接口失败: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("未授权状态 = %d, want 401", recorder.Code)
	}

	allowed, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}})
	if err != nil {
		t.Fatalf("创建接口失败: %v", err)
	}
	recorder = httptest.NewRecorder()
	allowed.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("错误方法状态 = %d, want 405", recorder.Code)
	}
}

func TestDetectFailsClosedWithoutDetector(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}})
	if err != nil {
		t.Fatalf("创建接口失败: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态 = %d, want 503", recorder.Code)
	}
}
