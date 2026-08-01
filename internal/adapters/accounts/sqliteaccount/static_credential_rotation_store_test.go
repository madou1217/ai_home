package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// TestStoreRotatesStaticCredentialWithoutChangingAccountRef 验证凭据、模型、usage 和路由在一个事务内切换。
func TestStoreRotatesStaticCredentialWithoutChangingAccountRef(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	initial := mustCodexAPIKey(t, "static-rotation-old-key")
	oldModel := mustModelID(t, "gpt-old")
	account := registerStaticRotationAccount(t, store, initial, []runtimecore.ModelID{oldModel})
	manualModel := mustModelID(t, "gpt-manual")
	if _, err := store.SetManualModelPolicy(
		ctx,
		account.Ref(),
		manualModel,
		accountapp.ModelPolicyForceEnable,
		testAccountTime().Add(time.Second),
	); err != nil {
		t.Fatalf("SetManualModelPolicy() error = %v", err)
	}
	usage := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime().Add(time.Second),
		[]usagecore.EntryInput{{
			Bucket:       "primary",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityUnknown,
		}},
	)
	if err := store.ReplaceUsageSnapshot(ctx, usage); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}

	current, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", err)
	}
	replacement := mustCodexAPIKey(t, "static-rotation-new-key")
	newModel := mustModelID(t, "gpt-new")
	rotation, err := accountapp.NewStaticCredentialRotation(
		account,
		current,
		replacement,
		[]runtimecore.ModelID{newModel},
		testAccountTime().Add(2*time.Second),
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotation() error = %v", err)
	}
	updated, err := store.RotateStaticCredential(ctx, rotation)
	if err != nil {
		t.Fatalf("RotateStaticCredential() error = %v", err)
	}
	if updated.Ref() != account.Ref() ||
		updated.CLIAccountID() != account.CLIAccountID() ||
		updated.Enabled() != account.Enabled() ||
		!updated.UpdatedAt().Equal(rotation.UpdatedAt()) {
		t.Fatalf("updated account = %#v", updated)
	}
	persisted, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot(updated) error = %v", err)
	}
	persistedKey, ok := persisted.Credential().(*codex.APIKeyAuth)
	if !ok || persistedKey.APIKey() != replacement.APIKey() {
		t.Fatalf("persisted credential = %T %#v", persisted.Credential(), persisted)
	}
	replacementAccountRef, err := accountcore.DeriveAccountRef(replacement)
	if err != nil {
		t.Fatalf("DeriveAccountRef(replacement) error = %v", err)
	}
	if replacementAccountRef == account.Ref() || persisted.AccountRef() != account.Ref() {
		t.Fatalf(
			"stable account ref=%s replacement derived=%s snapshot=%s",
			account.Ref(),
			replacementAccountRef,
			persisted.AccountRef(),
		)
	}
	models, err := store.ListAccountModels(ctx, account.Ref())
	if err != nil {
		t.Fatalf("ListAccountModels() error = %v", err)
	}
	assertRotatedStaticModels(t, models)
	if _, err := store.GetUsageSnapshot(ctx, account.Ref()); !errors.Is(
		err,
		usageapp.ErrSnapshotNotFound,
	) {
		t.Fatalf("GetUsageSnapshot() error = %v, want ErrSnapshotNotFound", err)
	}
	oldRoutes, err := store.LoadRoutingCandidates(ctx, codex.ProviderID, oldModel)
	if err != nil {
		t.Fatalf("LoadRoutingCandidates(old) error = %v", err)
	}
	newRoutes, err := store.LoadRoutingCandidates(ctx, codex.ProviderID, newModel)
	if err != nil {
		t.Fatalf("LoadRoutingCandidates(new) error = %v", err)
	}
	manualRoutes, err := store.LoadRoutingCandidates(ctx, codex.ProviderID, manualModel)
	if err != nil {
		t.Fatalf("LoadRoutingCandidates(manual) error = %v", err)
	}
	if oldRoutes.Len() != 0 || newRoutes.Len() != 1 || manualRoutes.Len() != 1 {
		t.Fatalf(
			"routing lengths old=%d new=%d manual=%d",
			oldRoutes.Len(),
			newRoutes.Len(),
			manualRoutes.Len(),
		)
	}
}

// TestStoreRejectsStaticCredentialAlreadyBoundToAnotherAccount 验证当前凭据查重索引失败关闭且回滚。
func TestStoreRejectsStaticCredentialAlreadyBoundToAnotherAccount(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	firstCredential := mustCodexAPIKey(t, "static-rotation-conflict-first")
	secondCredential := mustCodexAPIKey(t, "static-rotation-conflict-second")
	model := mustModelID(t, "gpt-conflict")
	first := registerStaticRotationAccount(
		t,
		store,
		firstCredential,
		[]runtimecore.ModelID{model},
	)
	_ = registerStaticRotationAccount(
		t,
		store,
		secondCredential,
		[]runtimecore.ModelID{model},
	)
	current, err := store.GetCredentialSnapshot(ctx, first.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", err)
	}
	rotation, err := accountapp.NewStaticCredentialRotation(
		first,
		current,
		secondCredential,
		[]runtimecore.ModelID{model},
		testAccountTime().Add(time.Second),
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotation() error = %v", err)
	}
	if _, err := store.RotateStaticCredential(ctx, rotation); !errors.Is(
		err,
		accountapp.ErrStaticCredentialRotationConflict,
	) {
		t.Fatalf("RotateStaticCredential() error = %v", err)
	}
	persisted, err := store.GetCredentialSnapshot(ctx, first.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot(after conflict) error = %v", err)
	}
	persistedKey := persisted.Credential().(*codex.APIKeyAuth)
	if persistedKey.APIKey() != firstCredential.APIKey() ||
		!persisted.UpdatedAt().Equal(current.UpdatedAt()) {
		t.Fatal("冲突轮换修改了原账号凭据")
	}
}

// registerStaticRotationAccount 使用生产注册事务创建带初始模型的静态账号。
func registerStaticRotationAccount(
	t *testing.T,
	store *Store,
	credential accountapp.Credential,
	models []runtimecore.ModelID,
) accountcore.Account {
	t.Helper()
	request, err := accountapp.NewRegistrationRequest(
		store.catalog,
		credential,
		nil,
		models,
		testAccountTime(),
	)
	if err != nil {
		t.Fatalf("NewRegistrationRequest() error = %v", err)
	}
	account, err := store.RegisterNew(context.Background(), request)
	if err != nil {
		t.Fatalf("RegisterNew() error = %v", err)
	}
	return account
}

// assertRotatedStaticModels 验证自动发现替换且人工启用策略保留。
func assertRotatedStaticModels(t *testing.T, models []accountapp.AccountModel) {
	t.Helper()
	if len(models) != 2 {
		t.Fatalf("models = %#v", models)
	}
	byID := make(map[string]accountapp.AccountModel, len(models))
	for _, model := range models {
		byID[model.ModelID().String()] = model
	}
	newModel, newFound := byID["gpt-new"]
	manualModel, manualFound := byID["gpt-manual"]
	if !newFound ||
		!newModel.UpstreamAvailable() ||
		newModel.ManualPolicy() != accountapp.ModelPolicyInherit ||
		!manualFound ||
		manualModel.UpstreamAvailable() ||
		manualModel.ManualPolicy() != accountapp.ModelPolicyForceEnable {
		t.Fatalf("rotated models = %#v", models)
	}
}
