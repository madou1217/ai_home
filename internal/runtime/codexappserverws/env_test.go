package codexappserverws

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
)

type stubGoAccountStore struct {
	def  accountcore.ProviderDefault
	cred accountapp.Credential
	err  error
}

func (s stubGoAccountStore) GetProviderDefault(_ context.Context, _ string) (accountcore.ProviderDefault, error) {
	if s.err != nil {
		return accountcore.ProviderDefault{}, s.err
	}
	return s.def, nil
}

func (s stubGoAccountStore) GetCredential(_ context.Context, _ accountcore.AccountRef) (accountapp.Credential, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.cred, nil
}

func envSliceToLookup(entries []string) map[string]string {
	out := make(map[string]string, len(entries))
	for _, entry := range entries {
		k, v, ok := strings.Cut(entry, "=")
		if ok {
			out[k] = v
		}
	}
	return out
}

func createTestAppStateDB(t *testing.T, aiHomeDir string, sqlStatements ...string) {
	t.Helper()
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	schema := `
		CREATE TABLE IF NOT EXISTS app_kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS account_refs (
			account_ref TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			account_id TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE IF NOT EXISTS account_credentials (
			account_ref TEXT PRIMARY KEY,
			env_json TEXT NOT NULL DEFAULT '{}',
			native_auth_json TEXT NOT NULL DEFAULT '{}'
		);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range sqlStatements {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("执行测试 SQL 失败 (%s): %v", stmt, err)
		}
	}
}

func TestBuildSpawnEnvManagedLaunch(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	aiHome := filepath.Join(root, "ai")
	hostHome := filepath.Join(root, "host")
	createTestAppStateDB(t, aiHome,
		`INSERT INTO app_kv (key, value) VALUES ('provider:default:codex', '".aih-server"')`,
	)

	env, err := BuildSpawnEnv(context.Background(), SpawnEnvOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		BaseEnv: []string{
			"AIH_CODEX_FLAGS=managedLaunch=1,authPreflight=0",
			"OPENAI_API_KEY=sk-managed",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := envSliceToLookup(env)
	if got["OPENAI_API_KEY"] != "sk-managed" {
		t.Fatalf("managedLaunch=1 时应保留外部注入 API Key, 实际 %q", got["OPENAI_API_KEY"])
	}
	if _, exists := got["AIH_CODEX_GATEWAY_ACCOUNT_REF"]; exists {
		t.Fatalf("managedLaunch=1 时不应注入 gateway account ref")
	}
	flags := ParseCodexFlags(got[CodexFlagsEnv])
	if flags["managedLaunch"] != "" || flags["authPreflight"] != "0" || flags["remoteProxy"] != "1" {
		t.Fatalf("AIH_CODEX_FLAGS 状态异常: %+v", flags)
	}
	if got["HOME"] != hostHome || got["CODEX_HOME"] != filepath.Join(hostHome, ".codex") ||
		got[codexhooks.CodexAppServerPassthroughEnv] != "1" {
		t.Fatalf("HostHomeDir 或直通变量注入异常: %+v", got)
	}
}

func TestBuildSpawnEnvAihServerGateway(t *testing.T) {
	t.Parallel()
	for _, profileJSON := range []string{`".aih-server"`, `"aih-server"`} {
		t.Run(profileJSON, func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			aiHome := filepath.Join(root, "ai")
			createTestAppStateDB(t, aiHome,
				`INSERT INTO app_kv (key, value) VALUES ('provider:default:codex', '`+profileJSON+`')`,
				`INSERT INTO app_kv (key, value) VALUES ('config:server', '{"host":"0.0.0.0","port":19527,"apiKey":"gw-secret"}')`,
			)
			env, err := BuildSpawnEnv(context.Background(), SpawnEnvOptions{
				AIHomeDir: aiHome,
				BaseEnv: []string{
					"AIH_CODEX_GATEWAY_ACCOUNT_REF=stale-ref",
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			got := envSliceToLookup(env)
			if got["OPENAI_BASE_URL"] != "http://127.0.0.1:19527/v1" || got["OPENAI_API_KEY"] != "gw-secret" {
				t.Fatalf("网关环境注入异常: %+v", got)
			}
			if val, exists := got["AIH_CODEX_GATEWAY_ACCOUNT_REF"]; !exists || val != "" {
				t.Fatalf("应显式将 AIH_CODEX_GATEWAY_ACCOUNT_REF 置为空串, 实际 exists=%v val=%q", exists, val)
			}
		})
	}
}

func TestBuildSpawnEnvDefaultAccountAPIKeyAndOAuth(t *testing.T) {
	t.Parallel()

	t.Run("APIKey默认账号注入并清理远程冲突变量", func(t *testing.T) {
		t.Parallel()
		aiHome := filepath.Join(t.TempDir(), "ai")
		createTestAppStateDB(t, aiHome,
			`INSERT INTO app_kv (key, value) VALUES ('account:default:codex', '"acct_key_1"')`,
			`INSERT INTO account_refs (account_ref, provider, account_id) VALUES ('acct_key_1', 'codex', 'k1')`,
			`INSERT INTO account_credentials (account_ref, env_json, native_auth_json) VALUES ('acct_key_1', '{"OPENAI_API_KEY":"sk-acct-1"}', '{}')`,
		)
		env, err := BuildSpawnEnv(context.Background(), SpawnEnvOptions{
			AIHomeDir: aiHome,
			BaseEnv: []string{
				"AIH_CODEX_GATEWAY_ACCOUNT_REF=old",
				"AIH_CODEX_REMOTE_AUTH_TOKEN=tok-old",
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		got := envSliceToLookup(env)
		if got["OPENAI_API_KEY"] != "sk-acct-1" || got["OPENAI_BASE_URL"] != defaultCodexAPIBaseURL {
			t.Fatalf("API Key 默认账号环境变量异常: %+v", got)
		}
		if _, ok := got["AIH_CODEX_GATEWAY_ACCOUNT_REF"]; ok {
			t.Fatal("应清理 AIH_CODEX_GATEWAY_ACCOUNT_REF")
		}
		if _, ok := got["AIH_CODEX_REMOTE_AUTH_TOKEN"]; ok {
			t.Fatal("应清理 AIH_CODEX_REMOTE_AUTH_TOKEN")
		}
	})

	t.Run("OAuth默认账号清理冲突APIKey环境变量", func(t *testing.T) {
		t.Parallel()
		aiHome := filepath.Join(t.TempDir(), "ai")
		createTestAppStateDB(t, aiHome,
			`INSERT INTO app_kv (key, value) VALUES ('account:default:codex', '"acct_oauth_1"')`,
			`INSERT INTO account_refs (account_ref, provider, account_id) VALUES ('acct_oauth_1', 'codex', 'o1')`,
			`INSERT INTO account_credentials (account_ref, env_json, native_auth_json) VALUES ('acct_oauth_1', '{}', '{"tokens":{"access_token":"jwt"}}')`,
		)
		env, err := BuildSpawnEnv(context.Background(), SpawnEnvOptions{
			AIHomeDir: aiHome,
			BaseEnv: []string{
				"OPENAI_API_KEY=sk-shell-leak",
				"OPENAI_BASE_URL=http://127.0.0.1:9527/v1",
				"AIH_CODEX_GATEWAY_ACCOUNT_REF=stale",
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		got := envSliceToLookup(env)
		for _, cleared := range []string{"OPENAI_API_KEY", "OPENAI_BASE_URL", "AIH_CODEX_GATEWAY_ACCOUNT_REF"} {
			if _, exists := got[cleared]; exists {
				t.Fatalf("OAuth 默认账号应删除 %s, 实际 %q", cleared, got[cleared])
			}
		}
	})

	t.Run("app_state无默认账号时回落Go_AccountStore", func(t *testing.T) {
		t.Parallel()
		ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
		if err != nil {
			t.Fatal(err)
		}
		def, err := accountcore.NewProviderDefault("codex", ref, time.UnixMilli(1700000000000))
		if err != nil {
			t.Fatal(err)
		}
		cred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
			APIKey:  "sk-go-store",
			BaseURL: "https://custom.example/v1",
		})
		if err != nil {
			t.Fatal(err)
		}
		env, err := BuildSpawnEnv(context.Background(), SpawnEnvOptions{
			AIHomeDir:    t.TempDir(),
			AccountStore: stubGoAccountStore{def: def, cred: cred},
		})
		if err != nil {
			t.Fatal(err)
		}
		got := envSliceToLookup(env)
		if got["OPENAI_API_KEY"] != "sk-go-store" || got["OPENAI_BASE_URL"] != "https://custom.example/v1" {
			t.Fatalf("Go AccountStore 回落异常: %+v", got)
		}

		env2, err := BuildSpawnEnv(context.Background(), SpawnEnvOptions{
			AIHomeDir:    t.TempDir(),
			AccountStore: stubGoAccountStore{err: errors.New("not found")},
			BaseEnv:      []string{"OPENAI_API_KEY=sk-pass"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if envSliceToLookup(env2)["OPENAI_API_KEY"] != "sk-pass" {
			t.Fatalf("无默认账号应透传")
		}
	})
}
