package aihserver

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// 生图失败分类：状态码是唯一稳定证据。
//
// 上游只说「请求失败」，不告诉我们账号是谁；失败账号由编排层交出（见 images.Execute 的
// AttemptFailure）。这里验证「交出来的错误」→「运行态分类」这一步与 Node 同口径：
// 401 硬阻塞、429 冷却、5xx 冷却、400 不动账号状态。
func TestImageAttemptFailureClassifiesByStatus(t *testing.T) {
	at := time.Now()
	cases := []struct {
		name     string
		cause    error
		wantKind runtimecore.FailureKind
	}{
		{
			name:     "401 凭据失效",
			cause:    &images.Error{StatusCode: 401, Code: "upstream_error", Detail: "unauthorized", UpstreamBody: `{"error":{"message":"bad key"}}`},
			wantKind: runtimecore.FailureCredentialRejected,
		},
		{
			name:     "429 限流",
			cause:    &images.Error{StatusCode: 429, Code: "rate_limited", Detail: "too many requests"},
			wantKind: runtimecore.FailureRateLimited,
		},
		{
			name:     "503 上游不可用",
			cause:    &images.Error{StatusCode: 503, Code: "upstream_error", Detail: "unavailable"},
			wantKind: runtimecore.FailureUpstreamUnavailable,
		},
		{
			name:     "400 请求侧问题",
			cause:    &images.Error{StatusCode: 400, Code: "invalid_request", Detail: "bad size"},
			wantKind: runtimecore.FailureInvalidRequest,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			failure, err := imageAttemptFailure(testCase.cause, at)
			if err != nil {
				t.Fatalf("分类失败: %v", err)
			}
			if failure.RuntimeKind() != testCase.wantKind {
				t.Fatalf("分类应为 %s，实际 %s", testCase.wantKind, failure.RuntimeKind())
			}
		})
	}
}

// 2xx 却走到错误分支：没有失败证据，不能写账号状态。
func TestImageAttemptFailureSkipsSuccessStatus(t *testing.T) {
	if _, err := imageAttemptFailure(
		&images.Error{StatusCode: 200, Code: "invalid_image_output", Detail: "not an image"},
		time.Now(),
	); err == nil {
		t.Fatal("2xx 不应产生账号失败分类")
	}
}
