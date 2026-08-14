package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

// TestAccountLifecycleModelRefreshDecoratorsScheduleOnlyCommittedAccounts 验证三个写事务共享相同的提交后刷新语义。
func TestAccountLifecycleModelRefreshDecoratorsScheduleOnlyCommittedAccounts(t *testing.T) {
	t.Parallel()

	credential, account := newModelRefreshLifecycleAccount(t, "committed", 1)
	order := make([]string, 0, 8)
	scheduler := &modelRefreshSchedulerStub{
		err:   errors.New("synthetic queue failure"),
		order: &order,
	}
	registration := &modelRefreshLifecycleServiceStub{
		account: account,
		order:   &order,
	}
	registrationDecorator, err := accountapp.NewRegistrationModelRefreshDecorator(
		registration,
		scheduler,
	)
	if err != nil {
		t.Fatalf("NewRegistrationModelRefreshDecorator() error = %v", err)
	}
	if result, registerErr := registrationDecorator.Register(
		context.Background(),
		credential,
		nil,
	); registerErr != nil || result != account {
		t.Fatalf("Register() = (%#v, %v)", result, registerErr)
	}

	reauthenticationDecorator, err := accountapp.NewReauthenticationModelRefreshDecorator(
		registration,
		scheduler,
	)
	if err != nil {
		t.Fatalf("NewReauthenticationModelRefreshDecorator() error = %v", err)
	}
	if result, reauthErr := reauthenticationDecorator.Reauthenticate(
		context.Background(),
		account.Ref(),
		credential,
		nil,
	); reauthErr != nil || result != account {
		t.Fatalf("Reauthenticate() = (%#v, %v)", result, reauthErr)
	}

	rotationDecorator, err := accountapp.NewStaticCredentialRotationModelRefreshDecorator(
		registration,
		scheduler,
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotationModelRefreshDecorator() error = %v", err)
	}
	if result, rotateErr := rotationDecorator.Rotate(
		context.Background(),
		account.Ref(),
		credential,
	); rotateErr != nil || result != account {
		t.Fatalf("Rotate() = (%#v, %v)", result, rotateErr)
	}
	if scheduler.calls != 3 ||
		scheduler.forgetCalls != 2 ||
		scheduler.accountRef != account.Ref() ||
		scheduler.providerID != account.ProviderID() {
		t.Fatalf("model refresh scheduler = %#v", scheduler)
	}
	wantOrder := []string{
		"register",
		"schedule",
		"reauthenticate",
		"forget",
		"schedule",
		"rotate",
		"forget",
		"schedule",
	}
	if len(order) != len(wantOrder) {
		t.Fatalf("model refresh lifecycle order = %#v, want %#v", order, wantOrder)
	}
	for index := range wantOrder {
		if order[index] != wantOrder[index] {
			t.Fatalf("model refresh lifecycle order = %#v, want %#v", order, wantOrder)
		}
	}
}

// TestAccountLifecycleModelRefreshDecoratorsRejectInvalidResults 验证错误事务结果不会进入异步队列。
func TestAccountLifecycleModelRefreshDecoratorsRejectInvalidResults(t *testing.T) {
	t.Parallel()

	credential, account := newModelRefreshLifecycleAccount(t, "expected", 1)
	_, otherAccount := newModelRefreshLifecycleAccount(t, "other", 2)
	service := &modelRefreshLifecycleServiceStub{account: otherAccount}
	scheduler := &modelRefreshSchedulerStub{}
	decorator, err := accountapp.NewStaticCredentialRotationModelRefreshDecorator(
		service,
		scheduler,
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotationModelRefreshDecorator() error = %v", err)
	}
	_, err = decorator.Rotate(context.Background(), account.Ref(), credential)
	if !errors.Is(err, accountapp.ErrInvalidModelRefreshLifecycleResult) {
		t.Fatalf("Rotate() error = %v", err)
	}
	if scheduler.calls != 0 {
		t.Fatalf("ScheduleModelRefresh() calls = %d, want 0", scheduler.calls)
	}
	if scheduler.forgetCalls != 0 {
		t.Fatalf("ForgetAccount() calls = %d, want 0", scheduler.forgetCalls)
	}
}

// modelRefreshLifecycleServiceStub 同时实现注册、重登和轮换最小端口。
type modelRefreshLifecycleServiceStub struct {
	account accountcore.Account
	err     error
	order   *[]string
}

func (stub *modelRefreshLifecycleServiceStub) Register(
	context.Context,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	if stub.order != nil {
		*stub.order = append(*stub.order, "register")
	}
	return stub.account, stub.err
}

func (*modelRefreshLifecycleServiceStub) ValidateTarget(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	return nil
}

func (stub *modelRefreshLifecycleServiceStub) Reauthenticate(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	if stub.order != nil {
		*stub.order = append(*stub.order, "reauthenticate")
	}
	return stub.account, stub.err
}

func (stub *modelRefreshLifecycleServiceStub) Rotate(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
) (accountcore.Account, error) {
	if stub.order != nil {
		*stub.order = append(*stub.order, "rotate")
	}
	return stub.account, stub.err
}

// modelRefreshSchedulerStub 记录低敏模型刷新信号。
type modelRefreshSchedulerStub struct {
	accountRef  accountcore.AccountRef
	providerID  string
	calls       int
	forgetCalls int
	err         error
	order       *[]string
}

func (stub *modelRefreshSchedulerStub) ScheduleModelRefresh(
	_ context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	stub.calls++
	stub.accountRef = accountRef
	stub.providerID = providerID
	if stub.order != nil {
		*stub.order = append(*stub.order, "schedule")
	}
	return stub.err
}

func (stub *modelRefreshSchedulerStub) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	stub.forgetCalls++
	stub.accountRef = accountRef
	if stub.order != nil {
		*stub.order = append(*stub.order, "forget")
	}
}

func newModelRefreshLifecycleAccount(
	t testing.TB,
	identity string,
	aliasValue int64,
) (accountapp.Credential, accountcore.Account) {
	t.Helper()
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "model-refresh-lifecycle-" + identity,
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(aliasValue)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    time.Date(2026, time.August, 13, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return credential, account
}
