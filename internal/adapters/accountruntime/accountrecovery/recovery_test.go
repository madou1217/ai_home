package accountrecovery

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

// TestReauthenticatorClearsCredentialBlockAfterSuccessfulWrite 验证凭据恢复
// 严格发生在持久化成功之后，失败写入不能提前解除账号阻塞。
func TestReauthenticatorClearsCredentialBlockAfterSuccessfulWrite(
	t *testing.T,
) {
	t.Parallel()

	account := newRecoveryTestAccount(t)
	events := make([]string, 0, 2)
	next := &reauthenticatorStub{
		account: account,
		events:  &events,
	}
	runtime := &runtimeRecoveryStub{events: &events}
	decorator, err := NewReauthenticator(next, runtime)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}

	result, err := decorator.Reauthenticate(
		context.Background(),
		account.Ref(),
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	if result.Ref() != account.Ref() ||
		len(events) != 2 ||
		events[0] != "persist_credentials" ||
		events[1] != "clear_account_block" ||
		runtime.accountRef != account.Ref() ||
		runtime.accountTrigger !=
			runtimecore.RecoveryCredentialsUpdated {
		t.Fatalf(
			"result=%#v events=%#v runtime=%#v",
			result,
			events,
			runtime,
		)
	}

	next.err = errors.New("synthetic reauthentication failure")
	events = events[:0]
	runtime.accountCalls = 0
	if _, err := decorator.Reauthenticate(
		context.Background(),
		account.Ref(),
		nil,
		nil,
	); !errors.Is(err, next.err) {
		t.Fatalf("Reauthenticate(failure) error = %v", err)
	}
	if runtime.accountCalls != 0 || len(events) != 1 {
		t.Fatalf(
			"failed write recovery calls=%d events=%#v",
			runtime.accountCalls,
			events,
		)
	}
}

// TestReauthenticatorUsesNonCancelledPostCommitContext 验证持久化已经成功后，
// 请求取消不会跳过同进程常量时间恢复操作。
func TestReauthenticatorUsesNonCancelledPostCommitContext(t *testing.T) {
	t.Parallel()

	account := newRecoveryTestAccount(t)
	runtime := &runtimeRecoveryStub{}
	next := &reauthenticatorStub{account: account}
	decorator, err := NewReauthenticator(next, runtime)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	next.afterWrite = cancel

	if _, err := decorator.Reauthenticate(
		ctx,
		account.Ref(),
		nil,
		nil,
	); err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	if !errors.Is(ctx.Err(), context.Canceled) ||
		runtime.accountContextErr != nil {
		t.Fatalf(
			"request error=%v recovery context error=%v",
			ctx.Err(),
			runtime.accountContextErr,
		)
	}
}

// TestModelManagementRecoversOnlyEffectiveModelsAfterSuccessfulWrite 验证刷新
// 和人工维护只恢复当前实际进入正排、倒排索引的模型。
func TestModelManagementRecoversOnlyEffectiveModelsAfterSuccessfulWrite(
	t *testing.T,
) {
	t.Parallel()

	account := newRecoveryTestAccount(t)
	snapshot := []accountapp.AccountModel{
		newRecoveryTestModel(
			t,
			account.Ref(),
			"gpt-5.4",
			true,
			accountapp.ModelPolicyInherit,
		),
		newRecoveryTestModel(
			t,
			account.Ref(),
			"gpt-5.6-sol",
			true,
			accountapp.ModelPolicyForceDisable,
		),
		newRecoveryTestModel(
			t,
			account.Ref(),
			"gpt-manual",
			false,
			accountapp.ModelPolicyForceEnable,
		),
	}
	next := &modelManagementStub{models: snapshot}
	runtime := &runtimeRecoveryStub{}
	decorator, err := NewModelManagement(next, runtime)
	if err != nil {
		t.Fatalf("NewModelManagement() error = %v", err)
	}

	if _, err := decorator.RefreshAccountModels(
		context.Background(),
		account.Ref(),
	); err != nil {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	assertRecoveredModels(
		t,
		runtime,
		account.Ref(),
		[]string{"gpt-5.4", "gpt-manual"},
	)

	runtime.modelCalls = 0
	runtime.modelIDs = nil
	if _, err := decorator.SetManualModelPolicy(
		context.Background(),
		account.Ref(),
		"gpt-manual",
		accountapp.ModelPolicyForceEnable,
	); err != nil {
		t.Fatalf("SetManualModelPolicy() error = %v", err)
	}
	assertRecoveredModels(
		t,
		runtime,
		account.Ref(),
		[]string{"gpt-5.4", "gpt-manual"},
	)
}

// TestModelManagementKeepsBlocksWhenWriteFails 验证目录发现或持久化失败时，
// 恢复端口不会收到任何放行信号。
func TestModelManagementKeepsBlocksWhenWriteFails(t *testing.T) {
	t.Parallel()

	account := newRecoveryTestAccount(t)
	writeErr := errors.New("synthetic model write failure")
	next := &modelManagementStub{err: writeErr}
	runtime := &runtimeRecoveryStub{}
	decorator, err := NewModelManagement(next, runtime)
	if err != nil {
		t.Fatalf("NewModelManagement() error = %v", err)
	}

	if _, err := decorator.RefreshAccountModels(
		context.Background(),
		account.Ref(),
	); !errors.Is(err, writeErr) {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	if runtime.modelCalls != 0 {
		t.Fatalf("failed write recovery calls = %d", runtime.modelCalls)
	}
}

// reauthenticatorStub 记录重新认证持久化与恢复调用顺序。
type reauthenticatorStub struct {
	account    accountcore.Account
	err        error
	events     *[]string
	afterWrite func()
}

// ValidateTarget 模拟不访问运行态的目标预检。
func (*reauthenticatorStub) ValidateTarget(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	return nil
}

// Reauthenticate 返回预设持久化结果。
func (stub *reauthenticatorStub) Reauthenticate(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	if stub.events != nil {
		*stub.events = append(*stub.events, "persist_credentials")
	}
	if stub.afterWrite != nil {
		stub.afterWrite()
	}
	return stub.account, stub.err
}

// modelManagementStub 返回预设模型事务结果。
type modelManagementStub struct {
	models []accountapp.AccountModel
	err    error
}

// ListAccountModels 返回预设快照。
func (stub *modelManagementStub) ListAccountModels(
	context.Context,
	accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	return stub.models, stub.err
}

// RefreshAccountModels 返回预设刷新事务结果。
func (stub *modelManagementStub) RefreshAccountModels(
	context.Context,
	accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	return stub.models, stub.err
}

// SetManualModelPolicy 返回预设人工维护事务结果。
func (stub *modelManagementStub) SetManualModelPolicy(
	context.Context,
	accountcore.AccountRef,
	string,
	accountapp.ModelManualPolicy,
) ([]accountapp.AccountModel, error) {
	return stub.models, stub.err
}

// runtimeRecoveryStub 记录事务后恢复的低敏身份和上下文。
type runtimeRecoveryStub struct {
	events            *[]string
	accountRef        accountcore.AccountRef
	accountTrigger    runtimecore.RecoveryTrigger
	accountContextErr error
	accountCalls      int
	modelRef          accountcore.AccountRef
	modelIDs          []runtimecore.ModelID
	modelTrigger      runtimecore.RecoveryTrigger
	modelCalls        int
}

// ClearAccountBlock 记录账号级恢复。
func (stub *runtimeRecoveryStub) ClearAccountBlock(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	trigger runtimecore.RecoveryTrigger,
) error {
	stub.accountCalls++
	stub.accountRef = accountRef
	stub.accountTrigger = trigger
	stub.accountContextErr = ctx.Err()
	if stub.events != nil {
		*stub.events = append(*stub.events, "clear_account_block")
	}
	return nil
}

// ClearModelBlocks 记录批量模型恢复。
func (stub *runtimeRecoveryStub) ClearModelBlocks(
	_ context.Context,
	accountRef accountcore.AccountRef,
	modelIDs []runtimecore.ModelID,
	trigger runtimecore.RecoveryTrigger,
) error {
	stub.modelCalls++
	stub.modelRef = accountRef
	stub.modelIDs = append([]runtimecore.ModelID(nil), modelIDs...)
	stub.modelTrigger = trigger
	return nil
}

// newRecoveryTestAccount 创建恢复测试使用的稳定 Codex 账号。
func newRecoveryTestAccount(t *testing.T) accountcore.Account {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-account-recovery-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("accountcore.NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(
		catalog,
		accountcore.NewAccountInput{
			Identity:     credential,
			CLIAccountID: alias,
			CreatedAt: time.Date(
				2026,
				time.July,
				30,
				22,
				0,
				0,
				0,
				time.UTC,
			),
		},
	)
	if err != nil {
		t.Fatalf("accountcore.NewAccount() error = %v", err)
	}
	return account
}

// newRecoveryTestModel 创建排序测试使用的模型关系。
func newRecoveryTestModel(
	t *testing.T,
	accountRef accountcore.AccountRef,
	modelID string,
	upstreamAvailable bool,
	policy accountapp.ModelManualPolicy,
) accountapp.AccountModel {
	t.Helper()

	model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accountRef,
		ModelID:           modelID,
		UpstreamAvailable: upstreamAvailable,
		ManualPolicy:      policy,
		UpdatedAt: time.Date(
			2026,
			time.July,
			30,
			22,
			1,
			0,
			0,
			time.UTC,
		),
	})
	if err != nil {
		t.Fatalf("accountapp.NewAccountModel() error = %v", err)
	}
	return model
}

// assertRecoveredModels 验证恢复端口只收到排序后的有效模型。
func assertRecoveredModels(
	t *testing.T,
	runtime *runtimeRecoveryStub,
	accountRef accountcore.AccountRef,
	want []string,
) {
	t.Helper()

	if runtime.modelCalls != 1 ||
		runtime.modelRef != accountRef ||
		runtime.modelTrigger != runtimecore.RecoveryModelCatalog ||
		len(runtime.modelIDs) != len(want) {
		t.Fatalf("runtime recovery = %#v", runtime)
	}
	for index, modelID := range runtime.modelIDs {
		if modelID.String() != want[index] {
			t.Fatalf(
				"modelIDs[%d] = %q, want %q",
				index,
				modelID,
				want[index],
			)
		}
	}
}
