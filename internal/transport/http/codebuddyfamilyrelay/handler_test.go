package codebuddyfamilyrelay

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// recordingFallback 记录「请求被交回 Canonical」，并断言正文被完整重放。
type recordingFallback struct {
	called bool
	body   string
}

func (fallback *recordingFallback) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	fallback.called = true
	if request.Body != nil {
		payload, _ := io.ReadAll(request.Body)
		fallback.body = string(payload)
	}
	response.WriteHeader(http.StatusTeapot)
}

// failingCredentials 是「读不到家族凭据」的解析器：交还 Canonical 的触发条件之一。
type failingCredentials struct{}

func (failingCredentials) ResolveObservedCredentialBinding(
	context.Context,
	accountcore.AccountRef,
) (accountapp.CredentialBinding, accountcredentials.CredentialObservation, error) {
	return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, errors.New("no credential")
}

func (failingCredentials) IsCurrentCredentialObservation(
	context.Context,
	accountcredentials.CredentialObservation,
) (bool, error) {
	return false, nil
}

// stubAttempts 满足 AttemptRecorder（本文件只走交还路径，不会真正记账）。
type stubAttempts struct{}

func (stubAttempts) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
	inferencegateway.AttemptSuccess,
) error {
	return nil
}

func (stubAttempts) RecordFailure(
	context.Context,
	runtimecore.ModelRoute,
	inferencegateway.AttemptFailure,
) error {
	return nil
}

// stubAccounts 是「该模型没有家族账号」的账号源。
type stubAccounts struct{}

func (stubAccounts) Accounts(context.Context, runtimecore.ModelID) (AccountCursor, error) {
	return nil, errNoRelayAccount
}

func newTestHandler(t *testing.T, fallback http.Handler) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Accounts:    stubAccounts{},
		Fallback:    fallback,
		Credentials: failingCredentials{},
		Client:      http.DefaultClient,
		Attempts:    stubAttempts{},
		Clock:       func() time.Time { return time.Unix(1792025000, 0) },
	})
	if err != nil {
		t.Fatalf("装配失败: %v", err)
	}
	return handler
}

func TestNewHandlerRequiresDependencies(t *testing.T) {
	cases := map[string]Dependencies{
		"缺凭据":  {Client: http.DefaultClient, Attempts: stubAttempts{}, Clock: time.Now},
		"缺客户端": {Credentials: failingCredentials{}, Attempts: stubAttempts{}, Clock: time.Now},
		"缺记账":  {Credentials: failingCredentials{}, Client: http.DefaultClient, Clock: time.Now},
		"缺时钟":  {Credentials: failingCredentials{}, Client: http.DefaultClient, Attempts: stubAttempts{}},
	}
	for name, dependencies := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewHandler(dependencies); !errors.Is(err, ErrInvalidDependencies) {
				t.Fatalf("应返回 ErrInvalidDependencies，实际 %v", err)
			}
		})
	}
}

func TestRelayContractSatisfied(t *testing.T) {
	cases := []struct {
		name        string
		method      string
		path        string
		contentType string
		body        string
		expect      bool
	}{
		{"正常 chat completions", http.MethodPost, Path, "application/json", `{"model":"m"}`, true},
		{"缺 content-type 也接受", http.MethodPost, Path, "", `{"model":"m"}`, true},
		{"非 POST 交回", http.MethodGet, Path, "application/json", `{"model":"m"}`, false},
		{"别的路径交回", http.MethodPost, "/v1/messages", "application/json", `{"model":"m"}`, false},
		{"非 JSON 交回", http.MethodPost, Path, "text/plain", `model=m`, false},
		{"空正文交回", http.MethodPost, Path, "application/json", "", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(
				testCase.method,
				testCase.path,
				strings.NewReader(testCase.body),
			)
			if testCase.contentType != "" {
				request.Header.Set("Content-Type", testCase.contentType)
			}
			if got := relayContractSatisfied(request); got != testCase.expect {
				t.Fatalf("relayContractSatisfied = %v，期望 %v", got, testCase.expect)
			}
		})
	}
	if relayContractSatisfied(nil) {
		t.Fatal("nil 请求必须交回")
	}
}

// 不满足合同 / 无家族账号 / 读不到凭据 → 一律交回 Canonical，且**正文被完整重放**。
func TestServeHTTPHandsBackToCanonical(t *testing.T) {
	const body = `{"model":"hy4-preview","messages":[{"role":"user","content":"hi"}]}`
	cases := []struct {
		name        string
		method      string
		path        string
		contentType string
		body        string
		pinned      string
	}{
		{"非 JSON 合同", http.MethodPost, Path, "text/plain", body, ""},
		{"缺少 model", http.MethodPost, Path, "application/json", `{"messages":[]}`, ""},
		{"该模型没有家族账号", http.MethodPost, Path, "application/json", body, ""},
		{"钉选账号不是家族（读不到凭据）", http.MethodPost, Path, "application/json", body, "acct_0123456789abcdef0123"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fallback := &recordingFallback{}
			handler := newTestHandler(t, fallback)
			request := httptest.NewRequest(testCase.method, testCase.path, bytes.NewReader([]byte(testCase.body)))
			request.Header.Set("Content-Type", testCase.contentType)
			if testCase.pinned != "" {
				request.Header.Set("X-Account-Ref", testCase.pinned)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if !fallback.called {
				t.Fatal("应把请求交回 Canonical")
			}
			if fallback.body != testCase.body {
				t.Fatalf("交还时正文必须原样重放: %q", fallback.body)
			}
			if response.Code != http.StatusTeapot {
				t.Fatalf("应由 Canonical 决定响应，实际状态码 %d", response.Code)
			}
		})
	}
}

// 钉选头重复或非法时交回 Canonical（由它按协议返回 400），不得当成未钉选请求改派账号。
//
// 已知局限（不夸大这条测试的能力）：本用例断言的是「最终交回了 Canonical」，而在当前
// 测试替身下，即使非法钉选被错误地当成「未钉选」，凭据解析失败同样会走到交还——所以
// 单靠本用例**区分不出**这两条路径（负向对照实测：去掉 len(values) != 1 守卫不会让它变红）。
// 要真正区分，需要一条能成功的凭据替身（走完整 relay 路径），见文件末尾的待办。
func TestServeHTTPRejectsInvalidPin(t *testing.T) {
	cases := [][]string{
		{"not-a-ref"},
		{"acct_0123456789abcdef0123", "acct_bbbbbbbbbbbbbbbbbbbb"},
	}
	for _, values := range cases {
		fallback := &recordingFallback{}
		handler := newTestHandler(t, fallback)
		request := httptest.NewRequest(
			http.MethodPost,
			Path,
			strings.NewReader(`{"model":"hy4-preview"}`),
		)
		request.Header.Set("Content-Type", "application/json")
		for _, value := range values {
			request.Header.Add("X-Account-Ref", value)
		}
		handler.ServeHTTP(httptest.NewRecorder(), request)
		if !fallback.called {
			t.Fatalf("非法钉选 %v 应交回 Canonical", values)
		}
	}
}

// 待办（本文件尚未覆盖，需要在接线时补）：
//  1. 用一条**能成功的凭据替身**（原生凭据 + 有效 observation）走完整 relay 路径，
//     覆盖：补 system / stream 强制 / tool_choice 形态表 / 降级响应头 / 非流式聚合 /
//     流式逐字节透传 / 上游 4xx 的信封文案与换号重试。
//  2. 该替身就位后，TestServeHTTPRejectsInvalidPin 才能真正区分「非法钉选」与
//     「未钉选」两条路径（当前两者都因凭据不可用而交还）。
