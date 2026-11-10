package aihdefault

import (
	"context"
	"errors"
	"testing"
)

func TestLandOnServerDefaultUnsupportedProvider(t *testing.T) {
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, false)
	called := false
	result := LandOnServerDefault(context.Background(), store, provider, func(context.Context, string) error {
		called = true
		return nil
	})
	if !result.OK || result.Landed || result.Reason != CodeProfileUnsupported {
		t.Fatalf("LandOnServerDefault() = %+v", result)
	}
	if called {
		t.Fatal("sync ran for unsupported provider")
	}
}

func TestLandOnServerDefaultRequiresHostScopeAndSync(t *testing.T) {
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	noScope := LandOnServerDefault(context.Background(), Store{Catalog: store.Catalog}, provider, func(context.Context, string) error {
		return nil
	})
	if noScope.OK || noScope.Reason != CodeScopeUnavailable {
		t.Fatalf("LandOnServerDefault(no scope) = %+v", noScope)
	}
	noSync := LandOnServerDefault(context.Background(), store, provider, nil)
	if noSync.OK || noSync.Reason != CodeHostSyncUnavailable {
		t.Fatalf("LandOnServerDefault(no sync) = %+v", noSync)
	}
	if profile, err := store.ReadProviderProfile(context.Background(), provider); err != nil || profile != "" {
		t.Fatalf("profile written without sync: %q, %v", profile, err)
	}
}

// TestLandOnServerDefaultSyncFailureKeepsPointer 同步失败绝不能留下档位。
func TestLandOnServerDefaultSyncFailureKeepsPointer(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	result := LandOnServerDefault(ctx, store, provider, func(context.Context, string) error {
		return errors.New("boom")
	})
	if result.OK || result.Landed || result.Reason != CodeGatewaySyncFailed {
		t.Fatalf("LandOnServerDefault() = %+v", result)
	}
	if profile, err := store.ReadProviderProfile(ctx, provider); err != nil || profile != "" {
		t.Fatalf("profile written after failed sync: %q, %v", profile, err)
	}
	coded := LandOnServerDefault(ctx, store, provider, func(context.Context, string) error {
		return newError(CodeGatewaySyncFailed, errors.New("host busy"))
	})
	if coded.OK || coded.Reason != CodeGatewaySyncFailed {
		t.Fatalf("coded failure = %+v", coded)
	}
}

// TestLandOnServerDefaultWritesProfileAfterSync 成功路径记录档位，重复落点可识别。
func TestLandOnServerDefaultWritesProfileAfterSync(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	calls := 0
	sync := func(context.Context, string) error {
		calls++
		return nil
	}
	first := LandOnServerDefault(ctx, store, provider, sync)
	if !first.OK || !first.Landed || first.AlreadyLanded || first.Profile != ServerProfileID {
		t.Fatalf("first land = %+v", first)
	}
	second := LandOnServerDefault(ctx, store, provider, sync)
	if !second.OK || !second.Landed || !second.AlreadyLanded {
		t.Fatalf("second land = %+v", second)
	}
	if calls != 2 {
		t.Fatalf("sync calls = %d", calls)
	}
	profile, err := store.ReadProviderProfile(ctx, provider)
	if err != nil || profile != ServerProfileID {
		t.Fatalf("ReadProviderProfile() = %q, %v", profile, err)
	}
}

// TestRevokeServerDefaultRestoresHostThenClears 取消档位先还原宿主，再删指针。
func TestRevokeServerDefaultRestoresHostThenClears(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	if err := store.WriteProviderProfile(ctx, provider, ServerProfileID); err != nil {
		t.Fatalf("WriteProviderProfile() error = %v", err)
	}
	restored := false
	result := RevokeServerDefault(ctx, store, provider, func(_ context.Context, got string) error {
		restored = got == provider
		return nil
	})
	if !result.OK || !result.Revoked || !result.HostRestored || !restored {
		t.Fatalf("RevokeServerDefault() = %+v, restored=%v", result, restored)
	}
	profile, err := store.ReadProviderProfile(ctx, provider)
	if err != nil || profile != "" {
		t.Fatalf("profile survived revoke: %q, %v", profile, err)
	}
	again := RevokeServerDefault(ctx, store, provider, nil)
	if !again.OK || again.Revoked || again.HostRestored {
		t.Fatalf("second revoke = %+v", again)
	}
}

// TestRevokeServerDefaultRestoreFailureKeepsPointer 还原失败时指针必须保留，
// 否则会出现「没有档位、宿主还指着网关」的中间态。
func TestRevokeServerDefaultRestoreFailureKeepsPointer(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	if err := store.WriteProviderProfile(ctx, provider, ServerProfileID); err != nil {
		t.Fatalf("WriteProviderProfile() error = %v", err)
	}
	result := RevokeServerDefault(ctx, store, provider, func(context.Context, string) error {
		return newError(CodeGatewayRestoreFailed, errors.New("host changed"))
	})
	if result.OK || result.Reason != CodeGatewayRestoreFailed {
		t.Fatalf("RevokeServerDefault() = %+v", result)
	}
	profile, err := store.ReadProviderProfile(ctx, provider)
	if err != nil || profile != ServerProfileID {
		t.Fatalf("profile cleared after failed restore: %q, %v", profile, err)
	}
}

func TestRevokeServerDefaultRequiresScope(t *testing.T) {
	store := Store{Catalog: testCatalog(t)}
	result := RevokeServerDefault(context.Background(), store, "claude", nil)
	if result.OK || result.Reason != CodeScopeUnavailable {
		t.Fatalf("RevokeServerDefault() = %+v", result)
	}
}
