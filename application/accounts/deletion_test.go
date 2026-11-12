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

// deletionTestOccupancy 是 DeletionOccupancy 的假实现：固定返回一批占用者。
type deletionTestOccupancy struct {
	blockers    []DeletionBlocker
	inspectErr  error
	releaseErr  error
	releaseCall int
	order       *[]string
}

func (occupancy *deletionTestOccupancy) InspectAccountDeletion(
	context.Context,
	accountcore.Account,
) ([]DeletionBlocker, error) {
	*occupancy.order = append(*occupancy.order, "inspect")
	return occupancy.blockers, occupancy.inspectErr
}

func (occupancy *deletionTestOccupancy) ReleaseAccountDeletion(
	context.Context,
	accountcore.Account,
	[]DeletionBlocker,
) error {
	occupancy.releaseCall++
	*occupancy.order = append(*occupancy.order, "release")
	return occupancy.releaseErr
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

type deletionTestGrant struct {
	revocation GrantRevocation
	err        error
	order      *[]string
}

func (grant *deletionTestGrant) RevokeHostGrant(
	context.Context,
	accountcore.Account,
) (GrantRevocation, error) {
	*grant.order = append(*grant.order, "grant")
	return grant.revocation, grant.err
}

type deletionTestDefault struct {
	isDefault bool
	landing   ServerDefaultLanding
	landErr   error
	landCalls int
	order     *[]string
}

func (defaults *deletionTestDefault) IsDefaultAccount(
	context.Context,
	string,
	accountcore.AccountRef,
) (bool, error) {
	*defaults.order = append(*defaults.order, "default-read")
	return defaults.isDefault, nil
}

func (defaults *deletionTestDefault) LandServerDefault(
	context.Context,
	string,
) (ServerDefaultLanding, error) {
	defaults.landCalls++
	*defaults.order = append(*defaults.order, "default-land")
	return defaults.landing, defaults.landErr
}

func assertOrder(t *testing.T, order []string, want ...string) {
	t.Helper()
	if len(order) != len(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for index := range want {
		if order[index] != want[index] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
}

func TestDeleteAccountRunsHostCleanupAroundCommit(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	hostCleanup := &deletionTestHostCleanup{order: &order}
	deleter, err := NewDeleterWithHostCleanup(store, occupancy, preparation, hostCleanup, cleanup)
	if err != nil {
		t.Fatalf("NewDeleterWithHostCleanup() error = %v", err)
	}

	if err := deleter.DeleteAccount(context.Background(), store.account.Ref()); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}

	assertOrder(t, order, "get", "inspect", "host-before", "prepare", "delete", "forget", "host-after")
	if hostCleanup.afterCalls != 1 {
		t.Fatalf("afterCalls = %d", hostCleanup.afterCalls)
	}
}

func TestDeleteAccountAbortsWhenHostCleanupRejects(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	hostCleanup := &deletionTestHostCleanup{order: &order, beforeErr: ErrAccountRuntimeActive}
	deleter, err := NewDeleterWithHostCleanup(store, occupancy, preparation, hostCleanup, cleanup)
	if err != nil {
		t.Fatalf("NewDeleterWithHostCleanup() error = %v", err)
	}

	err = deleter.DeleteAccount(context.Background(), store.account.Ref())
	if !errors.Is(err, ErrAccountRuntimeActive) {
		t.Fatalf("error = %v", err)
	}
	assertOrder(t, order, "get", "inspect", "host-before")
	if hostCleanup.afterCalls != 0 {
		t.Fatal("提交前失败时不得执行提交后清理")
	}
}

func TestDeleteAccountIgnoresAfterDeleteFailure(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	hostCleanup := &deletionTestHostCleanup{order: &order, afterErr: ErrAccountHostCleanupFailed}
	deleter, err := NewDeleterWithHostCleanup(store, occupancy, preparation, hostCleanup, cleanup)
	if err != nil {
		t.Fatalf("NewDeleterWithHostCleanup() error = %v", err)
	}

	if err := deleter.DeleteAccount(context.Background(), store.account.Ref()); err != nil {
		t.Fatalf("账号事实已提交，宿主残留清理失败不得变成删除失败: %v", err)
	}
	if hostCleanup.afterCalls != 1 {
		t.Fatalf("afterCalls = %d", hostCleanup.afterCalls)
	}
}

func TestDeleteAccountSkipsAfterDeleteWhenCommitFails(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{
		account:   deletionTestAccount(t),
		deleteErr: errors.New("db boom"),
		order:     &order,
	}
	occupancy := &deletionTestOccupancy{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	hostCleanup := &deletionTestHostCleanup{order: &order}
	deleter, err := NewDeleterWithHostCleanup(store, occupancy, preparation, hostCleanup, cleanup)
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
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	deleter, err := NewDeleter(store, occupancy, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}
	if err := deleter.DeleteAccount(context.Background(), store.account.Ref()); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
}

// TestDeleteAccountRejectsOccupiedAccountWithoutForce 守住 fail-closed：
// 有占用者且调用方没有确认强制删除时，账号事实必须完全不动。
func TestDeleteAccountRejectsOccupiedAccountWithoutForce(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{
		order: &order,
		blockers: []DeletionBlocker{{
			Kind: "persistent_session", Label: "挂起的持久会话（tmux）", Session: "s-main",
		}},
	}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	deleter, err := NewDeleter(store, occupancy, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}

	outcome, err := deleter.DeleteAccountWithOptions(
		context.Background(),
		store.account.Ref(),
		DeletionOptions{},
	)
	var runtimeActive *RuntimeActiveError
	if !errors.As(err, &runtimeActive) {
		t.Fatalf("error = %v，期望 RuntimeActiveError", err)
	}
	if !errors.Is(err, ErrAccountRuntimeActive) {
		t.Fatalf("error 必须能被 errors.Is(ErrAccountRuntimeActive) 命中: %v", err)
	}
	if len(runtimeActive.Blockers) != 1 || runtimeActive.Blockers[0].Session != "s-main" {
		t.Fatalf("blockers = %v", runtimeActive.Blockers)
	}
	if outcome.Account.Ref() != store.account.Ref() {
		t.Fatalf("outcome.Account = %v", outcome.Account.Ref())
	}
	assertOrder(t, order, "get", "inspect")
	if occupancy.releaseCall != 0 {
		t.Fatal("没有 force 时不得终止任何占用者")
	}
}

// TestDeleteAccountForceReleasesThenDeletes 守住强制删除的顺序：
// 先释放占用者，再回收宿主授权、收敛投影、提交删除。
func TestDeleteAccountForceReleasesThenDeletes(t *testing.T) {
	order := make([]string, 0, 10)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{
		order:    &order,
		blockers: []DeletionBlocker{{Kind: "persistent_session", Session: "s-main"}},
	}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	grant := &deletionTestGrant{order: &order, revocation: GrantRevocation{OK: true}}
	deleter, err := NewDeleter(store, occupancy, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}
	deleter.WithHostProjection(grant, nil)

	if _, err := deleter.DeleteAccountWithOptions(
		context.Background(),
		store.account.Ref(),
		DeletionOptions{Force: true},
	); err != nil {
		t.Fatalf("DeleteAccountWithOptions() error = %v", err)
	}
	assertOrder(t, order, "get", "inspect", "release", "grant", "prepare", "delete", "forget")
	if occupancy.releaseCall != 1 {
		t.Fatalf("releaseCall = %d", occupancy.releaseCall)
	}
}

// TestDeleteAccountAbortsWhenReleaseFails 守住「释放不掉就不删」：
// 带着写入者删库会留下攥着已删凭据的进程。
func TestDeleteAccountAbortsWhenReleaseFails(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	releaseErr := &RuntimeActiveError{Blockers: []DeletionBlocker{{Session: "s-main"}}}
	occupancy := &deletionTestOccupancy{
		order:      &order,
		blockers:   []DeletionBlocker{{Kind: "persistent_session", Session: "s-main"}},
		releaseErr: releaseErr,
	}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	deleter, err := NewDeleter(store, occupancy, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}

	_, err = deleter.DeleteAccountWithOptions(
		context.Background(),
		store.account.Ref(),
		DeletionOptions{Force: true},
	)
	if !errors.Is(err, ErrAccountRuntimeActive) {
		t.Fatalf("error = %v", err)
	}
	assertOrder(t, order, "get", "inspect", "release")
}

// TestDeleteAccountLandsServerDefaultWhenDeletedAccountWasDefault 守住默认账号落点。
func TestDeleteAccountLandsServerDefaultWhenDeletedAccountWasDefault(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	defaults := &deletionTestDefault{
		order:     &order,
		isDefault: true,
		landing:   ServerDefaultLanding{OK: true, Landed: true, Profile: ".aih-server"},
	}
	deleter, err := NewDeleter(store, occupancy, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}
	deleter.WithHostProjection(nil, defaults)

	outcome, err := deleter.DeleteAccountWithOptions(
		context.Background(),
		store.account.Ref(),
		DeletionOptions{},
	)
	if err != nil {
		t.Fatalf("DeleteAccountWithOptions() error = %v", err)
	}
	if !outcome.ServerDefault.Landed || outcome.ServerDefault.Profile != ".aih-server" {
		t.Fatalf("ServerDefault = %+v", outcome.ServerDefault)
	}
	assertOrder(t, order, "get", "inspect", "default-read", "prepare", "delete", "forget", "default-land")
}

// TestDeleteAccountSkipsLandingWhenGrantRevokeAlreadyLanded 守住与 Node 相同的
// 去重语义：授权回收链已经写过档位就不再落一次。
func TestDeleteAccountSkipsLandingWhenGrantRevokeAlreadyLanded(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	grant := &deletionTestGrant{
		order:      &order,
		revocation: GrantRevocation{OK: true, Revoked: true, DefaultProfileUpdated: true},
	}
	defaults := &deletionTestDefault{order: &order, isDefault: true}
	deleter, err := NewDeleter(store, occupancy, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}
	deleter.WithHostProjection(grant, defaults)

	outcome, err := deleter.DeleteAccountWithOptions(
		context.Background(),
		store.account.Ref(),
		DeletionOptions{},
	)
	if err != nil {
		t.Fatalf("DeleteAccountWithOptions() error = %v", err)
	}
	if defaults.landCalls != 0 {
		t.Fatalf("landCalls = %d，已经落过档位就不该再落", defaults.landCalls)
	}
	if outcome.ServerDefault.Reason != "landed_with_host_grant_revoke" {
		t.Fatalf("ServerDefault.Reason = %q", outcome.ServerDefault.Reason)
	}
}

// TestDeleteAccountKeepsDeletionWhenGrantRevokeFails 守住「回收失败不吞删除」。
func TestDeleteAccountKeepsDeletionWhenGrantRevokeFails(t *testing.T) {
	order := make([]string, 0, 8)
	store := &deletionTestStore{account: deletionTestAccount(t), order: &order}
	occupancy := &deletionTestOccupancy{order: &order}
	preparation := &deletionTestPreparation{order: &order}
	cleanup := &deletionTestCleanup{order: &order}
	grant := &deletionTestGrant{order: &order, err: errors.New("host config unreadable")}
	deleter, err := NewDeleter(store, occupancy, preparation, cleanup)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}
	deleter.WithHostProjection(grant, nil)

	outcome, err := deleter.DeleteAccountWithOptions(
		context.Background(),
		store.account.Ref(),
		DeletionOptions{},
	)
	if err != nil {
		t.Fatalf("授权回收失败不得让删除失败: %v", err)
	}
	if outcome.HostGrantRevoke == nil || outcome.HostGrantRevoke.OK {
		t.Fatalf("HostGrantRevoke = %+v", outcome.HostGrantRevoke)
	}
	if outcome.HostGrantRevoke.Reason != "host_grant_revoke_failed" {
		t.Fatalf("Reason = %q", outcome.HostGrantRevoke.Reason)
	}
}
