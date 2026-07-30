package upstreamfailure

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// TestClassifyClaudeResponse 固化 Claude 结构化错误到运行态动作的映射。
func TestClassifyClaudeResponse(t *testing.T) {
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
				RetryAfter: 5 * time.Minute,
			},
			want:      runtimecore.FailureRateLimited,
			wantRetry: 5 * time.Minute,
		},
		{
			name: "统一额度窗口",
			input: Input{
				StatusCode:       429,
				ErrorType:        "rate_limit_error",
				UnifiedRateLimit: true,
				RetryAfter:       5 * time.Hour,
			},
			want:      runtimecore.FailureQuotaExhausted,
			wantScope: runtimecore.BlockScopeAccount,
		},
		{
			name: "长窗口限流",
			input: Input{
				StatusCode: 429,
				ErrorType:  "rate_limit_error",
				RetryAfter: runtimecore.MaxCooldownHint + time.Hour,
			},
			want:      runtimecore.FailureQuotaExhausted,
			wantScope: runtimecore.BlockScopeAccountModel,
		},
		{
			name: "流内过载",
			input: Input{
				StatusCode: 200,
				ErrorType:  "overloaded_error",
			},
			want: runtimecore.FailureModelOverloaded,
		},
		{
			name: "HTTP 529",
			input: Input{
				StatusCode: 529,
			},
			want: runtimecore.FailureModelOverloaded,
		},
		{
			name: "HTTP 529 忽略异常长恢复提示",
			input: Input{
				StatusCode: 529,
				RetryAfter: runtimecore.MaxCooldownHint + time.Hour,
			},
			want: runtimecore.FailureModelOverloaded,
		},
		{
			name: "认证失败",
			input: Input{
				StatusCode: 401,
				ErrorType:  "authentication_error",
			},
			want:      runtimecore.FailureCredentialRejected,
			wantScope: runtimecore.BlockScopeAccount,
		},
		{
			name: "资源权限不足",
			input: Input{
				StatusCode: 403,
				ErrorType:  "permission_error",
			},
			want:      runtimecore.FailurePermissionDenied,
			wantScope: runtimecore.BlockScopeAccountModel,
		},
		{
			name: "Token 撤销",
			input: Input{
				StatusCode: 403,
				ErrorCode:  "oauth_token_revoked",
			},
			want:      runtimecore.FailureReauthenticationRequired,
			wantScope: runtimecore.BlockScopeAccount,
		},
		{
			name: "账单失败",
			input: Input{
				StatusCode: 402,
				ErrorType:  "billing_error",
			},
			want:      runtimecore.FailureBillingBlocked,
			wantScope: runtimecore.BlockScopeAccount,
		},
		{
			name: "额度失败",
			input: Input{
				StatusCode: 429,
				ErrorType:  "quota_error",
			},
			want:      runtimecore.FailureQuotaExhausted,
			wantScope: runtimecore.BlockScopeAccount,
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
			name: "模型不支持",
			input: Input{
				StatusCode: 404,
				ErrorCode:  "model_not_found",
			},
			want:      runtimecore.FailureModelUnsupported,
			wantScope: runtimecore.BlockScopeAccountModel,
		},
		{
			name: "请求错误",
			input: Input{
				StatusCode: 400,
				ErrorType:  "invalid_request_error",
			},
			want: runtimecore.FailureInvalidRequest,
		},
		{
			name: "上游 API 错误",
			input: Input{
				StatusCode: 500,
				ErrorType:  "api_error",
			},
			want: runtimecore.FailureUpstreamUnavailable,
		},
		{
			name: "安全策略拒绝",
			input: Input{
				StatusCode: 400,
				ErrorCode:  "safety_rejected",
			},
			want: runtimecore.FailureSafetyRejected,
		},
		{
			name: "普通资源不存在",
			input: Input{
				StatusCode: 404,
				ErrorType:  "not_found_error",
			},
			want: runtimecore.FailureNotFound,
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

// TestClassifyClaudeResponseRejectsUnsafeInput 验证分类入口拒绝消息文本。
func TestClassifyClaudeResponseRejectsUnsafeInput(t *testing.T) {
	t.Parallel()

	_, err := Classify(Input{
		StatusCode: 529,
		ErrorType:  "overloaded_error: raw message",
	})
	if err == nil {
		t.Fatal("Classify(unsafe input) error = nil")
	}
}
