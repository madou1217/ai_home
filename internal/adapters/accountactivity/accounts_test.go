package accountactivity

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func createTestAihDB(t *testing.T, aiHomeDir string) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(aiHomeDir, "aih.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open aih.db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS accounts (
			account_ref TEXT PRIMARY KEY,
			provider_id TEXT NOT NULL,
			cli_account_id TEXT NOT NULL DEFAULT '',
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at_ms INTEGER NOT NULL DEFAULT 0,
			updated_at_ms INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS account_credentials (
			account_ref TEXT PRIMARY KEY,
			credential_json TEXT NOT NULL DEFAULT '{}',
			auth_kind TEXT NOT NULL DEFAULT '',
			auth_mode TEXT NOT NULL DEFAULT '',
			updated_at_ms INTEGER NOT NULL DEFAULT 0
		);
	`)
	if err != nil {
		t.Fatalf("init aih.db schema: %v", err)
	}
	return db
}

func createTestAppStateDB(t *testing.T, aiHomeDir string) *sql.DB {
	t.Helper()
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("mkdir run: %v", err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open app-state.db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS account_refs (
			account_ref TEXT PRIMARY KEY,
			provider TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS account_credentials (
			account_ref TEXT PRIMARY KEY,
			env_json TEXT NOT NULL DEFAULT '{}',
			native_auth_json TEXT NOT NULL DEFAULT '{}',
			env_updated_at INTEGER NOT NULL DEFAULT 0,
			native_auth_updated_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0
		);
	`)
	if err != nil {
		t.Fatalf("init app-state.db schema: %v", err)
	}
	return db
}

func makeTestJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	hdrBytes, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT"})
	payBytes, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal jwt claims: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(hdrBytes) + "." +
		base64.RawURLEncoding.EncodeToString(payBytes) + ".sig"
}

func TestCredentialAccountLister_MergesAihAndAppStateDBs(t *testing.T) {
	aiHome := t.TempDir()
	lister, err := NewCredentialAccountLister(aiHome)
	if err != nil {
		t.Fatalf("NewCredentialAccountLister: %v", err)
	}
	// Missing DBs should return empty slice without error.
	refs, err := lister.ListByProvider(context.Background(), "zcode")
	if err != nil || len(refs) != 0 {
		t.Fatalf("missing DBs = (%v, %v), want empty nil", refs, err)
	}

	aihDB := createTestAihDB(t, aiHome)
	appDB := createTestAppStateDB(t, aiHome)

	const (
		refA = "acct_0000000000000000000a"
		refB = "acct_0000000000000000000b"
		refC = "acct_0000000000000000000c"
	)
	for _, stmt := range []struct {
		ref, prov, cred string
	}{
		{refB, "zcode", `{"api_key":"k-b"}`},
		{refA, "zcode", `{"native_auth_json":{"zcodejwttoken":"t-a"}}`},
		{"acct_0000000000000000000d", "zcode", `{}`}, // empty {} should be ignored
		{"acct_bad", "zcode", `{"api_key":"bad"}`},   // invalid ref ignored
		{"acct_0000000000000000000e", "qoder", `{"api_key":"q-e"}`},
	} {
		_, err := aihDB.Exec(`INSERT INTO accounts (account_ref, provider_id) VALUES (?, ?)`, stmt.ref, stmt.prov)
		if err != nil {
			t.Fatalf("insert account: %v", err)
		}
		_, err = aihDB.Exec(`INSERT INTO account_credentials (account_ref, credential_json) VALUES (?, ?)`, stmt.ref, stmt.cred)
		if err != nil {
			t.Fatalf("insert cred: %v", err)
		}
	}

	for _, row := range []struct {
		ref, prov, envJSON, nativeJSON string
	}{
		{refB, "zcode", `{"ZCODE_API_KEY":"old-b"}`, `{}`}, // duplicate across both DBs
		{refC, "zcode", `{}`, `{"zcodejwttoken":"t-c"}`},   // only in app-state.db
		{"acct_0000000000000000000f", "zcode", `{}`, `{}`}, // empty in app-state.db ignored
	} {
		if _, err := appDB.Exec(`INSERT INTO account_refs (account_ref, provider) VALUES (?, ?)`, row.ref, row.prov); err != nil {
			t.Fatalf("insert app ref: %v", err)
		}
		if _, err := appDB.Exec(`INSERT INTO account_credentials (account_ref, env_json, native_auth_json) VALUES (?, ?, ?)`, row.ref, row.envJSON, row.nativeJSON); err != nil {
			t.Fatalf("insert app cred: %v", err)
		}
	}

	got, err := lister.ListByProvider(context.Background(), " ZCode ")
	if err != nil {
		t.Fatalf("ListByProvider: %v", err)
	}
	want := []string{refA, refB, refC}
	if len(got) != len(want) {
		t.Fatalf("ListByProvider = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ListByProvider[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestLoadAccountRecord_MergesAndMapsFields(t *testing.T) {
	aiHome := t.TempDir()
	aihDB := createTestAihDB(t, aiHome)
	appDB := createTestAppStateDB(t, aiHome)

	const refNewerAih = "acct_11111111111111111111"
	const refStaticZcode = "acct_22222222222222222222"
	const refStaticQoder = "acct_33333333333333333333"

	if _, err := appDB.Exec(`INSERT INTO account_refs (account_ref, provider) VALUES (?, 'zcode')`, refNewerAih); err != nil {
		t.Fatal(err)
	}
	if _, err := appDB.Exec(`
		INSERT INTO account_credentials (account_ref, env_json, native_auth_json, native_auth_updated_at)
		VALUES (?, '{"CUSTOM_ENV":"from-app"}', '{"zcodejwttoken":"stale-jwt"}', 100)
	`, refNewerAih); err != nil {
		t.Fatal(err)
	}
	if _, err := aihDB.Exec(`INSERT INTO accounts (account_ref, provider_id) VALUES (?, 'zcode'), (?, 'zcode'), (?, 'qodercn')`,
		refNewerAih, refStaticZcode, refStaticQoder); err != nil {
		t.Fatal(err)
	}
	if _, err := aihDB.Exec(`
		INSERT INTO account_credentials (account_ref, credential_json, updated_at_ms) VALUES
		(?, '{"native_auth_json":{"zcodejwttoken":"fresh-jwt"}}', 200),
		(?, '{"api_key":"zc-static-key"}', 300),
		(?, '{"api_key":"qd-static-pat"}', 300)
	`, refNewerAih, refStaticZcode, refStaticQoder); err != nil {
		t.Fatal(err)
	}

	rec, ok, err := LoadAccountRecord(context.Background(), aiHome, "zcode", refNewerAih)
	if err != nil || !ok {
		t.Fatalf("LoadAccountRecord(refNewerAih) = ok:%v err:%v", ok, err)
	}
	if rec.Env["CUSTOM_ENV"] != "from-app" {
		t.Fatalf("Env = %v, want CUSTOM_ENV preserved", rec.Env)
	}
	if textOf(rec.NativeAuth["zcodejwttoken"]) != "fresh-jwt" {
		t.Fatalf("NativeAuth = %v, want newer aih.db jwt", rec.NativeAuth)
	}

	recStaticZ, ok, err := LoadAccountRecord(context.Background(), aiHome, "zcode", refStaticZcode)
	if err != nil || !ok || recStaticZ.Env["ZCODE_API_KEY"] != "zc-static-key" {
		t.Fatalf("static zcode record = %+v ok:%v err:%v", recStaticZ, ok, err)
	}

	recStaticQ, ok, err := LoadAccountRecord(context.Background(), aiHome, "qodercn", refStaticQoder)
	if err != nil || !ok || recStaticQ.Env["QODER_PERSONAL_ACCESS_TOKEN"] != "qd-static-pat" {
		t.Fatalf("static qoder record = %+v ok:%v err:%v", recStaticQ, ok, err)
	}
}

func TestQoderCredentialsAndDeviceIdentity(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	const ref = "acct_aaaaaaaaaaaaaaaaaaaa"

	runtimeDir := ResolveAccountRuntimeDir(aiHome, "qoder", ref)
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	umidJSON := `{"info":{"machineToken":"mt-sandbox","machineCode":"mc-sandbox","machineType":"macOS"}}`
	if err := os.WriteFile(filepath.Join(runtimeDir, "umid-cache.json"), []byte(umidJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	id := ReadQoderDeviceIdentity(aiHome, hostHome, "qoder", ref)
	if id == nil || id.MachineToken != "mt-sandbox" || id.MachineCode != "mc-sandbox" || id.MachineType != "macOS" {
		t.Fatalf("ReadQoderDeviceIdentity = %+v", id)
	}

	token, src := ResolveQoderAccessToken("qoder", AccountRecord{
		Env:        map[string]string{"QODER_PERSONAL_ACCESS_TOKEN": "pat-env"},
		NativeAuth: map[string]any{"userInfo": map[string]any{"access_token": "tok-native"}},
	}, qodercred.Options{}, nil)
	if token != "pat-env" || src != "env_pat" {
		t.Fatalf("ResolveQoderAccessToken env = (%q, %q)", token, src)
	}

	token, src = ResolveQoderAccessToken("qoder", AccountRecord{
		NativeAuth: map[string]any{"userInfo": map[string]any{"security_oauth_token": "oauth-plain"}},
	}, qodercred.Options{}, nil)
	if token != "oauth-plain" || src != "native_auth" {
		t.Fatalf("ResolveQoderAccessToken plain = (%q, %q)", token, src)
	}
}

func TestReadCodebuddySharedCredential_AdoptsNewerDiskAuthAndCodec(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	const ref = "acct_bbbbbbbbbbbbbbbbbbbb"
	const uid = "u-1001"
	now := time.Now().UnixMilli()

	dbJWT := makeTestJWT(t, map[string]any{
		"iss": "https://copilot.tencent.com/auth/realms/copilot",
		"sub": uid,
		"iat": float64(now/1000 - 3600),
		"exp": float64(now/1000 + 3600),
	})
	diskJWT := makeTestJWT(t, map[string]any{
		"iss": "https://copilot.tencent.com/auth/realms/copilot",
		"sub": uid,
		"iat": float64(now/1000 - 60),
		"exp": float64(now/1000 + 7200),
	})

	record := AccountRecord{
		Provider:   "workbuddycn",
		AccountRef: ref,
		NativeAuth: map[string]any{
			"credentials": map[string]any{
				"auth": map[string]any{
					"accessToken":  dbJWT,
					"refreshToken": "refresh-1",
					"domain":       "enterprise.example.com",
				},
				"account": map[string]any{
					"uid":          uid,
					"enterpriseId": "ent-99",
				},
			},
		},
	}

	// Write an encrypted shared .info in account runtime dir; verify codecDecode adopts newer token.
	runtimeDir := ResolveAccountRuntimeDir(aiHome, "workbuddycn", ref)
	authFiles := codebuddyAuthFilePaths(runtimeDir, "workbuddycn")
	if len(authFiles) == 0 {
		t.Fatal("expected auth file paths")
	}
	if err := os.MkdirAll(filepath.Dir(authFiles[0]), 0o755); err != nil {
		t.Fatal(err)
	}
	encPayload := `{"auth":{"accessToken":{"$wbEncrypted":1}},"account":{"uid":"` + uid + `"}}`
	if err := os.WriteFile(authFiles[0], []byte(encPayload), 0o600); err != nil {
		t.Fatal(err)
	}

	cred := ReadCodebuddySharedCredential(aiHome, hostHome, "workbuddycn", ref, record, now, func(raw map[string]any, provider string) (map[string]any, error) {
		return map[string]any{
			"auth": map[string]any{
				"accessToken":  diskJWT,
				"refreshToken": "refresh-2",
				"domain":       "new.enterprise.example.com",
			},
			"account": map[string]any{
				"uid":          uid,
				"enterpriseId": "ent-99",
			},
		}, nil
	})
	if cred == nil {
		t.Fatal("ReadCodebuddySharedCredential returned nil")
	}
	if cred.AccessToken != diskJWT || cred.EnterpriseID != "ent-99" || cred.Domain != "new.enterprise.example.com" {
		t.Fatalf("adopted cred = %+v, want diskJWT", cred)
	}

	// Without codecDecode, encrypted disk file is ignored and DB credential stays active.
	credFallback := ReadCodebuddySharedCredential(aiHome, hostHome, "workbuddycn", ref, record, now, nil)
	if credFallback == nil || credFallback.AccessToken != dbJWT {
		t.Fatalf("fallback cred = %+v, want dbJWT", credFallback)
	}
}

func TestReadZcodeLiveOAuthAndClientMetadata(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	const ref = "acct_cccccccccccccccccccc"
	t.Setenv("ZCODE_CREDENTIAL_SECRET", "test-secret")

	// Known Node encrypted vector for "hello-zcode" with secret="test-secret".
	const encVector = "enc:v1:qA2RJPyhmmLJc9f3.fgw3CWGJ6lJS1VYNoE46dA.NuVgZLOXJ20m388"
	rec := AccountRecord{
		Provider:            "zcode",
		AccountRef:          ref,
		NativeAuthUpdatedAt: 1000,
		NativeAuth: map[string]any{
			"credentials": map[string]any{
				"oauth:active_provider":  "zai",
				"oauth:zai:access_token": encVector,
				"zcodejwttoken":          "db-jwt",
			},
		},
	}

	oauthDB := ReadZcodeLiveOAuthCredential(aiHome, ref, rec)
	if oauthDB.Source != "db" || oauthDB.JWTToken != "db-jwt" || oauthDB.AccessToken != "hello-zcode" {
		t.Fatalf("db oauth = %+v", oauthDB)
	}

	// Live file newer than NativeAuthUpdatedAt supersedes DB snapshot.
	runtimeDir := ResolveAccountRuntimeDir(aiHome, "zcode", ref)
	livePath := filepath.Join(runtimeDir, ".zcode", "v2", "credentials.json")
	if err := os.MkdirAll(filepath.Dir(livePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(livePath, []byte(`{"oauth:active_provider":"bigmodel","oauth:bigmodel:access_token":"live-acc","zcodejwttoken":"live-jwt"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	newer := time.Now().Add(time.Minute)
	_ = os.Chtimes(livePath, newer, newer)

	oauthLive := ReadZcodeLiveOAuthCredential(aiHome, ref, rec)
	if oauthLive.Source != "live" || oauthLive.JWTToken != "live-jwt" || oauthLive.AccessToken != "live-acc" {
		t.Fatalf("live oauth = %+v", oauthLive)
	}

	// Metadata resolution + cached version + persistent device_mid.
	nowMS := time.Now().UnixMilli()
	cacheDir := filepath.Join(aiHome, "run")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cachePayload := fmt.Sprintf(`{"version":"3.18.1","fetchedAtMs":%d}`, nowMS)
	if err := os.WriteFile(filepath.Join(cacheDir, "zcode-app-version.json"), []byte(cachePayload), 0o600); err != nil {
		t.Fatal(err)
	}
	version, meta := ResolveZcodeClientMetadata(context.Background(), aiHome, hostHome, ref, "", nil, nowMS, true)
	if version != "3.18.1" {
		t.Fatalf("version = %q, want 3.18.1", version)
	}
	if meta["X-Device-Mid"] == "" || meta["X-Platform"] == "" || meta["X-Os-Category"] == "" || meta["X-ZCode-App-Version"] != "3.18.1" {
		t.Fatalf("incomplete meta headers: %v", meta)
	}
	_, metaAgain := ResolveZcodeClientMetadata(context.Background(), aiHome, hostHome, ref, "", nil, nowMS, true)
	if meta["X-Device-Mid"] != metaAgain["X-Device-Mid"] {
		t.Fatalf("device mid not stable: %q vs %q", meta["X-Device-Mid"], metaAgain["X-Device-Mid"])
	}
}
