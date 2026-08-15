package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// TestDeleterRunsCleanupsOnlyAfterCommittedDeletion 验证删除事实提交后才遗忘派生状态。
func TestDeleterRunsCleanupsOnlyAfterCommittedDeletion(t *testing.T) {
	t.Parallel()

	accountRef := deletionTestAccountRef(t)
	order := make([]string, 0, 4)
	store := &deletionStoreStub{order: &order}
	guard := &deletionGuardStub{order: &order}
	preparation := &deletionPreparationStub{order: &order}
	first := &deletionCleanupStub{name: "usage", order: &order}
	second := &deletionCleanupStub{name: "runtime", order: &order}
	deleter, err := accountapp.NewDeleter(
		store,
		guard,
		preparation,
		first,
		second,
	)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}

	if err := deleter.DeleteAccount(context.Background(), accountRef); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	if store.accountRef != accountRef ||
		preparation.account.Ref() != accountRef ||
		first.accountRef != accountRef ||
		second.accountRef != accountRef {
		t.Fatalf(
			"删除身份错误: store=%s first=%s second=%s",
			store.accountRef,
			first.accountRef,
			second.accountRef,
		)
	}
	want := []string{"guard", "load", "prepare", "store", "usage", "runtime"}
	if len(order) != len(want) {
		t.Fatalf("删除顺序 = %#v, want %#v", order, want)
	}
	for index := range want {
		if order[index] != want[index] {
			t.Fatalf("删除顺序 = %#v, want %#v", order, want)
		}
	}
}

// TestDeleterDoesNotCleanDerivedStateWhenStoreFails 验证持久化失败不会制造内存假删除。
func TestDeleterDoesNotCleanDerivedStateWhenStoreFails(t *testing.T) {
	t.Parallel()

	deleteErr := errors.New("synthetic delete failure")
	store := &deletionStoreStub{err: deleteErr}
	guard := &deletionGuardStub{}
	preparation := &deletionPreparationStub{}
	cleanup := &deletionCleanupStub{name: "runtime"}
	deleter, err := accountapp.NewDeleter(store, guard, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}

	err = deleter.DeleteAccount(context.Background(), deletionTestAccountRef(t))
	if !errors.Is(err, deleteErr) {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	if cleanup.calls != 0 {
		t.Fatalf("持久化失败后 cleanup calls = %d", cleanup.calls)
	}
}

// TestDeleterStopsBeforeStoreWhenRuntimeGuardBlocks 验证活跃或无法确认的
// 持久会话会在任何数据库写入前失败关闭。
func TestDeleterStopsBeforeStoreWhenRuntimeGuardBlocks(t *testing.T) {
	t.Parallel()

	guardErr := accountapp.ErrAccountRuntimeActive
	store := &deletionStoreStub{}
	guard := &deletionGuardStub{err: guardErr}
	preparation := &deletionPreparationStub{}
	cleanup := &deletionCleanupStub{name: "runtime"}
	deleter, err := accountapp.NewDeleter(store, guard, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}

	err = deleter.DeleteAccount(context.Background(), deletionTestAccountRef(t))
	if !errors.Is(err, guardErr) {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	if store.loadCalls != 0 || store.calls != 0 || preparation.calls != 0 || cleanup.calls != 0 {
		t.Fatalf(
			"guard 拒绝后 load=%d prepare=%d store=%d cleanup=%d",
			store.loadCalls,
			preparation.calls,
			store.calls,
			cleanup.calls,
		)
	}
}

// TestDeleterKeepsDatabaseWhenPreparationFails 验证 projection/resource
// 预删除阶段失败时账号事实和提交后清理都保持不变。
func TestDeleterKeepsDatabaseWhenPreparationFails(t *testing.T) {
	t.Parallel()

	preparationErr := errors.New("synthetic projection reconciliation failure")
	store := &deletionStoreStub{}
	guard := &deletionGuardStub{}
	preparation := &deletionPreparationStub{err: preparationErr}
	cleanup := &deletionCleanupStub{name: "runtime"}
	deleter, err := accountapp.NewDeleter(store, guard, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}

	err = deleter.DeleteAccount(context.Background(), deletionTestAccountRef(t))
	if !errors.Is(err, preparationErr) {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	if store.loadCalls != 1 || preparation.calls != 1 || store.calls != 0 || cleanup.calls != 0 {
		t.Fatalf(
			"prepare 失败后 load=%d prepare=%d store=%d cleanup=%d",
			store.loadCalls,
			preparation.calls,
			store.calls,
			cleanup.calls,
		)
	}
}

// deletionStoreStub 记录账号删除持久化调用。
type deletionStoreStub struct {
	account    accountcore.Account
	accountRef accountcore.AccountRef
	order      *[]string
	err        error
	loadErr    error
	loadCalls  int
	calls      int
}

// GetByRef 返回删除准备阶段需要的稳定 Provider 身份。
func (store *deletionStoreStub) GetByRef(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, error) {
	store.loadCalls++
	if store.order != nil {
		*store.order = append(*store.order, "load")
	}
	if store.loadErr != nil {
		return accountcore.Account{}, store.loadErr
	}
	if store.account.IsValid() {
		return store.account, nil
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return accountcore.Account{}, err
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          accountRef,
		ProviderID:   "codex",
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    deletionTestTime,
		UpdatedAt:    deletionTestTime,
	})
	if err != nil {
		return accountcore.Account{}, err
	}
	return account, nil
}

// DeleteAccount 返回预设持久化结果。
func (store *deletionStoreStub) DeleteAccount(
	_ context.Context,
	accountRef accountcore.AccountRef,
) error {
	store.calls++
	store.accountRef = accountRef
	if store.order != nil {
		*store.order = append(*store.order, "store")
	}
	return store.err
}

// deletionGuardStub 记录删除前运行时所有权检查。
type deletionGuardStub struct {
	order *[]string
	err   error
}

// deletionPreparationStub 记录数据库删除前的外部资源收敛调用。
type deletionPreparationStub struct {
	account accountcore.Account
	order   *[]string
	err     error
	calls   int
}

// PrepareAccountDeletion 返回预设的 projection/resource 收敛结果。
func (preparation *deletionPreparationStub) PrepareAccountDeletion(
	_ context.Context,
	account accountcore.Account,
) error {
	preparation.account = account
	preparation.calls++
	if preparation.order != nil {
		*preparation.order = append(*preparation.order, "prepare")
	}
	return preparation.err
}

func (guard *deletionGuardStub) AssertAccountDeletable(
	_ context.Context,
	_ accountcore.AccountRef,
) error {
	if guard.order != nil {
		*guard.order = append(*guard.order, "guard")
	}
	return guard.err
}

// deletionCleanupStub 记录派生状态遗忘调用。
type deletionCleanupStub struct {
	name       string
	accountRef accountcore.AccountRef
	order      *[]string
	calls      int
}

// ForgetAccount 记录一次幂等清理请求。
func (cleanup *deletionCleanupStub) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	cleanup.accountRef = accountRef
	cleanup.calls++
	if cleanup.order != nil {
		*cleanup.order = append(*cleanup.order, cleanup.name)
	}
}

// deletionTestAccountRef 创建有效且不包含真实身份的稳定账号引用。
func deletionTestAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()

	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

var deletionTestTime = time.Date(2026, 8, 15, 1, 2, 3, 0, time.UTC)
