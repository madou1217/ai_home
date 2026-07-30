package accountruntime

import (
	"errors"
	"testing"
)

// TestNewBlockDirectiveDefinesScopeAndRecovery 验证每种硬阻塞只能使用
// 已确认的作用域，并自动绑定唯一解除信号。
func TestNewBlockDirectiveDefinesScopeAndRecovery(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		kind     FailureKind
		scope    BlockScope
		recovery RecoveryTrigger
	}{
		{
			"凭据拒绝作用于账号",
			FailureCredentialRejected,
			BlockScopeAccount,
			RecoveryCredentialsUpdated,
		},
		{
			"重新认证作用于账号",
			FailureReauthenticationRequired,
			BlockScopeAccount,
			RecoveryCredentialsUpdated,
		},
		{
			"统一额度作用于账号",
			FailureQuotaExhausted,
			BlockScopeAccount,
			RecoveryUsageSnapshot,
		},
		{
			"模型额度作用于账号模型",
			FailureQuotaExhausted,
			BlockScopeAccountModel,
			RecoveryUsageSnapshot,
		},
		{
			"账单阻塞作用于账号",
			FailureBillingBlocked,
			BlockScopeAccount,
			RecoveryBillingSnapshot,
		},
		{
			"工作区停用作用于账号",
			FailureWorkspaceDeactivated,
			BlockScopeAccount,
			RecoveryAccountStatus,
		},
		{
			"模型不支持作用于账号模型",
			FailureModelUnsupported,
			BlockScopeAccountModel,
			RecoveryModelCatalog,
		},
		{
			"账号地区策略作用于账号",
			FailureRegionUnsupported,
			BlockScopeAccount,
			RecoveryPolicySnapshot,
		},
		{
			"模型地区策略作用于账号模型",
			FailureRegionUnsupported,
			BlockScopeAccountModel,
			RecoveryPolicySnapshot,
		},
		{
			"资源权限作用于账号模型",
			FailurePermissionDenied,
			BlockScopeAccountModel,
			RecoveryPolicySnapshot,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			directive, err := NewBlockDirective(test.kind, test.scope)
			if err != nil {
				t.Fatalf("NewBlockDirective() error = %v", err)
			}
			if !directive.IsValidFor(test.kind) ||
				directive.Scope() != test.scope ||
				directive.RecoveryTrigger() != test.recovery {
				t.Fatalf("directive = %#v", directive)
			}
		})
	}
}

// TestNewBlockDirectiveRejectsWrongScope 验证硬阻塞不能扩大或缩小到
// 与失败证据不一致的账号范围。
func TestNewBlockDirectiveRejectsWrongScope(t *testing.T) {
	t.Parallel()

	tests := []struct {
		kind  FailureKind
		scope BlockScope
	}{
		{FailureRateLimited, BlockScopeAccountModel},
		{FailureInvalidRequest, BlockScopeAccount},
		{FailureCredentialRejected, BlockScopeAccountModel},
		{FailureBillingBlocked, BlockScopeAccountModel},
		{FailureWorkspaceDeactivated, BlockScopeAccountModel},
		{FailureModelUnsupported, BlockScopeAccount},
		{FailureQuotaExhausted, ""},
		{FailureRegionUnsupported, ""},
		{FailurePermissionDenied, ""},
		{FailureQuotaExhausted, BlockScope("provider")},
	}
	for _, test := range tests {
		test := test
		t.Run(string(test.kind)+"/"+string(test.scope), func(t *testing.T) {
			t.Parallel()

			if _, err := NewBlockDirective(
				test.kind,
				test.scope,
			); !errors.Is(err, ErrInvalidBlockDirective) {
				t.Fatalf("NewBlockDirective() error = %v", err)
			}
		})
	}
}

// TestDefaultBlockDirectiveRejectsEvidenceDependentScope 验证 quota 和 region
// 必须由 Provider 分类器显式声明作用域，不能使用领域默认猜测。
func TestDefaultBlockDirectiveRejectsEvidenceDependentScope(t *testing.T) {
	t.Parallel()

	fixed, err := DefaultBlockDirective(FailureModelUnsupported)
	if err != nil ||
		fixed.Scope() != BlockScopeAccountModel ||
		fixed.RecoveryTrigger() != RecoveryModelCatalog {
		t.Fatalf("DefaultBlockDirective(model) = %#v, %v", fixed, err)
	}
	for _, kind := range []FailureKind{
		FailureQuotaExhausted,
		FailureRegionUnsupported,
		FailurePermissionDenied,
	} {
		if _, err := DefaultBlockDirective(kind); !errors.Is(
			err,
			ErrBlockScopeRequired,
		) {
			t.Fatalf("DefaultBlockDirective(%s) error = %v", kind, err)
		}
	}
}
