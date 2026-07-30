package upstreamfailure

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// TestClassifyCodexResponse 固化 Codex 结构化错误到运行态动作的映射。
func TestClassifyCodexResponse(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		input     Input
		want      runtimecore.FailureKind
		wantRetry time.Duration
		wantScope runtimecore.BlockScope
	}{
		{
			name: "普通模型限流",
			input: Input{
				StatusCode: 429,
				ErrorType:  "rate_limit_error",
				RetryAfter: 2 * time.Minute,
			},
			want:      runtimecore.FailureRateLimited,
			wantRetry: 2 * time.Minute,
		},
		{
			name: "长窗口限流转额度阻塞",
			input: Input{
				StatusCode: 429,
				ErrorCode:  "rate_limit_exceeded",
				RetryAfter: runtimecore.MaxCooldownHint + time.Hour,
			},
			want:      runtimecore.FailureQuotaExhausted,
			wantScope: runtimecore.BlockScopeAccountModel,
		},
		{
			name: "明确额度耗尽",
			input: Input{
				StatusCode: 429,
				ErrorCode:  "insufficient_quota",
			},
			want:      runtimecore.FailureQuotaExhausted,
			wantScope: runtimecore.BlockScopeAccount,
		},
		{
			name: "账单不可用",
			input: Input{
				StatusCode: 402,
				ErrorCode:  "billing_not_active",
			},
			want:      runtimecore.FailureBillingBlocked,
			wantScope: runtimecore.BlockScopeAccount,
		},
		{
			name: "凭据拒绝",
			input: Input{
				StatusCode: 401,
				ErrorCode:  "invalid_api_key",
			},
			want:      runtimecore.FailureCredentialRejected,
			wantScope: runtimecore.BlockScopeAccount,
		},
		{
			name: "泛化权限不足",
			input: Input{
				StatusCode: 403,
			},
			want:      runtimecore.FailurePermissionDenied,
			wantScope: runtimecore.BlockScopeAccountModel,
		},
		{
			name: "工作区停用",
			input: Input{
				StatusCode: 402,
				ErrorCode:  "deactivated_workspace",
			},
			want:      runtimecore.FailureWorkspaceDeactivated,
			wantScope: runtimecore.BlockScopeAccount,
		},
		{
			name: "HTTP 模型过载",
			input: Input{
				StatusCode: 529,
			},
			want: runtimecore.FailureModelOverloaded,
		},
		{
			name: "模型过载忽略异常长恢复提示",
			input: Input{
				StatusCode: 529,
				RetryAfter: runtimecore.MaxCooldownHint + time.Hour,
			},
			want: runtimecore.FailureModelOverloaded,
		},
		{
			name: "流内模型容量不足",
			input: Input{
				StatusCode: 200,
				ErrorCode:  "model_at_capacity",
			},
			want: runtimecore.FailureModelOverloaded,
		},
		{
			name: "明确模型不支持",
			input: Input{
				StatusCode: 404,
				ErrorCode:  "model_not_found",
			},
			want:      runtimecore.FailureModelUnsupported,
			wantScope: runtimecore.BlockScopeAccountModel,
		},
		{
			name: "普通资源不存在",
			input: Input{
				StatusCode: 404,
			},
			want: runtimecore.FailureNotFound,
		},
		{
			name: "请求超时响应",
			input: Input{
				StatusCode: 408,
			},
			want: runtimecore.FailureRequestTimeout,
		},
		{
			name: "服务暂不可用",
			input: Input{
				StatusCode: 503,
				ErrorCode:  "service_unavailable",
			},
			want: runtimecore.FailureUpstreamUnavailable,
		},
		{
			name: "请求参数错误",
			input: Input{
				StatusCode: 422,
				ErrorType:  "invalid_request_error",
			},
			want: runtimecore.FailureInvalidRequest,
		},
		{
			name: "安全策略拒绝",
			input: Input{
				StatusCode: 400,
				ErrorCode:  "content_policy_violation",
			},
			want: runtimecore.FailureSafetyRejected,
		},
		{
			name: "未知状态",
			input: Input{
				StatusCode: 418,
			},
			want: runtimecore.FailureUnclassified,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := Classify(test.input)
			if err != nil {
				t.Fatalf("Classify() error = %v", err)
			}
			if classification.Kind() != test.want ||
				classification.RetryAfter() != test.wantRetry ||
				!classificationMatchesScope(
					classification,
					test.wantScope,
				) ||
				!classification.IsValid() {
				t.Fatalf("Classify() = %#v", classification)
			}
		})
	}
}

// classificationMatchesScope 验证非阻塞分类保持零指令，硬阻塞精确匹配作用域。
func classificationMatchesScope(
	classification sharedfailure.Classification,
	scope runtimecore.BlockScope,
) bool {
	directive := classification.BlockDirective()
	if scope == "" {
		return directive.IsZero()
	}
	return directive.Scope() == scope &&
		directive.IsValidFor(classification.Kind())
}

// TestClassifyCodexResponseRejectsUnsafeInput 验证分类器不会接收错误正文或非法等待时间。
func TestClassifyCodexResponseRejectsUnsafeInput(t *testing.T) {
	t.Parallel()

	_, err := Classify(Input{
		StatusCode: 429,
		ErrorType:  "rate limit: raw provider message",
	})
	if err == nil {
		t.Fatal("Classify(unsafe input) error = nil")
	}
}
