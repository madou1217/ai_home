package webuiaccountliveapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
	_ "modernc.org/sqlite"
)

func seedLiveTestDatabases(
	t *testing.T,
	aiHomeDir string,
	codexRef string,
	claudeRef string,
	kimiRef string,
	kiroBuilderRef string,
	kiroIdcRef string,
	kiroGoogleRef string,
) {
	t.Helper()

	// 1. Codex Desktop 绑定状态（isMobile）
	codexStateDir := filepath.Join(aiHomeDir, "run", "codex")
	if err := os.MkdirAll(codexStateDir, 0o755); err != nil {
		t.Fatalf("mkdir codex state: %v", err)
	}
	hookPayload, err := json.Marshal(map[string]any{"desktopAccountRef": codexRef})
	if err != nil {
		t.Fatalf("marshal codex hook state: %v", err)
	}
	if err := os.WriteFile(filepath.Join(codexStateDir, "desktop-hook-state.json"), hookPayload, 0o600); err != nil {
		t.Fatalf("write codex hook state: %v", err)
	}

	// 2. Kimi 桌面端区域（region）
	kimiStoreDir := filepath.Join(
		aiHomeDir, "run", "auth-projections", "kimi", kimiRef,
		"electron-user-data", "bridge-store",
	)
	if err := os.MkdirAll(kimiStoreDir, 0o755); err != nil {
		t.Fatalf("mkdir kimi region dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(kimiStoreDir, "region.json"), []byte(`{"lastEffective":"OVERSEAS"}`), 0o600); err != nil {
		t.Fatalf("write kimi region.json: %v", err)
	}

	// 3. app-state.db（aliasPoolParticipates + upstreamErrorRules + upstreamErrorGroupIds）
	appStatePath := filepath.Join(aiHomeDir, "app-state.db")
	if err := os.MkdirAll(filepath.Dir(appStatePath), 0o755); err != nil {
		t.Fatalf("mkdir app-state dir: %v", err)
	}
	appDB, err := sql.Open("sqlite", appStatePath)
	if err != nil {
		t.Fatalf("open app-state.db: %v", err)
	}
	defer func() { _ = appDB.Close() }()
	for _, stmt := range []string{
		`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE account_credentials (account_ref TEXT PRIMARY KEY, env_json TEXT NOT NULL DEFAULT '{}', native_auth_json TEXT NOT NULL DEFAULT '{}', env_updated_at INTEGER NOT NULL DEFAULT 0, native_auth_updated_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
	} {
		if _, err := appDB.Exec(stmt); err != nil {
			t.Fatalf("create app-state table: %v", err)
		}
	}
	if _, err := appDB.Exec(
		`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, 1)`,
		aliasPoolKeyPrefix+codexRef, `{"participates":false}`,
	); err != nil {
		t.Fatalf("insert alias pool kv: %v", err)
	}
	rulesPayload, _ := json.Marshal([]map[string]any{{"status": 429, "action": "cooldown"}})
	groupsPayload, _ := json.Marshal([]string{"grp-a", "grp-b"})
	envPayload, _ := json.Marshal(map[string]any{
		rulesenv.RulesEnvKey:    string(rulesPayload),
		rulesenv.GroupIDsEnvKey: string(groupsPayload),
	})
	if _, err := appDB.Exec(
		`INSERT INTO account_credentials (account_ref, env_json, updated_at) VALUES (?, ?, 1)`,
		claudeRef, string(envPayload),
	); err != nil {
		t.Fatalf("insert app-state rules: %v", err)
	}

	// 4. aih.db（kiro loginType）
	aihDBPath := filepath.Join(aiHomeDir, "aih.db")
	aihDB, err := sql.Open("sqlite", aihDBPath)
	if err != nil {
		t.Fatalf("open aih.db: %v", err)
	}
	defer func() { _ = aihDB.Close() }()
	for _, stmt := range []string{
		`CREATE TABLE accounts (account_ref TEXT PRIMARY KEY, provider_id TEXT NOT NULL)`,
		`CREATE TABLE account_credentials (account_ref TEXT PRIMARY KEY, credential_json TEXT NOT NULL)`,
	} {
		if _, err := aihDB.Exec(stmt); err != nil {
			t.Fatalf("create aih.db table: %v", err)
		}
	}
	kiroFixtures := []struct {
		ref    string
		native map[string]any
	}{
		{
			ref: kiroBuilderRef,
			native: map[string]any{
				"flavor":       "oidc",
				"registration": map[string]any{"clientId": "cid", "clientSecret": "csec"},
				"auth":         map[string]any{},
			},
		},
		{
			ref: kiroIdcRef,
			native: map[string]any{
				"flavor": "oidc",
				"auth":   map[string]any{"start_url": "https://d-123456.awsapps.com/start"},
			},
		},
		{
			ref: kiroGoogleRef,
			native: map[string]any{
				"flavor": "desktop",
				"auth":   map[string]any{"provider": "Google"},
			},
		},
	}
	for _, item := range kiroFixtures {
		if _, err := aihDB.Exec(`INSERT INTO accounts (account_ref, provider_id) VALUES (?, 'kiro')`, item.ref); err != nil {
			t.Fatalf("insert aih account: %v", err)
		}
		credJSON, _ := json.Marshal(map[string]any{"native_auth_json": item.native})
		if _, err := aihDB.Exec(`INSERT INTO account_credentials (account_ref, credential_json) VALUES (?, ?)`, item.ref, string(credJSON)); err != nil {
			t.Fatalf("insert aih cred: %v", err)
		}
	}
}

func newLiveTestHandler(t *testing.T, auth fakeAuthorizer, rows *fakeRows, aiHomeDir string) *Handler {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog: %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: auth,
		Rows:       rows,
		Catalog:    catalog,
		AIHomeDir:  aiHomeDir,
		Now:        time.Now,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	t.Cleanup(handler.Close)
	return handler
}

func TestServeLiveHTTPAuthMethodAndErrors(t *testing.T) {
	rows := &fakeRows{}
	unauthHandler := newLiveTestHandler(t, fakeAuthorizer{allowed: false}, rows, t.TempDir())

	unauthReq := httptest.NewRequest(http.MethodGet, LivePath, nil)
	unauthRec := httptest.NewRecorder()
	unauthHandler.ServeLiveHTTP(unauthRec, unauthReq)
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthorized request, got %d", unauthRec.Code)
	}
	if unauthRec.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("expected Bearer challenge, got %q", unauthRec.Header().Get("WWW-Authenticate"))
	}

	authHandler := newLiveTestHandler(t, fakeAuthorizer{allowed: true}, rows, t.TempDir())
	postReq := httptest.NewRequest(http.MethodPost, LivePath, nil)
	postRec := httptest.NewRecorder()
	authHandler.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for POST on live endpoint, got %d", postRec.Code)
	}
	if postRec.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("expected Allow GET, got %q", postRec.Header().Get("Allow"))
	}

	rows.err = errors.New("db offline")
	errReq := httptest.NewRequest(http.MethodGet, LivePath, nil)
	errRec := httptest.NewRecorder()
	authHandler.ServeLiveHTTP(errRec, errReq)
	if errRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when source fails, got %d", errRec.Code)
	}
}

func TestServeLiveHTTPEnrichesFieldsFiltersAndReflectsChangesImmediately(t *testing.T) {
	aiHomeDir := t.TempDir()
	codexRef := testRef("1")
	claudeRef := testRef("2")
	qoderRef := testRef("3")
	kimiRef := testRef("4")
	kiroBuilderRef := testRef("5")
	kiroIdcRef := testRef("6")
	kiroGoogleRef := testRef("7")

	seedLiveTestDatabases(t, aiHomeDir, codexRef, claudeRef, kimiRef, kiroBuilderRef, kiroIdcRef, kiroGoogleRef)

	rows := &fakeRows{
		rows: []webuiaccountsapi.Row{
			{
				Provider:    "codex",
				AccountRef:  codexRef,
				Enabled:     true,
				Configured:  true,
				DisplayName: "codex-desktop",
				UsageSnapshot: map[string]any{
					"account": map[string]any{"planName": "ChatGPT Pro"},
				},
			},
			{
				Provider:    "claude",
				AccountRef:  claudeRef,
				Enabled:     true,
				Configured:  true,
				APIKeyMode:  true,
				BaseURL:     "https://relay.example.com/v1",
				DisplayName: "claude-custom",
			},
			{
				Provider:    "qoder",
				AccountRef:  qoderRef,
				Enabled:     true,
				Configured:  true,
				APIKeyMode:  true,
				BaseURL:     "https://api.anthropic.com",
				DisplayName: "qoder-activity",
			},
			{
				Provider:    "kimi",
				AccountRef:  kimiRef,
				Enabled:     true,
				Configured:  true,
				DisplayName: "kimi-overseas",
			},
			{
				Provider:    "kiro",
				AccountRef:  kiroBuilderRef,
				Enabled:     true,
				Configured:  true,
				DisplayName: "kiro-builder",
			},
			{
				Provider:    "kiro",
				AccountRef:  kiroIdcRef,
				Enabled:     true,
				Configured:  true,
				DisplayName: "kiro-idc",
			},
			{
				Provider:    "kiro",
				AccountRef:  kiroGoogleRef,
				Enabled:     true,
				Configured:  true,
				DisplayName: "kiro-google",
			},
		},
	}

	handler := newLiveTestHandler(t, fakeAuthorizer{allowed: true}, rows, aiHomeDir)

	req := httptest.NewRequest(http.MethodGet, LivePath, nil)
	rec := httptest.NewRecorder()
	handler.ServeLiveHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var payload struct {
		OK                         bool                       `json:"ok"`
		Accounts                   []webuiaccountsapi.Row     `json:"accounts"`
		Revision                   int64                      `json:"revision"`
		Hydrating                  bool                       `json:"hydrating"`
		ProviderNativeCapabilities map[string]json.RawMessage `json:"providerNativeCapabilities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal live response: %v", err)
	}
	if !payload.OK || payload.Hydrating {
		t.Fatalf("unexpected live metadata: ok=%v hydrating=%v", payload.OK, payload.Hydrating)
	}
	if len(payload.ProviderNativeCapabilities) == 0 {
		t.Fatalf("expected providerNativeCapabilities populated from Catalog")
	}

	byRef := make(map[string]webuiaccountsapi.Row, len(payload.Accounts))
	for _, item := range payload.Accounts {
		byRef[item.AccountRef] = item
	}

	codexRow := byRef[codexRef]
	if !codexRow.IsMobile {
		t.Fatalf("expected codex IsMobile=true")
	}
	if codexRow.AliasPoolParticipates {
		t.Fatalf("expected codex AliasPoolParticipates=false from app_kv")
	}
	if codexRow.PlanName != "ChatGPT Pro" {
		t.Fatalf("expected codex PlanName='ChatGPT Pro', got %q", codexRow.PlanName)
	}
	if !codexRow.WindowActivationSupported {
		t.Fatalf("expected codex WindowActivationSupported=true")
	}
	if !codexRow.GatewayTargetSupported {
		t.Fatalf("expected codex GatewayTargetSupported=true")
	}
	if len(codexRow.UpstreamErrorRules) != 0 || len(codexRow.UpstreamErrorGroupIDs) != 0 {
		t.Fatalf("expected empty non-nil slices for codex rules/groups")
	}

	claudeRow := byRef[claudeRef]
	if !claudeRow.CustomUpstream {
		t.Fatalf("expected claude custom baseUrl CustomUpstream=true")
	}
	if !claudeRow.AliasPoolParticipates {
		t.Fatalf("expected default AliasPoolParticipates=true")
	}
	if len(claudeRow.UpstreamErrorRules) != 1 || len(claudeRow.UpstreamErrorGroupIDs) != 2 {
		t.Fatalf("expected claude UpstreamErrorRules(1) and GroupIDs(2), got rules=%v groups=%v", claudeRow.UpstreamErrorRules, claudeRow.UpstreamErrorGroupIDs)
	}

	qoderRow := byRef[qoderRef]
	if len(qoderRow.ActivityActions) == 0 {
		t.Fatalf("expected qoder ActivityActions populated from builtin catalog")
	}
	if qoderRow.CustomUpstream {
		t.Fatalf("expected qoder with no official upstream host list to have CustomUpstream=false")
	}

	if got := byRef[kimiRef].Region; got != "overseas" {
		t.Fatalf("expected kimi Region='overseas', got %q", got)
	}
	if got := byRef[kiroBuilderRef].LoginType; got != "builder" {
		t.Fatalf("expected kiro builder LoginType='builder', got %q", got)
	}
	if got := byRef[kiroIdcRef].LoginType; got != "idc" {
		t.Fatalf("expected kiro idc LoginType='idc', got %q", got)
	}
	if got := byRef[kiroGoogleRef].LoginType; got != "google" {
		t.Fatalf("expected kiro google LoginType='google', got %q", got)
	}

	// 测试 ?provider= 和 ?ref= 过滤
	filterReq := httptest.NewRequest(http.MethodGet, LivePath+"?provider=KIRO&ref="+kiroIdcRef, nil)
	filterRec := httptest.NewRecorder()
	handler.ServeLiveHTTP(filterRec, filterReq)
	if filterRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for filtered live request, got %d", filterRec.Code)
	}
	var filteredPayload struct {
		Accounts []webuiaccountsapi.Row `json:"accounts"`
	}
	if err := json.Unmarshal(filterRec.Body.Bytes(), &filteredPayload); err != nil {
		t.Fatalf("unmarshal filtered response: %v", err)
	}
	if len(filteredPayload.Accounts) != 1 || filteredPayload.Accounts[0].AccountRef != kiroIdcRef {
		t.Fatalf("expected 1 filtered kiro account %s, got %+v", kiroIdcRef, filteredPayload.Accounts)
	}

	// 验证底层行变化立即体现在下一次 live 查询，并且已建立 watch 快照时 revision 递增。
	if _, _, err := handler.hub.ensureSnapshot(context.Background()); err != nil {
		t.Fatalf("ensureSnapshot: %v", err)
	}
	beforeRev := handler.hub.revision
	rows.rows[0].DisplayName = "codex-renamed"

	freshReq := httptest.NewRequest(http.MethodGet, LivePath+"?ref="+codexRef, nil)
	freshRec := httptest.NewRecorder()
	handler.ServeLiveHTTP(freshRec, freshReq)
	if freshRec.Code != http.StatusOK {
		t.Fatalf("expected 200 after mutation, got %d", freshRec.Code)
	}
	var freshPayload struct {
		Accounts []webuiaccountsapi.Row `json:"accounts"`
		Revision int64                  `json:"revision"`
	}
	if err := json.Unmarshal(freshRec.Body.Bytes(), &freshPayload); err != nil {
		t.Fatalf("unmarshal fresh response: %v", err)
	}
	if len(freshPayload.Accounts) != 1 || freshPayload.Accounts[0].DisplayName != "codex-renamed" {
		t.Fatalf("expected updated DisplayName immediately, got %+v", freshPayload.Accounts)
	}
	if freshPayload.Revision <= beforeRev {
		t.Fatalf("expected revision to advance on live change (before=%d after=%d)", beforeRev, freshPayload.Revision)
	}
}
