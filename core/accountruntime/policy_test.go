package accountruntime

import (
	"testing"
	"time"
)

// TestFailurePolicyMatrix 固化所有已知失败类型唯一允许的运行态动作。
func TestFailurePolicyMatrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		kind            FailureKind
		action          FailureAction
		threshold       uint8
		defaultCooldown time.Duration
	}{
		{"普通限流", FailureRateLimited, ActionModelCooldown, 1, 5 * time.Minute},
		{"模型过载", FailureModelOverloaded, ActionModelCooldown, 1, time.Minute},
		{"上游暂不可用", FailureUpstreamUnavailable, ActionModelCooldown, 1, 30 * time.Second},
		{"请求超时", FailureRequestTimeout, ActionModelCooldown, 2, 30 * time.Second},
		{"连接重置", FailureConnectionReset, ActionModelCooldown, 2, 30 * time.Second},
		{"流中断", FailureStreamDisconnected, ActionModelCooldown, 2, 30 * time.Second},
		{"凭据被拒绝", FailureCredentialRejected, ActionCredentialBlock, 0, 0},
		{"需要重新认证", FailureReauthenticationRequired, ActionCredentialBlock, 0, 0},
		{"额度耗尽", FailureQuotaExhausted, ActionQuotaBlock, 0, 0},
		{"账单阻塞", FailureBillingBlocked, ActionQuotaBlock, 0, 0},
		{"工作区停用", FailureWorkspaceDeactivated, ActionPolicyBlock, 0, 0},
		{"模型不支持", FailureModelUnsupported, ActionPolicyBlock, 0, 0},
		{"地区不支持", FailureRegionUnsupported, ActionPolicyBlock, 0, 0},
		{"请求参数错误", FailureInvalidRequest, ActionNoStateChange, 0, 0},
		{"资源不存在", FailureNotFound, ActionNoStateChange, 0, 0},
		{"内容策略拒绝", FailureSafetyRejected, ActionNoStateChange, 0, 0},
		{"响应结构错误", FailureMalformedResponse, ActionNoStateChange, 0, 0},
		{"请求被取消", FailureRequestCancelled, ActionNoStateChange, 0, 0},
		{"未分类错误", FailureUnclassified, ActionNoStateChange, 0, 0},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			policy, err := PolicyFor(test.kind)
			if err != nil {
				t.Fatalf("PolicyFor(%q) error = %v", test.kind, err)
			}
			if policy.Action() != test.action ||
				policy.FailureThreshold() != test.threshold ||
				policy.DefaultCooldown() != test.defaultCooldown {
				t.Fatalf(
					"PolicyFor(%q) = action:%q threshold:%d cooldown:%s",
					test.kind,
					policy.Action(),
					policy.FailureThreshold(),
					policy.DefaultCooldown(),
				)
			}
			if policy.EntersCooldown() !=
				(test.action == ActionModelCooldown) {
				t.Fatalf(
					"PolicyFor(%q).EntersCooldown() = %t",
					test.kind,
					policy.EntersCooldown(),
				)
			}
		})
	}
}

// TestFailurePolicyRejectsUnknownKind 验证未知错误不会获得兜底 cooldown。
func TestFailurePolicyRejectsUnknownKind(t *testing.T) {
	t.Parallel()

	if _, err := PolicyFor(FailureKind("future_unknown")); err == nil {
		t.Fatal("PolicyFor(unknown) error = nil")
	}
}
