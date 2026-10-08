package aihserver_test

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
)

// TestServerRestoresPersistedModelCooldownAtStartup 验证组合根把 aih.db 里持久化的
// 账号模型冷却装进运行态，并通过管理接口原样暴露。
//
// 这是「重启后不会立刻重试刚被限流的模型」的端到端证据：真实 SQLite、真实组合根、
// 真实 TCP 管理接口，缺任何一环这条断言都不会通过。
func TestServerRestoresPersistedModelCooldownAtStartup(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	aiHomeDir := t.TempDir()
	seededAt := time.Now().UTC().Truncate(time.Millisecond)
	cooldownUntil := seededAt.Add(10 * time.Minute)

	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	credential, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-synthetic-runtime-state-access",
		RefreshToken: "sk-ant-ort01-synthetic-runtime-state-refresh",
		ExpiresAtMS:  seededAt.Add(time.Hour).UnixMilli(),
		Scopes:       []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174999",
		},
	})
	if err != nil {
		t.Fatalf("claudeauth.NewOAuthAuth() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    seededAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	registration, err := accountapp.NewRegistration(account, credential, seededAt)
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if err := store.Register(ctx, registration); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(account.Ref(), "claude-opus-5")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	if err := store.SaveModelState(ctx, runtimeapp.PersistedModelState{
		Route: route,
		State: runtimecore.ModelStateSnapshot{
			CooldownKind:  runtimecore.FailureRateLimited,
			CooldownUntil: cooldownUntil,
			LastFailureAt: seededAt,
		},
	}); err != nil {
		t.Fatalf("SaveModelState() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	baseURL, client := startTestServerAt(t, aiHomeDir)
	response := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+"/v1/management/account-runtime",
		testManagementKey,
		nil,
	)
	assertStatus(t, response, http.StatusOK)
	for _, required := range []string{
		`"account_ref":"` + account.Ref().String() + `"`,
		`"model":"claude-opus-5"`,
		`"cooldown_kind":"rate_limited"`,
		`"cooldown_until_ms":` + formatUnixMilli(cooldownUntil),
	} {
		if !strings.Contains(response.body, required) {
			t.Fatalf(
				"运行态快照缺少 %s: %s",
				required,
				response.body,
			)
		}
	}
}

// startTestServerAt 在指定 aih.db 目录上启动真实 Listener，并注册有界关闭清理。
func startTestServerAt(t *testing.T, aiHomeDir string) (string, *http.Client) {
	t.Helper()

	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:           aiHomeDir,
		ManagementKey:       func() string { return testManagementKey },
		ClientKey:           func() string { return testClientKey },
		ModelDiscoverers:    accountmodels.NewDiscoverers(),
		UsageHTTPClient:     syntheticUsageHTTPClient{},
		InferenceHTTPClient: nil,
	})
	if err != nil {
		t.Fatalf("aihserver.New() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		t.Fatalf("net.Listen() error = %v", err)
	}
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("Server.Shutdown() error = %v", err)
		}
		if err := <-serveErrors; err != nil {
			t.Errorf("Server.Serve() error = %v", err)
		}
		if err := server.Close(); err != nil {
			t.Errorf("Server.Close() error = %v", err)
		}
	})
	return "http://" + listener.Addr().String(), &http.Client{
		Timeout: 5 * time.Second,
	}
}

// formatUnixMilli 把 UTC 时间格式化为运行态接口使用的毫秒整数。
func formatUnixMilli(value time.Time) string {
	return strconv.FormatInt(value.UnixMilli(), 10)
}
