package accounts

import (
	"context"
	"errors"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// managementTestAuxStores 提供 Management 构造所需的空展示/阻塞/运行态端口。
type managementTestAuxStores struct{}

func (managementTestAuxStores) ListAccountOverviews(
	context.Context,
	OverviewQuery,
) ([]AccountOverview, error) {
	return nil, nil
}

func (managementTestAuxStores) GetAccountOverview(
	context.Context,
	accountcore.AccountRef,
) (AccountOverview, error) {
	return AccountOverview{}, nil
}

func (managementTestAuxStores) GetAccountOverviewByCLIAccountID(
	context.Context,
	string,
	accountcore.CLIAccountID,
) (AccountOverview, error) {
	return AccountOverview{}, nil
}

func (managementTestAuxStores) ReplaceAccountUIState(context.Context, accountcore.UIState) error {
	return nil
}

func (managementTestAuxStores) ListAccountUIStates(context.Context) ([]accountcore.UIState, error) {
	return nil, nil
}

func (managementTestAuxStores) ReplaceAccountBlock(context.Context, runtimecore.AccountBlock) error {
	return nil
}

func (managementTestAuxStores) DeleteAccountBlock(
	context.Context,
	accountcore.AccountRef,
	runtimecore.FailureKind,
) error {
	return nil
}

func (managementTestAuxStores) ListAccountBlocks(context.Context) ([]runtimecore.AccountBlock, error) {
	return nil, nil
}

func (managementTestAuxStores) ReplaceAccountState(
	context.Context,
	runtimecore.AccountState,
	*runtimecore.AccountBlock,
) error {
	return nil
}

func (managementTestAuxStores) DeleteAccountState(context.Context, accountcore.AccountRef) error {
	return nil
}

func (managementTestAuxStores) ListAccountStates(context.Context) ([]runtimecore.AccountState, error) {
	return nil, nil
}

func (managementTestAuxStores) GetAccountState(
	context.Context,
	accountcore.AccountRef,
) (runtimecore.AccountState, error) {
	return runtimecore.AccountState{}, nil
}

// managementTestLifecycle 用内存账号实现最小生命周期读写端口。
type managementTestLifecycle struct {
	account  accountcore.Account
	getCalls int
	setCalls int
	setErr   error
}

func (lifecycle *managementTestLifecycle) GetByRef(
	context.Context,
	accountcore.AccountRef,
) (accountcore.Account, error) {
	lifecycle.getCalls++
	return lifecycle.account, nil
}

func (lifecycle *managementTestLifecycle) SetEnabled(
	_ context.Context,
	_ accountcore.AccountRef,
	enabled bool,
	changedAt time.Time,
) (accountcore.Account, error) {
	lifecycle.setCalls++
	if lifecycle.setErr != nil {
		return accountcore.Account{}, lifecycle.setErr
	}
	updated, err := lifecycle.account.WithEnabled(enabled, changedAt)
	if err != nil {
		return accountcore.Account{}, err
	}
	lifecycle.account = updated
	return updated, nil
}

type managementTestRefreshCall struct {
	accountRef accountcore.AccountRef
	providerID string
}

// managementTestScheduler 记录投递给协调器的刷新任务。
type managementTestScheduler struct {
	calls []managementTestRefreshCall
	err   error
}

func (scheduler *managementTestScheduler) ScheduleModelRefresh(
	_ context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	scheduler.calls = append(scheduler.calls, managementTestRefreshCall{
		accountRef: accountRef,
		providerID: providerID,
	})
	return scheduler.err
}

func newManagementTestAccount(t *testing.T, enabled bool) accountcore.Account {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          accountRef,
		ProviderID:   "codex",
		CLIAccountID: 1,
		Enabled:      enabled,
		CreatedAt:    time.UnixMilli(1_000).UTC(),
		UpdatedAt:    time.UnixMilli(1_000).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}

func newManagementTestSubject(
	t *testing.T,
	enabled bool,
	scheduler ModelRefreshScheduler,
	observer func(accountcore.AccountRef, string, error),
) (*Management, *managementTestLifecycle) {
	t.Helper()
	lifecycle := &managementTestLifecycle{account: newManagementTestAccount(t, enabled)}
	aux := managementTestAuxStores{}
	management, err := NewManagement(
		aux,
		lifecycle,
		aux,
		aux,
		aux,
		func() time.Time { return time.UnixMilli(10_000).UTC() },
		ManagementOptions{
			ModelRefresh:         scheduler,
			ModelRefreshObserver: observer,
		},
	)
	if err != nil {
		t.Fatalf("NewManagement() error = %v", err)
	}
	return management, lifecycle
}

func TestSetAccountEnabledSchedulesModelRefreshOnEnable(t *testing.T) {
	scheduler := &managementTestScheduler{}
	management, lifecycle := newManagementTestSubject(t, false, scheduler, nil)

	account, err := management.SetAccountEnabled(
		context.Background(),
		lifecycle.account.Ref(),
		true,
	)
	if err != nil {
		t.Fatalf("SetAccountEnabled() error = %v", err)
	}
	if !account.Enabled() {
		t.Fatal("SetAccountEnabled() account still disabled")
	}
	if len(scheduler.calls) != 1 {
		t.Fatalf("schedule calls = %d, want 1", len(scheduler.calls))
	}
	call := scheduler.calls[0]
	if call.accountRef.String() != lifecycle.account.Ref().String() ||
		call.providerID != "codex" {
		t.Fatalf("schedule call = %s/%s", call.accountRef, call.providerID)
	}
}

func TestSetAccountEnabledDoesNotRepeatModelRefreshWhenAlreadyEnabled(t *testing.T) {
	scheduler := &managementTestScheduler{}
	management, lifecycle := newManagementTestSubject(t, true, scheduler, nil)

	if _, err := management.SetAccountEnabled(
		context.Background(),
		lifecycle.account.Ref(),
		true,
	); err != nil {
		t.Fatalf("SetAccountEnabled() error = %v", err)
	}
	if len(scheduler.calls) != 0 {
		t.Fatalf("schedule calls = %d, want 0", len(scheduler.calls))
	}
}

func TestSetAccountEnabledDoesNotScheduleModelRefreshWhenDisabling(t *testing.T) {
	scheduler := &managementTestScheduler{}
	management, lifecycle := newManagementTestSubject(t, true, scheduler, nil)

	account, err := management.SetAccountEnabled(
		context.Background(),
		lifecycle.account.Ref(),
		false,
	)
	if err != nil {
		t.Fatalf("SetAccountEnabled() error = %v", err)
	}
	if account.Enabled() {
		t.Fatal("SetAccountEnabled() account still enabled")
	}
	if len(scheduler.calls) != 0 {
		t.Fatalf("schedule calls = %d, want 0", len(scheduler.calls))
	}
	if lifecycle.getCalls != 0 {
		t.Fatalf("GetByRef calls = %d, want 0", lifecycle.getCalls)
	}
}

func TestSetAccountEnabledReportsModelRefreshScheduleFailure(t *testing.T) {
	scheduleErr := errors.New("协调器已关闭")
	scheduler := &managementTestScheduler{err: scheduleErr}
	var observed []error
	management, lifecycle := newManagementTestSubject(
		t,
		false,
		scheduler,
		func(_ accountcore.AccountRef, providerID string, err error) {
			if providerID != "codex" {
				t.Errorf("observer providerID = %s", providerID)
			}
			observed = append(observed, err)
		},
	)

	account, err := management.SetAccountEnabled(
		context.Background(),
		lifecycle.account.Ref(),
		true,
	)
	if err != nil {
		t.Fatalf("SetAccountEnabled() error = %v", err)
	}
	if !account.Enabled() {
		t.Fatal("SetAccountEnabled() account still disabled")
	}
	if len(observed) != 1 || !errors.Is(observed[0], scheduleErr) {
		t.Fatalf("observed = %v", observed)
	}
}

func TestSetAccountEnabledSkipsModelRefreshWithoutScheduler(t *testing.T) {
	management, lifecycle := newManagementTestSubject(t, false, nil, nil)

	account, err := management.SetAccountEnabled(
		context.Background(),
		lifecycle.account.Ref(),
		true,
	)
	if err != nil {
		t.Fatalf("SetAccountEnabled() error = %v", err)
	}
	if !account.Enabled() {
		t.Fatal("SetAccountEnabled() account still disabled")
	}
}

func TestSetAccountEnabledPropagatesLifecycleFailure(t *testing.T) {
	lifecycleErr := errors.New("写入失败")
	scheduler := &managementTestScheduler{}
	management, lifecycle := newManagementTestSubject(t, false, scheduler, nil)
	lifecycle.setErr = lifecycleErr

	_, err := management.SetAccountEnabled(
		context.Background(),
		lifecycle.account.Ref(),
		true,
	)
	if !errors.Is(err, lifecycleErr) {
		t.Fatalf("SetAccountEnabled() error = %v", err)
	}
	if len(scheduler.calls) != 0 {
		t.Fatalf("schedule calls = %d, want 0", len(scheduler.calls))
	}
}
