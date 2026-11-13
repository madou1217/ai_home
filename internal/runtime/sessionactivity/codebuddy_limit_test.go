package sessionactivity

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func makeTestJWT(claims map[string]any) string {
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	b, _ := json.Marshal(claims)
	pl := base64.RawURLEncoding.EncodeToString(b)
	return hdr + "." + pl + ".sig"
}

func TestParseResetAtAndCreditsExhausted(t *testing.T) {
	ms := ParseResetAtTimestampMS("429 usage exceeds frequency limit; your usage will reset at 2026-10-31 14:57:00 UTC+8", false)
	want := time.Date(2026, 10, 31, 6, 57, 0, 0, time.UTC).UnixMilli()
	if ms != want {
		t.Fatalf("UTC+8 reset mismatch: got %d want %d", ms, want)
	}

	msZh := ParseResetAtTimestampMS("使用量已超出频率限制，将在 2026-11-04 13:34:21 UTC+8 重置", false)
	wantZh := time.Date(2026, 11, 4, 5, 34, 21, 0, time.UTC).UnixMilli()
	if msZh != wantZh {
		t.Fatalf("zh reset mismatch: got %d want %d", msZh, wantZh)
	}

	if ParseResetAtTimestampMS("2026-11-04 13:34:21 UTC+8", false) != 0 {
		t.Fatalf("bare timestamp must require allowBare=true")
	}
	if ParseResetAtTimestampMS("2026-11-04 13:34:21 UTC+8", true) != wantZh {
		t.Fatalf("bare timestamp with allowBare=true mismatch")
	}

	if !IsCreditsExhaustedMessage("429 Credits exhausted. Please purchase add-on packs in profile/usage.") {
		t.Fatalf("expected IsCreditsExhaustedMessage true")
	}
	if IsCreditsExhaustedMessage("429 generic rate limit") {
		t.Fatalf("expected IsCreditsExhaustedMessage false")
	}
}

func TestDiscoverCodebuddyHardlinkDedupAndObserverEndToEnd(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	now := time.Date(2026, 11, 13, 10, 0, 0, 0, time.Local)
	nowMS := now.UnixMilli()

	// Verify JWT helper + inspectCodebuddyCredentialPayload
	const uid = "uid_horsebean"
	const ref = "acct_0123456789abcdef0123"
	jwt := makeTestJWT(map[string]any{
		"iss": "https://www.codebuddy.ai/auth/realms/copilot",
		"sub": uid,
	})
	credBytes, _ := json.Marshal(map[string]any{
		"auth":    map[string]any{"accessToken": jwt, "refreshToken": jwt, "domain": "www.codebuddy.ai"},
		"account": map[string]any{"uid": uid},
	})
	gotUID, gotDomain, ok := inspectCodebuddyCredentialPayload(credBytes, "codebuddy")
	if !ok || gotUID != uid || gotDomain != "www.codebuddy.ai" {
		t.Fatalf("unexpected credential inspection: ok=%v uid=%q domain=%q", ok, gotUID, gotDomain)
	}

	// Create session jsonl + hardlink across .codebuddy and .workbuddy-ai
	cbProj := filepath.Join(hostHome, ".codebuddy", "projects", "proj-a")
	wbProj := filepath.Join(hostHome, ".workbuddy-ai", "projects", "proj-a")
	_ = os.MkdirAll(cbProj, 0o755)
	_ = os.MkdirAll(wbProj, 0o755)
	sessPath := filepath.Join(cbProj, "sess_cb1.jsonl")
	linkPath := filepath.Join(wbProj, "sess_cb1.jsonl")

	lineExpired := `{"id":"m0","timestamp":` + jsonStringInt(nowMS-60000) + `,"providerData":{"error":{"status":429,"message":"your usage will reset at 2020-01-01 00:00:00 UTC"}}}`
	lineActive := `{"id":"m1","timestamp":` + jsonStringInt(nowMS-5000) + `,"providerData":{"error":{"status":429,"requestId":"req_abc12345","message":"usage exceeds frequency limit; your usage will reset at 2026-11-13 18:30:00 UTC+8"}}}`
	_ = os.WriteFile(sessPath, []byte(lineExpired+"\n"+lineActive+"\n"), 0o644)
	_ = os.Link(sessPath, linkPath)

	discovered := DiscoverCodebuddyUsageFiles(hostHome, codebuddyFamilyProviders, "")
	if len(discovered) != 1 {
		t.Fatalf("expected 1 deduplicated file across hardlinks, got %d", len(discovered))
	}

	// Shared CLI log containing userId + Sending request model + [addHistory] attribution
	logDay := now.Format("2006-01-02")
	sharedLogDir := filepath.Join(hostHome, ".codebuddy", "logs", logDay)
	_ = os.MkdirAll(sharedLogDir, 0o755)
	tsStr := now.Add(-5 * time.Second).Format("2006/01/02 15:04:05") + ".000"
	logContent := "[" + tsStr + "] [Info] [pid=777] {\"userId\":\"" + uid + "\"}\n" +
		"[" + tsStr + "] [Info] [pid=777] [addHistory] START sessionId=sess_cb1, storeId=st1, types=[message], input=[{type: message, id: m1}]\n" +
		"[" + tsStr + "] [Info] [pid=777] [ModelProvider] Sending request: agent=cli, model=claude-sonnet-4.5, requestId=req_abc12345, ok=1\n"
	_ = os.WriteFile(filepath.Join(sharedLogDir, "cb.log"), []byte(logContent), 0o644)

	var observed []ObservedCodebuddyLimit
	obs := NewCodebuddyLimitObserver(CodebuddyLimitOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		ListAccounts: func(context.Context) []CodebuddyAccountIdentity {
			return []CodebuddyAccountIdentity{
				{Provider: "codebuddy", AccountRef: ref, UID: uid},
			}
		},
		OnLimitObserved: func(_ context.Context, limit ObservedCodebuddyLimit) bool {
			observed = append(observed, limit)
			return true
		},
		Now: func() time.Time { return now },
	})

	sum := obs.Tick(context.Background())
	if sum.Files != 1 || sum.Observed != 2 || sum.Applied != 1 {
		t.Fatalf("unexpected limit observer summary: %+v", sum)
	}
	if len(observed) != 1 || observed[0].AccountRef != ref || observed[0].Model != "claude-sonnet-4.5" {
		t.Fatalf("unexpected observed limit: %+v", observed)
	}
	wantReset := time.Date(2026, 11, 13, 10, 30, 0, 0, time.UTC).UnixMilli()
	if observed[0].ResetAtMS != wantReset {
		t.Fatalf("unexpected resetAtMS %d vs %d", observed[0].ResetAtMS, wantReset)
	}
}

func jsonStringInt(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestLoadCodebuddyAccountIdentitiesFromBothDBs(t *testing.T) {
	aiHome := t.TempDir()
	ctx := context.Background()

	const refAih = "acct_11111111111111111111"
	const refApp = "acct_22222222222222222222"
	const uidAih = "uid_from_aih_db"
	const uidApp = "uid_from_app_state"

	jwtAih := makeTestJWT(map[string]any{
		"iss": "https://copilot.tencent.com/auth/realms/copilot",
		"sub": uidAih,
	})
	credAihBytes, _ := json.Marshal(map[string]any{
		"native_auth_json": map[string]any{
			"credentials": map[string]any{
				"auth":    map[string]any{"accessToken": jwtAih, "refreshToken": jwtAih, "domain": "copilot.tencent.com"},
				"account": map[string]any{"uid": uidAih},
			},
		},
	})

	aihDB, err := sql.Open("sqlite", filepath.Join(aiHome, "aih.db"))
	if err != nil {
		t.Fatalf("open aih.db: %v", err)
	}
	_, err = aihDB.Exec(`
		CREATE TABLE accounts (account_ref TEXT PRIMARY KEY, provider_id TEXT NOT NULL);
		CREATE TABLE account_credentials (account_ref TEXT PRIMARY KEY, credential_json TEXT NOT NULL);
	`)
	if err != nil {
		t.Fatalf("create aih tables: %v", err)
	}
	if _, err := aihDB.Exec(`INSERT INTO accounts(account_ref, provider_id) VALUES (?, 'workbuddycn')`, refAih); err != nil {
		t.Fatalf("insert aih account: %v", err)
	}
	if _, err := aihDB.Exec(`INSERT INTO account_credentials(account_ref, credential_json) VALUES (?, ?)`, refAih, string(credAihBytes)); err != nil {
		t.Fatalf("insert aih credential: %v", err)
	}
	_ = aihDB.Close()

	jwtApp := makeTestJWT(map[string]any{
		"iss": "https://www.codebuddy.ai/auth/realms/copilot",
		"sub": uidApp,
	})
	credAppBytes, _ := json.Marshal(map[string]any{
		"auth":    map[string]any{"accessToken": jwtApp, "refreshToken": jwtApp, "domain": "www.codebuddy.ai"},
		"account": map[string]any{"uid": uidApp},
	})

	appStatePath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatalf("DatabasePath: %v", err)
	}
	_ = os.MkdirAll(filepath.Dir(appStatePath), 0o755)
	appDB, err := sql.Open("sqlite", appStatePath)
	if err != nil {
		t.Fatalf("open app-state: %v", err)
	}
	_, err = appDB.Exec(`
		CREATE TABLE IF NOT EXISTS account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS account_credentials (account_ref TEXT PRIMARY KEY, env_json TEXT NOT NULL DEFAULT '{}', native_auth_json TEXT NOT NULL DEFAULT '{}');
	`)
	if err != nil {
		t.Fatalf("create app-state tables: %v", err)
	}
	// 同 ref 在 app-state.db 存在但无 uid 时，不应覆盖 aih.db 里已解析的 uid；另加 refApp 验证 app-state.db 独立读取。
	if _, err := appDB.Exec(`INSERT INTO account_refs(account_ref, provider) VALUES (?, 'workbuddycn'), (?, 'codebuddy')`, refAih, refApp); err != nil {
		t.Fatalf("insert app-state refs: %v", err)
	}
	if _, err := appDB.Exec(`INSERT INTO account_credentials(account_ref, native_auth_json) VALUES (?, '{}'), (?, ?)`, refAih, refApp, string(credAppBytes)); err != nil {
		t.Fatalf("insert app-state creds: %v", err)
	}
	_ = appDB.Close()

	got := LoadCodebuddyAccountIdentities(ctx, aiHome)
	if len(got) != 2 {
		t.Fatalf("expected 2 identities, got %+v", got)
	}
	byRef := map[string]CodebuddyAccountIdentity{}
	for _, item := range got {
		byRef[item.Provider+":"+item.AccountRef] = item
	}
	if byRef["workbuddycn:"+refAih].UID != uidAih {
		t.Fatalf("unexpected aih identity: %+v", byRef["workbuddycn:"+refAih])
	}
	if byRef["codebuddy:"+refApp].UID != uidApp {
		t.Fatalf("unexpected app-state identity: %+v", byRef["codebuddy:"+refApp])
	}
}
