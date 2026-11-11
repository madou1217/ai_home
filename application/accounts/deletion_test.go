package accounts

import (
	"context"
	"errors"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// deletionTestAccount 构造一个合法的 CodeBuddy 账号快照；Provider 必须真的在
// 内置目录里，删除用例会校验账号快照的有效性。
func deletionTestAccount(t *testing.T) accountcore.Account {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   "codebuddy",
		CLIAccountID: cliAccountID,
		Enabled:      true,
		CreatedAt:    time.Unix(1, 0).UTC(),
		UpdatedAt:    time.Unix(1, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}

type deletionTestStore struct {
	account   accountcore.Account
	deleteErr error
	order     *[]string
}

func (store *deletionTestStore) GetByRef(
	context.Context,
	accountcore.AccountRef,
) (accountcore.Account, error) {
	*store.order = append(*store.order, "get")
	return store.account, nil
}

func (store *deletionTestStore) DeleteAccount(
	context.Context,
	accountcore.AccountRef,
) error {
	if store.deleteErr != nil {
		return store.deleteErr
	}
	*store.order = append(*store.order, "delete")
	return nil
}

type deletionTestGuard struct {
	err   error
	order *[]string
}

func (guard *deletionTestGuard) AssertAccountDeletable(
	context.Context,
	accountcore.AccountRef,
) error {
	*guard.order = append(*guard.order, "guard")
	return guard.err
}

type deletionTestPreparation struct {
	err   error
	order *[]string
}

func (preparation *deletionTestPreparation) PrepareAccountDeletion(
	context.Context,
	accountcore.Account,
) error {
	*preparation.order = append(*preparation.order, "prepare")
	return preparation.err
}

type deletionTestCleanup struct {
	order *[]string
}

func (cleanup *deletionTestCleanup) ForgetAccount(accountcore.AccountRef) {
	*cleanup.order = append(*cleanup.order, "forget")
}

type deletionTestHostCleanup struct {
	beforeErr  error
	afterErr   error
	afterCalls int
	order      *[]string
}

func (cleanup *deletionTestHostCleanup) BeforeDelete(
	context.Context,
	accountcore.Account,
) error {
	*cleanup.order = append(*cleanup.order, "host-before")
	return cleanup.beforeErr
}

func (cleanup *deletionTestHostCleanup) AfterDelete(
	context.Context,
	accountcore.Account,
) error {
	cleanup.afterCalls++
	*cleanup.order = append(*cleanup.order, "host-after")
	return cleanup.afterErr
}

func TestDeleteAccountRunsHostCleanupAroundCommit(t *testing.T) {
	order := make([]string, 0, 6)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	guard := &deletionTestGuard{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	hostCleanup := &deletionTestHostCleanup{order: &order}
	deleter, err := NewDeleterWithHostCleanup(store, guard, preparation, hostCleanup, cleanup)
	if err != nil {
		t.Fatalf("NewDeleterWithHostCleanup() error = %v", err)
	}

	if err := deleter.DeleteAccount(context.Background(), store.account.Ref()); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}

	want := []string{"guard", "get", "host-before", "prepare", "delete", "forget", "host-after"}
	if len(order) != len(want) {
		t.Fatalf("order = %v", order)
	}
	for index := range want {
		if order[index] != want[index] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
	if hostCleanup.afterCalls != 1 {
		t.Fatalf("afterCalls = %d", hostCleanup.afterCalls)
	}
}

func TestDeleteAccountAbortsWhenHostCleanupRejects(t *testing.T) {
	order := make([]string, 0, 6)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	guard := &deletionTestGuard{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	hostCleanup := &deletionTestHostCleanup{order: &order, beforeErr: ErrAccountRuntimeActive}
	deleter, err := NewDeleterWithHostCleanup(store, guard, preparation, hostCleanup, cleanup)
	if err != nil {
		t.Fatalf("NewDeleterWithHostCleanup() error = %v", err)
	}

	err = deleter.DeleteAccount(context.Background(), store.account.Ref())
	if !errors.Is(err, ErrAccountRuntimeActive) {
		t.Fatalf("error = %v", err)
	}
	want := []string{"guard", "get", "host-before"}
	if len(order) != len(want) {
		t.Fatalf("宿主拒绝后不得再动投影或数据库，order = %v", order)
	}
	for index := range want {
		if order[index] != want[index] {
			t.Fatalf("order = %v", order)
		}
	}
	if hostCleanup.afterCalls != 0 {
		t.Fatal("提交前失败时不得执行提交后清理")
	}
}

func TestDeleteAccountIgnoresAfterDeleteFailure(t *testing.T) {
	order := make([]string, 0, 6)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	guard := &deletionTestGuard{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	hostCleanup := &deletionTestHostCleanup{order: &order, afterErr: ErrAccountHostCleanupFailed}
	deleter, err := NewDeleterWithHostCleanup(store, guard, preparation, hostCleanup, cleanup)
	if err != nil {
		t.Fatalf("NewDeleterWithHostCleanup() error = %v", err)
	}

	err = deleter.DeleteAccount(context.Background(), store.account.Ref())
	if err != nil {
		t.Fatalf("账号事实已提交，宿主残留清理失败不得变成删除失败: %v", err)
	}
	if hostCleanup.afterCalls != 1 {
		t.Fatalf("afterCalls = %d", hostCleanup.afterCalls)
	}
}

func TestDeleteAccountSkipsAfterDeleteWhenCommitFails(t *testing.T) {
	order := make([]string, 0, 6)
	store := &deletionTestStore{
		account:   deletionTestAccount(t),
		deleteErr: errors.New("db boom"),
		order:     &order,
	}
	guard := &deletionTestGuard{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	hostCleanup := &deletionTestHostCleanup{order: &order}
	deleter, err := NewDeleterWithHostCleanup(store, guard, preparation, hostCleanup, cleanup)
	if err != nil {
		t.Fatalf("NewDeleterWithHostCleanup() error = %v", err)
	}

	if err := deleter.DeleteAccount(context.Background(), store.account.Ref()); err == nil {
		t.Fatal("数据库删除失败必须冒泡")
	}
	if hostCleanup.afterCalls != 0 {
		t.Fatal("账号事实没有变，不得执行提交后清理")
	}
}

func TestDeleteAccountWithoutHostCleanupKeepsLegacyFlow(t *testing.T) {
	order := make([]string, 0, 6)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	guard := &deletionTestGuard{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	deleter, err := NewDeleter(store, guard, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}
	if err := deleter.DeleteAccount(context.Background(), store.account.Ref()); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
}
