package accounts_test

import (
	"context"
	"errors"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestDeleterRunsCleanupsOnlyAfterCommittedDeletion 验证删除事实提交后才遗忘派生状态。
func TestDeleterRunsCleanupsOnlyAfterCommittedDeletion(t *testing.T) {
	t.Parallel()

	accountRef := deletionTestAccountRef(t)
	order := make([]string, 0, 3)
	store := &deletionStoreStub{order: &order}
	first := &deletionCleanupStub{name: "usage", order: &order}
	second := &deletionCleanupStub{name: "runtime", order: &order}
	deleter, err := accountapp.NewDeleter(store, first, second)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}

	if err := deleter.DeleteAccount(context.Background(), accountRef); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	if store.accountRef != accountRef ||
		first.accountRef != accountRef ||
		second.accountRef != accountRef {
		t.Fatalf(
			"删除身份错误: store=%s first=%s second=%s",
			store.accountRef,
			first.accountRef,
			second.accountRef,
		)
	}
	want := []string{"store", "usage", "runtime"}
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
	cleanup := &deletionCleanupStub{name: "runtime"}
	deleter, err := accountapp.NewDeleter(store, cleanup)
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

// deletionStoreStub 记录账号删除持久化调用。
type deletionStoreStub struct {
	accountRef accountcore.AccountRef
	order      *[]string
	err        error
}

// DeleteAccount 返回预设持久化结果。
func (store *deletionStoreStub) DeleteAccount(
	_ context.Context,
	accountRef accountcore.AccountRef,
) error {
	store.accountRef = accountRef
	if store.order != nil {
		*store.order = append(*store.order, "store")
	}
	return store.err
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
