package codebuddyfamilyrelay

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// fakeCredentials 只满足构造依赖；契约不满足时 Handler 不应碰凭据。
type fakeCredentials struct{ calls int }

func (fake *fakeCredentials) ResolveObservedCredentialBinding(
	context.Context,
	accountcore.AccountRef,
) (accounts.CredentialBinding, accountcredentials.CredentialObservation, error) {
	fake.calls++
	return accounts.CredentialBinding{}, accountcredentials.CredentialObservation{}, errors.New("unused")
}

func (fake *fakeCredentials) IsCurrentCredentialObservation(
	context.Context,
	accountcredentials.CredentialObservation,
) (bool, error) {
	return false, nil
}

type fakeAttempts struct{}

func (fakeAttempts) RecordSuccess(context.Context, runtimecore.ModelRoute, inferencegateway.AttemptSuccess) error {
	return nil
}

func (fakeAttempts) RecordFailure(context.Context, runtimecore.ModelRoute, inferencegateway.AttemptFailure) error {
	return nil
}

type fakeClient struct{}

func (fakeClient) Do(*http.Request) (*http.Response, error) {
	return nil, errors.New("unused")
}

// fallbackRecorder 记录被交回的请求体，并返回固定状态。
type fallbackRecorder struct {
	calls int
	body  string
}

func (fallback *fallbackRecorder) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	fallback.calls++
	raw, _ := io.ReadAll(request.Body)
	fallback.body = string(raw)
	writer.WriteHeader(http.StatusTeapot)
}

func newTestFamilyHandler(t *testing.T, fallback http.Handler) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Fallback:    fallback,
		Credentials: &fakeCredentials{},
		Client:      fakeClient{},
		Attempts:    fakeAttempts{},
		Clock:       func() time.Time { return time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// TestHandlerRequiresCredentials 验证默认失败关闭：缺依赖直接拒绝构造。
func TestHandlerRequiresCredentials(t *testing.T) {
	if _, err := NewHandler(Dependencies{
		Client:   fakeClient{},
		Attempts: fakeAttempts{},
		Clock:    func() time.Time { return time.Now() },
	}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v, want ErrInvalidDependencies", err)
	}
}

// TestNilHandlerReturns503 验证零值 Handler 不会 panic。
func TestNilHandlerReturns503(t *testing.T) {
	var handler *Handler
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader("{}")))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "relay_unavailable") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

// TestHandlerDelegatesContractMisses 验证方法/路径/正文不符合透传契约时交回 Canonical，
// 且请求体被原样重放。
func TestHandlerDelegatesContractMisses(t *testing.T) {
	body := `{"model":"claude-sonnet-4-5","messages":[{"role":"system","content":"s"},{"role":"user","content":"hi"}],"stream":true}`
	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{name: "wrong method", method: http.MethodGet, path: Path, body: ""},
		{name: "wrong path", method: http.MethodPost, path: "/v1/responses", body: body},
		{name: "invalid json", method: http.MethodPost, path: Path, body: "not-json"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fallback := &fallbackRecorder{}
			handler := newTestFamilyHandler(t, fallback)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(
				recorder,
				httptest.NewRequest(testCase.method, testCase.path, strings.NewReader(testCase.body)),
			)
			if fallback.calls != 1 {
				t.Fatalf("fallback calls = %d, want 1", fallback.calls)
			}
			if recorder.Code != http.StatusTeapot {
				t.Fatalf("status = %d, want fallback status 418", recorder.Code)
			}
			if fallback.body != testCase.body {
				t.Fatalf("fallback body = %q, want %q", fallback.body, testCase.body)
			}
		})
	}
}

// TestHandlerDelegatesWhenNoRelayAccounts 验证有效请求但没有任何可透传账号时交回 Canonical。
func TestHandlerDelegatesWhenNoRelayAccounts(t *testing.T) {
	body := `{"model":"claude-sonnet-4-5","messages":[{"role":"system","content":"s"},{"role":"user","content":"hi"}],"stream":true}`
	fallback := &fallbackRecorder{}
	handler := newTestFamilyHandler(t, fallback)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body)),
	)
	if fallback.calls != 1 {
		t.Fatalf("fallback calls = %d, want 1", fallback.calls)
	}
	if fallback.body != body {
		t.Fatalf("fallback body 被改写: %q", fallback.body)
	}
}
