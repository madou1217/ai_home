package deletionhost

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
)

const testAccountRef = "acct_0123456789abcdef0123"

func testCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func testAccount(t *testing.T, providerID string) accountcore.Account {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(testAccountRef)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(testCatalog(t), accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   providerID,
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

func writeKV(t *testing.T, aiHomeDir string, key string, value string) {
	t.Helper()
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	if err := appstate.WriteKV(context.Background(), path, key, value, 1); err != nil {
		t.Fatalf("WriteKV(%s) error = %v", key, err)
	}
}

func readKV(t *testing.T, aiHomeDir string, key string) (string, bool) {
	t.Helper()
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	value, found, err := appstate.ReadKV(context.Background(), path, key)
	if err != nil {
		t.Fatalf("ReadKV(%s) error = %v", key, err)
	}
	return value, found
}

func newService(t *testing.T, options Options) *Service {
	t.Helper()
	if options.AIHomeDir == "" {
		options.AIHomeDir = t.TempDir()
	}
	if options.Catalog == nil {
		options.Catalog = testCatalog(t)
	}
	service, err := New(options)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return service
}

func quotedRef() string {
	return "\"" + testAccountRef + "\""
}

// TestIsDefaultAccountReadsNodePointer 守住口径：读的是 Node 的 app_kv 指针。
func TestIsDefaultAccountReadsNodePointer(t *testing.T) {
	aiHome := t.TempDir()
	writeKV(t, aiHome, "account:default:codex", quotedRef())
	service := newService(t, Options{AIHomeDir: aiHome})

	ref, err := accountcore.ParseAccountRef(testAccountRef)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	isDefault, err := service.IsDefaultAccount(context.Background(), "codex", ref)
	if err != nil || !isDefault {
		t.Fatalf("IsDefaultAccount() = %v, %v", isDefault, err)
	}
	other, err := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	isDefault, err = service.IsDefaultAccount(context.Background(), "codex", other)
	if err != nil || isDefault {
		t.Fatalf("IsDefaultAccount(other) = %v, %v", isDefault, err)
	}
}

// TestLandServerDefaultReportsHostSyncUnavailable 守住不变量：宿主文件没写成功
// 之前绝不写档位，避免留下「档位说 AIH Server、宿主指向账号直连」的错配。
func TestLandServerDefaultReportsHostSyncUnavailable(t *testing.T) {
	aiHome := t.TempDir()
	service := newService(t, Options{AIHomeDir: aiHome})

	landing, err := service.LandServerDefault(context.Background(), "codex")
	if err != nil {
		t.Fatalf("LandServerDefault() error = %v", err)
	}
	if landing.OK || landing.Landed || landing.Reason != aihdefault.CodeHostSyncUnavailable {
		t.Fatalf("landing = %+v", landing)
	}
	if _, found := readKV(t, aiHome, "provider:default:codex"); found {
		t.Fatal("宿主同步没成功就不能写档位")
	}
}

// TestLandServerDefaultWritesProfileAfterHostSync 守住正常落点顺序。
func TestLandServerDefaultWritesProfileAfterHostSync(t *testing.T) {
	aiHome := t.TempDir()
	synced := 0
	service := newService(t, Options{
		AIHomeDir: aiHome,
		GatewaySync: func(context.Context, string) error {
			synced++
			return nil
		},
	})
	landing, err := service.LandServerDefault(context.Background(), "codex")
	if err != nil {
		t.Fatalf("LandServerDefault() error = %v", err)
	}
	if !landing.OK || !landing.Landed || landing.Profile != aihdefault.ServerProfileID {
		t.Fatalf("landing = %+v", landing)
	}
	if synced != 1 {
		t.Fatalf("synced = %d", synced)
	}
	if _, found := readKV(t, aiHome, "provider:default:codex"); !found {
		t.Fatal("宿主同步成功后必须写档位")
	}
}

// TestRevokeHostGrantSkipsProvidersWithoutHook 守住「没有这个概念的 Provider
// 什么都不做」（Node 对它们返回 null，而不是伪造一次空的回收）。
func TestRevokeHostGrantSkipsProvidersWithoutHook(t *testing.T) {
	service := newService(t, Options{AIHomeDir: t.TempDir()})

	revocation, err := service.RevokeHostGrant(context.Background(), testAccount(t, "claude"))
	if err != nil {
		t.Fatalf("RevokeHostGrant() error = %v", err)
	}
	if revocation.Revoked || revocation.Reason != ReasonGrantRevokeUnavailable {
		t.Fatalf("revocation = %+v", revocation)
	}
}

// TestRevokeHostGrantNoGrantLeavesHostUntouched 守住「没有授权就零写入」：
// 正常网关档账号删除不应该去改宿主文件。
func TestRevokeHostGrantNoGrantLeavesHostUntouched(t *testing.T) {
	service := newService(t, Options{AIHomeDir: t.TempDir(), HostHomeDir: t.TempDir()})

	revocation, err := service.RevokeHostGrant(context.Background(), testAccount(t, "codex"))
	if err != nil {
		t.Fatalf("RevokeHostGrant() error = %v", err)
	}
	if !revocation.OK || revocation.Revoked || revocation.Reason != ReasonNoHostGrant {
		t.Fatalf("revocation = %+v", revocation)
	}
}

// TestRevokeHostGrantDetectsPinAndRefusesWithoutHostSync 守住两条判据：
// 受管段里的账号钉选能被认出来；宿主同步端口缺失时失败关闭，绝不假装回收。
func TestRevokeHostGrantDetectsPinAndRefusesWithoutHostSync(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	// 与 Node 的受管段同形：钉选是主表里的 inline http_headers，位于 .auth 子表之前。
	writeHostConfig(t, hostHome, "model_provider = \"aih_server\"\n\n[model_providers.aih_server]\nname = \"AIH Server\"\nhttp_headers = { \"X-Account-Ref\" = \""+testAccountRef+"\" }\n\n[model_providers.aih_server.auth]\ncommand = \"node\"\n")
	service := newService(t, Options{AIHomeDir: aiHome, HostHomeDir: hostHome})

	revocation, err := service.RevokeHostGrant(context.Background(), testAccount(t, "codex"))
	if err != nil {
		t.Fatalf("RevokeHostGrant() error = %v", err)
	}
	if revocation.OK || revocation.Revoked || revocation.Reason != ReasonHostSyncUnavailable {
		t.Fatalf("revocation = %+v", revocation)
	}
}

// TestRevokeHostGrantLandsGatewayAndClearsPointer 守住回收链的完整效果：
// 宿主切网关档 → 清默认账号指针 → 记档位。
func TestRevokeHostGrantLandsGatewayAndClearsPointer(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	writeHostConfig(t, hostHome, "[model_providers.aih_server]\nhttp_headers = { \"X-Account-Ref\" = \""+testAccountRef+"\" }\n")
	writeKV(t, aiHome, "account:default:codex", quotedRef())
	synced := 0
	service := newService(t, Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		GatewaySync: func(context.Context, string) error {
			synced++
			return nil
		},
	})

	revocation, err := service.RevokeHostGrant(context.Background(), testAccount(t, "codex"))
	if err != nil {
		t.Fatalf("RevokeHostGrant() error = %v", err)
	}
	if !revocation.OK || !revocation.Revoked || !revocation.DefaultProfileUpdated {
		t.Fatalf("revocation = %+v", revocation)
	}
	if synced != 1 {
		t.Fatalf("synced = %d", synced)
	}
	if _, found := readKV(t, aiHome, "account:default:codex"); found {
		t.Fatal("回收授权时必须清掉指向本账号的默认指针")
	}
	value, found := readKV(t, aiHome, "provider:default:codex")
	if !found || unquote(value) != aihdefault.ServerProfileID {
		t.Fatalf("档位 = %q/%v", value, found)
	}
}

func writeHostConfig(t *testing.T, hostHome string, content string) {
	t.Helper()
	directory := filepath.Join(hostHome, ".codex")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "config.toml"), []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
}

var _ accountapp.DeletionHostGrant = (*Service)(nil)
