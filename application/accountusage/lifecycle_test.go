package accountusage_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// TestRegistrationDecoratorSchedulesOnlyCommittedAccount 验证注册结果和异步调度边界彼此隔离。
func TestRegistrationDecoratorSchedulesOnlyCommittedAccount(t *testing.T) {
	t.Parallel()

	credential, account := lifecycleAccount(t)
	next := &registrationServiceStub{account: account}
	scheduler := &refreshSchedulerStub{
		err: errors.New("synthetic schedule failure"),
	}
	decorator, err := usageapp.NewRegistrationDecorator(next, scheduler)
	if err != nil {
		t.Fatalf("NewRegistrationDecorator() error = %v", err)
	}
	registered, err := decorator.Register(
		context.Background(),
		credential,
		nil,
	)
	if err != nil || registered != account {
		t.Fatalf("Register() = (%#v, %v)", registered, err)
	}
	assertScheduledAccount(t, scheduler, account)

	next.err = errors.New("synthetic registration failure")
	if _, err := decorator.Register(
		context.Background(),
		credential,
		nil,
	); err == nil {
		t.Fatal("Register(failed downstream) error = nil")
	}
	if scheduler.calls != 1 {
		t.Fatalf("ScheduleUsageRefresh() calls = %d, want 1", scheduler.calls)
	}
}

// TestReauthenticationDecoratorSchedulesSameCommittedIdentity 验证重登只调度同一稳定账号。
func TestReauthenticationDecoratorSchedulesSameCommittedIdentity(t *testing.T) {
	t.Parallel()

	credential, account := lifecycleAccount(t)
	next := &reauthenticationServiceStub{account: account}
	scheduler := &refreshSchedulerStub{}
	decorator, err := usageapp.NewReauthenticationDecorator(next, scheduler)
	if err != nil {
		t.Fatalf("NewReauthenticationDecorator() error = %v", err)
	}
	if err := decorator.ValidateTarget(
		context.Background(),
		account.Ref(),
		account.ProviderID(),
	); err != nil {
		t.Fatalf("ValidateTarget() error = %v", err)
	}
	reauthenticated, err := decorator.Reauthenticate(
		context.Background(),
		account.Ref(),
		credential,
		nil,
	)
	if err != nil || reauthenticated != account {
		t.Fatalf("Reauthenticate() = (%#v, %v)", reauthenticated, err)
	}
	assertScheduledAccount(t, scheduler, account)
	assertInvalidatedBeforeSchedule(t, scheduler, account.Ref())

	otherCredential := serviceCredential{
		providerID: "codex",
		identity:   "api_key:codex:lifecycle-other",
	}
	next.account = newLifecycleAccount(t, otherCredential, 2)
	if _, err := decorator.Reauthenticate(
		context.Background(),
		account.Ref(),
		credential,
		nil,
	); !errors.Is(err, usageapp.ErrInvalidSnapshot) {
		t.Fatalf("Reauthenticate(other identity) error = %v", err)
	}
	if scheduler.calls != 1 {
		t.Fatalf("ScheduleUsageRefresh() calls = %d, want 1", scheduler.calls)
	}
	if scheduler.forgetCalls != 1 {
		t.Fatalf("ForgetAccount() calls = %d, want 1", scheduler.forgetCalls)
	}
}

// TestStaticCredentialRotationDecoratorSwitchesGenerationAfterCommit 验证静态凭据
// 轮换与 OAuth 重登共享相同的提交后代次切换语义。
func TestStaticCredentialRotationDecoratorSwitchesGenerationAfterCommit(
	t *testing.T,
) {
	t.Parallel()

	credential, account := lifecycleAccount(t)
	next := &staticCredentialRotationServiceStub{account: account}
	scheduler := &refreshSchedulerStub{
		err: errors.New("synthetic schedule failure"),
	}
	decorator, err := usageapp.NewStaticCredentialRotationDecorator(
		next,
		scheduler,
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotationDecorator() error = %v", err)
	}
	rotated, err := decorator.Rotate(
		context.Background(),
		account.Ref(),
		credential,
	)
	if err != nil || rotated != account {
		t.Fatalf("Rotate() = (%#v, %v)", rotated, err)
	}
	assertScheduledAccount(t, scheduler, account)
	assertInvalidatedBeforeSchedule(t, scheduler, account.Ref())

	next.err = errors.New("synthetic rotation failure")
	if _, err := decorator.Rotate(
		context.Background(),
		account.Ref(),
		credential,
	); err == nil {
		t.Fatal("Rotate(failed downstream) error = nil")
	}
	if scheduler.calls != 1 || scheduler.forgetCalls != 1 {
		t.Fatalf(
			"failed rotation side effects schedule=%d forget=%d",
			scheduler.calls,
			scheduler.forgetCalls,
		)
	}
}

// registrationServiceStub 返回可控的注册事务结果。
type registrationServiceStub struct {
	account accountcore.Account
	err     error
}

// Register 返回已经配置的账号或事务错误。
func (stub *registrationServiceStub) Register(
	context.Context,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	return stub.account, stub.err
}

// reauthenticationServiceStub 返回可控的重登事务结果。
type reauthenticationServiceStub struct {
	account accountcore.Account
	err     error
}

// staticCredentialRotationServiceStub 返回可控的静态轮换事务结果。
type staticCredentialRotationServiceStub struct {
	account accountcore.Account
	err     error
}

// Rotate 返回已经配置的账号或事务错误。
func (stub *staticCredentialRotationServiceStub) Rotate(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
) (accountcore.Account, error) {
	return stub.account, stub.err
}

// ValidateTarget 模拟成功的重登目标预检。
func (*reauthenticationServiceStub) ValidateTarget(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	return nil
}

// Reauthenticate 返回已经配置的账号或事务错误。
func (stub *reauthenticationServiceStub) Reauthenticate(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	return stub.account, stub.err
}

// refreshSchedulerStub 记录生命周期 Decorator 发出的低敏调度信号。
type refreshSchedulerStub struct {
	mu          sync.Mutex
	accountRef  accountcore.AccountRef
	providerID  string
	calls       int
	forgetCalls int
	events      []string
	err         error
}

// ScheduleUsageRefresh 保存最近一次调度参数并返回可控错误。
func (stub *refreshSchedulerStub) ScheduleUsageRefresh(
	_ context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	stub.calls++
	stub.accountRef = accountRef
	stub.providerID = providerID
	stub.events = append(stub.events, "schedule:"+accountRef.String())
	return stub.err
}

// ForgetAccount 记录旧额度刷新代次在新任务入队前失效。
func (stub *refreshSchedulerStub) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	stub.forgetCalls++
	stub.events = append(stub.events, "forget:"+accountRef.String())
}

// lifecycleAccount 创建测试默认账号及其同身份凭据。
func lifecycleAccount(
	t testing.TB,
) (serviceCredential, accountcore.Account) {
	t.Helper()

	credential := serviceCredential{
		providerID: "codex",
		identity:   "api_key:codex:lifecycle",
	}
	return credential, newLifecycleAccount(t, credential, 1)
}

// newLifecycleAccount 从合成身份创建可验证的账号快照。
func newLifecycleAccount(
	t testing.TB,
	credential serviceCredential,
	aliasValue int64,
) accountcore.Account {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(aliasValue)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(
		catalog,
		accountcore.NewAccountInput{
			Identity:     credential,
			CLIAccountID: alias,
			CreatedAt: time.Date(
				2026,
				time.July,
				31,
				5,
				0,
				0,
				0,
				time.UTC,
			),
		},
	)
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return account
}

// assertScheduledAccount 验证 Decorator 只传递稳定身份和规范 Provider。
func assertScheduledAccount(
	t testing.TB,
	scheduler *refreshSchedulerStub,
	account accountcore.Account,
) {
	t.Helper()

	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if scheduler.calls != 1 ||
		scheduler.accountRef != account.Ref() ||
		scheduler.providerID != account.ProviderID() {
		t.Fatalf(
			"schedule calls=%d account=%s provider=%s",
			scheduler.calls,
			scheduler.accountRef,
			scheduler.providerID,
		)
	}
}

// assertInvalidatedBeforeSchedule 验证凭据提交后的固定代次切换顺序。
func assertInvalidatedBeforeSchedule(
	t testing.TB,
	scheduler *refreshSchedulerStub,
	accountRef accountcore.AccountRef,
) {
	t.Helper()

	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	expected := []string{
		"forget:" + accountRef.String(),
		"schedule:" + accountRef.String(),
	}
	if len(scheduler.events) != len(expected) {
		t.Fatalf("usage lifecycle events = %#v, want %#v", scheduler.events, expected)
	}
	for index := range expected {
		if scheduler.events[index] != expected[index] {
			t.Fatalf("usage lifecycle events = %#v, want %#v", scheduler.events, expected)
		}
	}
}
