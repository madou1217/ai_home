package accountauthapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountauth"
)

const testJobID = "0123456789abcdef0123456789abcdef"

// TestHandlerRejectsUnauthorizedAndInvalidRequests 验证 OAuth Job API 在进入应用层前失败关闭。
func TestHandlerRejectsUnauthorizedAndInvalidRequests(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		authorized bool
		method     string
		path       string
		body       string
		status     int
		code       string
	}{
		{
			name:       "缺少管理鉴权",
			authorized: false,
			method:     http.MethodPost,
			path:       CollectionPath,
			body:       `{"provider_id":"codex"}`,
			status:     http.StatusUnauthorized,
			code:       "unauthorized",
		},
		{
			name:       "不支持的 Provider",
			authorized: true,
			method:     http.MethodPost,
			path:       CollectionPath,
			body:       `{"provider_id":"gemini"}`,
			status:     http.StatusUnprocessableEntity,
			code:       "unsupported_provider",
		},
		{
			name:       "回调重复键",
			authorized: true,
			method:     http.MethodPost,
			path:       CollectionPath + "/" + testJobID + "/callback",
			body:       `{"callback":"first","callback":"second"}`,
			status:     http.StatusBadRequest,
			code:       "invalid_request",
		},
		{
			name:       "回调带查询参数",
			authorized: true,
			method:     http.MethodPost,
			path:       CollectionPath + "/" + testJobID + "/callback?retry=true",
			body:       `{"callback":"code#state"}`,
			status:     http.StatusBadRequest,
			code:       "invalid_query",
		},
		{
			name:       "错误 Job ID",
			authorized: true,
			method:     http.MethodGet,
			path:       CollectionPath + "/1",
			status:     http.StatusBadRequest,
			code:       "invalid_job_path",
		},
		{
			name:       "集合方法错误",
			authorized: true,
			method:     http.MethodGet,
			path:       CollectionPath,
			status:     http.StatusMethodNotAllowed,
			code:       "method_not_allowed",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			jobs := &jobsStub{}
			handler, err := NewHandler(Dependencies{
				Jobs:       jobs,
				Authorizer: authorizerStub(test.authorized),
			})
			if err != nil {
				t.Fatalf("NewHandler() error = %v", err)
			}
			request := httptest.NewRequest(
				test.method,
				test.path,
				strings.NewReader(test.body),
			)
			if test.body != "" {
				request.Header.Set("Content-Type", "application/json")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status ||
				!strings.Contains(
					response.Body.String(),
					`"code":"`+test.code+`"`,
				) {
				t.Fatalf(
					"status=%d body=%s",
					response.Code,
					response.Body.String(),
				)
			}
			if test.name != "不支持的 Provider" && jobs.calls != 0 {
				t.Fatalf("无效请求进入应用层: calls=%d", jobs.calls)
			}
		})
	}
}

// authorizerStub 返回固定管理鉴权结果。
type authorizerStub bool

// Authorized 实现 HTTP 鉴权策略。
func (authorizer authorizerStub) Authorized(*http.Request) bool {
	return bool(authorizer)
}

// jobsStub 记录应用端口调用，并只返回安全固定错误。
type jobsStub struct {
	calls int
}

// Start 模拟不支持 Provider 的创建结果。
func (jobs *jobsStub) Start(
	context.Context,
	string,
) (accountauth.StartResult, error) {
	jobs.calls++
	return accountauth.StartResult{}, accountauth.ErrUnsupportedProvider
}

// Get 不应被当前失败关闭用例调用。
func (jobs *jobsStub) Get(string) (accountauth.Job, error) {
	jobs.calls++
	return accountauth.Job{}, accountauth.ErrJobNotFound
}

// Complete 不应被当前失败关闭用例调用。
func (jobs *jobsStub) Complete(
	context.Context,
	string,
	string,
) (accountauth.Job, error) {
	jobs.calls++
	return accountauth.Job{}, accountauth.ErrInvalidCallback
}

// Cancel 不应被当前失败关闭用例调用。
func (jobs *jobsStub) Cancel(string) (accountauth.Job, error) {
	jobs.calls++
	return accountauth.Job{}, accountauth.ErrJobNotFound
}
