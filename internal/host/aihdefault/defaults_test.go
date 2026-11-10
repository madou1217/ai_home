package aihdefault

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func testCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

// pickProvider 从 Provider 合同里挑一个声明/未声明 gateway_profile 的 Provider，
// 不在测试里维护名单。
func pickProvider(t *testing.T, catalog *providers.Catalog, supported bool) string {
	t.Helper()
	for _, definition := range catalog.List() {
		hit := catalog.Supports(definition.ID, providers.CapabilityGatewayProfile)
		if hit == supported {
			return definition.ID
		}
	}
	if supported {
		t.Fatal("合同里没有声明 gateway_profile 的 Provider")
	}
	return "not-a-registered-provider"
}

func newStore(t *testing.T) Store {
	t.Helper()
	return Store{
		DatabasePath: filepath.Join(t.TempDir(), appstate.DatabaseFileName),
		Catalog:      testCatalog(t),
	}
}

func mustWriteKV(t *testing.T, databasePath, key, value string) {
	t.Helper()
	if err := appstate.WriteKV(context.Background(), databasePath, key, value, 1); err != nil {
		t.Fatalf("WriteKV(%q) error = %v", key, err)
	}
}

// TestProviderDefaultKeyNormalization 锁住与 Node 完全相同的键名口径。
func TestProviderDefaultKeyNormalization(t *testing.T) {
	if got := ProviderDefaultKey("  Claude "); got != "provider:default:claude" {
		t.Fatalf("ProviderDefaultKey() = %q", got)
	}
	if got := ProviderDefaultKey("   "); got != "" {
		t.Fatalf("ProviderDefaultKey(empty) = %q", got)
	}
}

// TestReadProviderProfileMissingStore 验证全新数据根按「未设置」处理，不报错。
func TestReadProviderProfileMissingStore(t *testing.T) {
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	profile, err := store.ReadProviderProfile(context.Background(), provider)
	if err != nil || profile != "" {
		t.Fatalf("ReadProviderProfile() = %q, %v", profile, err)
	}
	cleared, err := store.ClearProviderProfile(context.Background(), provider)
	if err != nil || cleared {
		t.Fatalf("ClearProviderProfile() = %v, %v", cleared, err)
	}
}

// TestWriteAndReadProviderProfile 存储形状必须与 Node 的 JSON.stringify 一致。
func TestWriteAndReadProviderProfile(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	if err := store.WriteProviderProfile(ctx, provider, ServerProfileID); err != nil {
		t.Fatalf("WriteProviderProfile() error = %v", err)
	}
	raw, found, err := appstate.ReadKV(ctx, store.DatabasePath, ProviderDefaultKey(provider))
	if err != nil || !found || raw != `".aih-server"` {
		t.Fatalf("app_kv value = %q, found=%v, err=%v", raw, found, err)
	}
	profile, err := store.ReadProviderProfile(ctx, provider)
	if err != nil || profile != ServerProfileID {
		t.Fatalf("ReadProviderProfile() = %q, %v", profile, err)
	}
}

// TestWriteProviderProfileRejectsInvalidInput 只接受 .aih-server 与支持的 Provider。
func TestWriteProviderProfileRejectsInvalidInput(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	supported := pickProvider(t, store.Catalog, true)
	if err := store.WriteProviderProfile(ctx, supported, "aih_server"); CodeOf(err) != CodeInvalidProfile {
		t.Fatalf("wrong profile error = %v", err)
	}
	unsupported := pickProvider(t, store.Catalog, false)
	if err := store.WriteProviderProfile(ctx, unsupported, ServerProfileID); CodeOf(err) != CodeInvalidProfile {
		t.Fatalf("unsupported provider error = %v", err)
	}
	if _, found, err := appstate.ReadKV(ctx, store.DatabasePath, ProviderDefaultKey(supported)); err != nil || found {
		t.Fatalf("app_kv row written: found=%v err=%v", found, err)
	}
}

// TestReadProviderProfileIgnoresForeignValues 值不是整档位标识时按未设置处理。
func TestReadProviderProfileIgnoresForeignValues(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	mustWriteKV(t, store.DatabasePath, ProviderDefaultKey(provider), `"aih_server"`)
	if profile, err := store.ReadProviderProfile(ctx, provider); err != nil || profile != "" {
		t.Fatalf("ReadProviderProfile() = %q, %v", profile, err)
	}
	mustWriteKV(t, store.DatabasePath, ProviderDefaultKey(provider), "{")
	if profile, err := store.ReadProviderProfile(ctx, provider); err != nil || profile != "" {
		t.Fatalf("corrupt profile = %q, %v", profile, err)
	}
}

// TestClearProviderProfile 删除后重复清理是幂等的。
func TestClearProviderProfile(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	provider := pickProvider(t, store.Catalog, true)
	if err := store.WriteProviderProfile(ctx, provider, ServerProfileID); err != nil {
		t.Fatalf("WriteProviderProfile() error = %v", err)
	}
	cleared, err := store.ClearProviderProfile(ctx, provider)
	if err != nil || !cleared {
		t.Fatalf("ClearProviderProfile() = %v, %v", cleared, err)
	}
	cleared, err = store.ClearProviderProfile(ctx, provider)
	if err != nil || cleared {
		t.Fatalf("second ClearProviderProfile() = %v, %v", cleared, err)
	}
	if _, found, err := appstate.ReadKV(ctx, store.DatabasePath, ProviderDefaultKey(provider)); err != nil || found {
		t.Fatalf("row survived clear: found=%v err=%v", found, err)
	}
}

func TestStoreRequiresDatabasePath(t *testing.T) {
	store := Store{Catalog: testCatalog(t)}
	provider := pickProvider(t, store.Catalog, true)
	if _, err := store.ReadProviderProfile(context.Background(), provider); CodeOf(err) != CodeScopeUnavailable {
		t.Fatalf("ReadProviderProfile() error = %v", err)
	}
	if err := store.WriteProviderProfile(context.Background(), provider, ServerProfileID); CodeOf(err) != CodeScopeUnavailable {
		t.Fatalf("WriteProviderProfile() error = %v", err)
	}
}

func TestResolveProviderNormalizesAndChecksCapability(t *testing.T) {
	store := Store{Catalog: testCatalog(t)}
	supported := pickProvider(t, store.Catalog, true)
	normalized, ok := store.ResolveProvider("  " + supported + " ")
	if !ok || normalized != supported {
		t.Fatalf("ResolveProvider(%q) = %q, %v", supported, normalized, ok)
	}
	if _, ok := store.ResolveProvider(pickProvider(t, store.Catalog, false)); ok {
		t.Fatal("ResolveProvider() accepted a provider without gateway_profile")
	}
}
