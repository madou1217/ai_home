package webuisetdefaultapi

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
)

type memoryProviderDefaultStore struct {
	values map[string]accountcore.ProviderDefault
}

func newMemoryProviderDefaultStore() *memoryProviderDefaultStore {
	return &memoryProviderDefaultStore{
		values: map[string]accountcore.ProviderDefault{},
	}
}

func (store *memoryProviderDefaultStore) GetProviderDefault(
	_ context.Context,
	providerID string,
) (accountcore.ProviderDefault, error) {
	value, found := store.values[providerID]
	if !found {
		return accountcore.ProviderDefault{}, accountapp.ErrProviderDefaultNotFound
	}
	return value, nil
}

func (store *memoryProviderDefaultStore) SetProviderDefault(
	_ context.Context,
	providerDefault accountcore.ProviderDefault,
) (accountcore.ProviderDefault, error) {
	store.values[providerDefault.ProviderID()] = providerDefault
	return providerDefault, nil
}

func (store *memoryProviderDefaultStore) ClearProviderDefault(
	_ context.Context,
	providerID string,
) error {
	delete(store.values, providerID)
	return nil
}

func mustAccountRef(t *testing.T, raw string) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(raw)
	if err != nil {
		t.Fatalf("ParseAccountRef(%q) error = %v", raw, err)
	}
	return ref
}

func newProviderDefaults(
	t *testing.T,
	store accountapp.ProviderDefaultStore,
) *accountapp.ProviderDefaults {
	t.Helper()
	defaults, err := accountapp.NewProviderDefaults(
		testCatalog(t),
		store,
		func() time.Time { return time.UnixMilli(1_800_000_000_000).UTC() },
	)
	if err != nil {
		t.Fatalf("NewProviderDefaults() error = %v", err)
	}
	return defaults
}

func TestProviderDefaultsAdapterFailsClosedWhenNil(t *testing.T) {
	adapter := NewProviderDefaultsAdapter(nil)
	if adapter.Available() {
		t.Fatal("nil 用例不应报告可用")
	}
	if _, err := adapter.Set(
		context.Background(), "codex", mustAccountRef(t, codexAccountRef),
	); !errors.Is(err, accountapp.ErrInvalidProviderDefaultDependencies) {
		t.Fatalf("Set() error = %v", err)
	}
	if err := adapter.Clear(context.Background(), "codex"); !errors.Is(
		err, accountapp.ErrInvalidProviderDefaultDependencies,
	) {
		t.Fatalf("Clear() error = %v", err)
	}
}

func TestProviderDefaultsAdapterDelegatesToApplicationLayer(t *testing.T) {
	store := newMemoryProviderDefaultStore()
	adapter := NewProviderDefaultsAdapter(newProviderDefaults(t, store))
	if !adapter.Available() {
		t.Fatal("已注入用例应报告可用")
	}
	accountRef := mustAccountRef(t, codexAccountRef)
	relation, err := adapter.Set(context.Background(), "codex", accountRef)
	if err != nil {
		t.Fatalf("Set() error = %v", err)
	}
	if relation.AccountRef().String() != accountRef.String() {
		t.Fatalf("relation = %+v", relation)
	}
	if _, found := store.values["codex"]; !found {
		t.Fatal("Set 必须写入应用层存储")
	}
	if err := adapter.Clear(context.Background(), "codex"); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if _, found := store.values["codex"]; found {
		t.Fatal("Clear 必须删除应用层默认关系")
	}
}

func TestServerDefaultsAdapterRoundTripsPointer(t *testing.T) {
	directory := seed(t)
	databasePath, err := appstate.DatabasePath(directory)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	adapter := NewServerDefaultsAdapter(aihdefault.Store{
		DatabasePath: databasePath,
		Catalog:      testCatalog(t),
	})
	if !adapter.Available() {
		t.Fatal("绑定数据库后应报告可用")
	}
	cleared, err := adapter.ClearProviderProfile(context.Background(), "codex")
	if err != nil {
		t.Fatalf("ClearProviderProfile() error = %v", err)
	}
	if cleared {
		t.Fatal("没有残留指针时应返回 false")
	}
	synced := false
	landed := adapter.LandOnServerDefault(
		context.Background(),
		"codex",
		func(context.Context, string) error {
			synced = true
			return nil
		},
	)
	if !landed.OK || !landed.Landed || !synced {
		t.Fatalf("LandOnServerDefault() = %+v synced=%v", landed, synced)
	}
	if value, found := readLanding(t, directory, "codex"); !found ||
		value != aihdefault.ServerProfileID {
		t.Fatalf("pointer = %q found=%v", value, found)
	}
}

func TestHostProjectionLeavesMissingCapabilitiesNil(t *testing.T) {
	projection := HostProjection{}
	if projection.Selector() != nil || projection.Gateway() != nil ||
		projection.GrantRevoker() != nil {
		t.Fatal("未注入回调时必须保持 nil，交给路由返回 501")
	}
	projection = HostProjection{
		SelectAccount: func(context.Context, string, accountcore.AccountRef) error {
			return nil
		},
	}
	if projection.Selector() == nil || projection.Gateway() != nil {
		t.Fatal("只应暴露已注入的能力")
	}
}

func TestHostFileProjectionWritesAccountAndGatewayConfigs(t *testing.T) {
	directory := t.TempDir()
	accountRef := mustAccountRef(t, codexAccountRef)
	projection := HostFileProjection{Targets: map[string]HostFileTarget{
		"codex": {
			Target: aihdefault.Target{
				Directory: directory,
				FileName:  "config.toml",
				Ownership: aihdefault.OwnershipFile,
			},
			BuildAccount: func(ref accountcore.AccountRef) aihdefault.BuildContent {
				return func(string, bool) (string, error) {
					return "account=" + ref.String(), nil
				}
			},
			BuildGateway: func(string, bool) (string, error) {
				return "gateway=true", nil
			},
		},
	}}
	if err := projection.SelectAccount(
		context.Background(), "codex", accountRef,
	); err != nil {
		t.Fatalf("SelectAccount() error = %v", err)
	}
	content, err := os.ReadFile(filepath.Join(directory, "config.toml"))
	if err != nil {
		t.Fatalf("read account config: %v", err)
	}
	if string(content) != "account="+accountRef.String() {
		t.Fatalf("account config = %q", content)
	}
	if _, err := os.Stat(filepath.Join(directory, aihdefault.ManagedStateFileName)); err != nil {
		t.Fatalf("managed state: %v", err)
	}
	if err := projection.LandGateway(context.Background(), "codex"); err != nil {
		t.Fatalf("LandGateway() error = %v", err)
	}
	content, err = os.ReadFile(filepath.Join(directory, "config.toml"))
	if err != nil {
		t.Fatalf("read gateway config: %v", err)
	}
	if string(content) != "gateway=true" {
		t.Fatalf("gateway config = %q", content)
	}
}

func TestHostFileProjectionReportsUnavailableForUnconfiguredProvider(t *testing.T) {
	projection := HostFileProjection{Targets: map[string]HostFileTarget{
		"codex": {Target: aihdefault.Target{Directory: t.TempDir(), FileName: "x"}},
	}}
	if err := projection.LandGateway(context.Background(), "codex"); aihdefault.CodeOf(
		err,
	) != aihdefault.CodeHostSyncUnavailable {
		t.Fatalf("LandGateway() error = %v", err)
	}
	if err := projection.SelectAccount(
		context.Background(), "gemini", mustAccountRef(t, geminiAccountRef),
	); aihdefault.CodeOf(err) != aihdefault.CodeHostSyncUnavailable {
		t.Fatalf("SelectAccount() error = %v", err)
	}
}

func TestBuildDependenciesWiresAdaptersEndToEnd(t *testing.T) {
	directory := seed(t)
	seedLanding(t, directory, "codex")
	accountRef := mustAccountRef(t, codexAccountRef)
	store := newMemoryProviderDefaultStore()
	selected := ""
	_, handler := newTestHandler(t, BuildDependencies(
		fakeAuthorizer{allowed: true},
		directory,
		testCatalog(t),
		newProviderDefaults(t, store),
		HostProjection{
			SelectAccount: func(
				_ context.Context,
				providerID string,
				ref accountcore.AccountRef,
			) error {
				selected = providerID + "/" + ref.String()
				return nil
			},
		},
	))

	recorder, _ := post(t, handler, Path+"/codex/"+accountRef.String()+"/set-default")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if selected != "codex/"+accountRef.String() {
		t.Fatalf("SelectAccount = %q", selected)
	}
	if _, found := store.values["codex"]; !found {
		t.Fatal("set-default 必须写入应用层默认关系")
	}
	if _, found := readLanding(t, directory, "codex"); found {
		t.Fatal("set-default 必须撤掉残留落点指针")
	}
}

func TestClearDefaultKeeps501WhenFileProjectionUnconfigured(t *testing.T) {
	directory := seed(t)
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir: directory,
		Defaults: &fakeDefaults{
			now: time.UnixMilli(1_800_000_000_000).UTC(),
		},
		HostGate: HostFileProjection{Targets: map[string]HostFileTarget{}},
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/clear-default")
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "host_projection_unavailable" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if _, found := readLanding(t, directory, "codex"); found {
		t.Fatal("宿主投影不可用时不能记落点档位")
	}
}

func TestSetDefaultTypedNilAdapterFailsClosed(t *testing.T) {
	directory := seed(t)
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir: directory,
		Defaults:  NewProviderDefaultsAdapter(nil),
		HostSelector: HostSelectorFunc(func(context.Context, string, accountcore.AccountRef) error {
			return nil
		}),
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/set-default")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "default_provider_unavailable" {
		t.Fatalf("error = %v", decoded["error"])
	}
}
