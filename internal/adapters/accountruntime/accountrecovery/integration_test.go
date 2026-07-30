package accountrecovery

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
)

// TestDecoratorsRecoverSharedProductionRuntime 验证重登与模型管理 Decorator
// 共享同一个生产 Runtime，并按账号级、模型级顺序恢复资格。
func TestDecoratorsRecoverSharedProductionRuntime(t *testing.T) {
	t.Parallel()

	account := newRecoveryTestAccount(t)
	runtime, err := runtimeinmemory.New(func() time.Time {
		return time.Date(2026, time.July, 30, 22, 30, 0, 0, time.UTC)
	})
	if err != nil {
		t.Fatalf("runtimeinmemory.New() error = %v", err)
	}
	modelRoute, err := runtimecore.NewModelRoute(
		account.Ref(),
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("runtimecore.NewModelRoute(model) error = %v", err)
	}
	siblingRoute, err := runtimecore.NewModelRoute(
		account.Ref(),
		"gpt-5.4",
	)
	if err != nil {
		t.Fatalf("runtimecore.NewModelRoute(sibling) error = %v", err)
	}
	recordRecoveryTestBlock(
		t,
		runtime,
		modelRoute,
		runtimecore.FailureCredentialRejected,
		runtimecore.BlockScopeAccount,
	)
	recordRecoveryTestBlock(
		t,
		runtime,
		modelRoute,
		runtimecore.FailureModelUnsupported,
		runtimecore.BlockScopeAccountModel,
	)
	assertRecoveryEligibility(
		t,
		runtime,
		modelRoute,
		runtimecore.EligibilityCredentialBlocked,
	)
	assertRecoveryEligibility(
		t,
		runtime,
		siblingRoute,
		runtimecore.EligibilityCredentialBlocked,
	)

	reauthenticator, err := NewReauthenticator(
		&reauthenticatorStub{account: account},
		runtime,
	)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}
	if _, err := reauthenticator.Reauthenticate(
		context.Background(),
		account.Ref(),
		nil,
		nil,
	); err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	assertRecoveryEligibility(
		t,
		runtime,
		modelRoute,
		runtimecore.EligibilityPolicyBlocked,
	)
	assertRecoveryEligibility(
		t,
		runtime,
		siblingRoute,
		runtimecore.EligibilityAvailable,
	)

	modelManagement, err := NewModelManagement(
		&modelManagementStub{
			models: []accountapp.AccountModel{
				newRecoveryTestModel(
					t,
					account.Ref(),
					modelRoute.ModelID().String(),
					true,
					accountapp.ModelPolicyInherit,
				),
			},
		},
		runtime,
	)
	if err != nil {
		t.Fatalf("NewModelManagement() error = %v", err)
	}
	if _, err := modelManagement.RefreshAccountModels(
		context.Background(),
		account.Ref(),
	); err != nil {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	assertRecoveryEligibility(
		t,
		runtime,
		modelRoute,
		runtimecore.EligibilityAvailable,
	)
	t.Log(
		"恢复效果: credential_blocked -> policy_blocked -> available，" +
			"兄弟模型在凭据恢复后立即 available",
	)
}

// recordRecoveryTestBlock 向生产 Runtime 记录一个结构化硬阻塞。
func recordRecoveryTestBlock(
	t *testing.T,
	runtime *runtimeinmemory.Runtime,
	route runtimecore.ModelRoute,
	kind runtimecore.FailureKind,
	scope runtimecore.BlockScope,
) {
	t.Helper()

	directive, err := runtimecore.NewBlockDirective(kind, scope)
	if err != nil {
		t.Fatalf("runtimecore.NewBlockDirective() error = %v", err)
	}
	responseFailure, err := inference.NewResponseFailure(
		string(kind),
		"合成恢复测试失败",
		true,
	)
	if err != nil {
		t.Fatalf("inference.NewResponseFailure() error = %v", err)
	}
	failure, err := inferencegateway.NewAttemptFailure(
		inferencegateway.AttemptFailureInput{
			ResponseFailure: responseFailure,
			RuntimeKind:     kind,
			BlockDirective:  directive,
		},
	)
	if err != nil {
		t.Fatalf("inferencegateway.NewAttemptFailure() error = %v", err)
	}
	if err := runtime.RecordFailure(
		context.Background(),
		route,
		failure,
	); err != nil {
		t.Fatalf("runtime.RecordFailure() error = %v", err)
	}
}

// assertRecoveryEligibility 验证生产 Runtime 的稳定资格状态。
func assertRecoveryEligibility(
	t *testing.T,
	runtime *runtimeinmemory.Runtime,
	route runtimecore.ModelRoute,
	want runtimecore.EligibilityStatus,
) {
	t.Helper()

	eligibility, err := runtime.CheckEligibility(
		context.Background(),
		route,
	)
	if err != nil {
		t.Fatalf("runtime.CheckEligibility() error = %v", err)
	}
	if eligibility.Status() != want {
		t.Fatalf(
			"eligibility status=%q, want %q",
			eligibility.Status(),
			want,
		)
	}
}
