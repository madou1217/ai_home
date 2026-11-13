package webuiaccountoutcomesapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

type stubReader struct {
	dayBuckets  []accountoutcomes.Bucket
	hourBuckets []accountoutcomes.Bucket
	err         error
}

func (s stubReader) ListAccountOutcomes(_ context.Context, g accountoutcomes.Granularity, _ int64) ([]accountoutcomes.Bucket, error) {
	if s.err != nil {
		return nil, s.err
	}
	if g == accountoutcomes.Hour {
		return s.hourBuckets, nil
	}
	return s.dayBuckets, nil
}

func mustRef(t *testing.T, hexSuffix string) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_" + hexSuffix)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func seedAppState(t *testing.T, aiHomeDir string, now time.Time, nodeRef string, goRef string) {
	t.Helper()
	dbPath := filepath.Join(aiHomeDir, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	defer db.Close()

	_, err = db.Exec(`
		CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
		CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
		CREATE TABLE native_account_outcomes (event_key TEXT NOT NULL UNIQUE, account_ref TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL, outcome TEXT NOT NULL, timestamp_ms INTEGER NOT NULL);
	`)
	if err != nil {
		t.Fatalf("create tables error = %v", err)
	}
	_, err = db.Exec(`INSERT INTO account_refs (account_ref, provider, created_at, updated_at) VALUES (?, 'codex', 1, 1)`, nodeRef)
	if err != nil {
		t.Fatalf("insert account_ref error = %v", err)
	}
	linkDoc, _ := json.Marshal(map[string]any{
		"links": map[string]any{
			nodeRef: map[string]any{"goRef": goRef},
		},
	})
	_, err = db.Exec(`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, 1)`, accountrefmap.SyncStateKey, string(linkDoc))
	if err != nil {
		t.Fatalf("insert sync state error = %v", err)
	}

	dayStart := accountoutcomes.BucketStart(now, accountoutcomes.Day, time.UTC)
	hourStart := accountoutcomes.BucketStart(now, accountoutcomes.Hour, time.UTC)
	nodeKV, _ := json.Marshal(map[string]any{
		"version": 1,
		"accounts": map[string]any{
			nodeRef: []map[string]any{
				{"granularity": "day", "startMs": dayStart, "success": 2, "failures": map[string]int64{"rate_limit": 1}},
				{"granularity": "hour", "startMs": hourStart, "success": 1, "failures": map[string]int64{}},
			},
		},
	})
	_, err = db.Exec(`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, 1)`, nodeOutcomesKVKey, string(nodeKV))
	if err != nil {
		t.Fatalf("insert node outcomes error = %v", err)
	}
	_, err = db.Exec(`INSERT INTO native_account_outcomes (event_key, account_ref, provider, session_id, outcome, timestamp_ms) VALUES ('ev1', ?, 'codebuddy', 's1', 'success', ?)`, nodeRef, now.UnixMilli())
	if err != nil {
		t.Fatalf("insert native outcome error = %v", err)
	}
}

func TestNewHandlerValidationAndHTTPGuards(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("err = %v, want %v", err, ErrInvalidDependencies)
	}
	unauth, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: false}})
	rec := httptest.NewRecorder()
	unauth.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth code = %d, want 401", rec.Code)
	}

	handler, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: true}, AIHomeDir: t.TempDir()})
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, Path, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("post code = %d, want 405", rec.Code)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable code = %d, want 503", rec.Code)
	}
}

func TestMergesGoNodeAndNativeOutcomes(t *testing.T) {
	now := time.Date(2026, 5, 10, 14, 30, 0, 0, time.UTC)
	nodeRef := "acct_11111111111111111111"
	goRefStr := "acct_22222222222222222222"
	goRef := mustRef(t, "22222222222222222222")
	pureGoRef := mustRef(t, "33333333333333333333")

	home := t.TempDir()
	seedAppState(t, home, now, nodeRef, goRefStr)

	dayStart := accountoutcomes.BucketStart(now, accountoutcomes.Day, time.UTC)
	hourStart := accountoutcomes.BucketStart(now, accountoutcomes.Hour, time.UTC)
	handler, _ := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: true},
		AIHomeDir:  home,
		Location:   time.UTC,
		Now:        func() time.Time { return now },
		GoOutcomes: stubReader{
			dayBuckets: []accountoutcomes.Bucket{
				{AccountRef: goRef, BucketStartMS: dayStart, Outcome: "success", Count: 5},
				{AccountRef: goRef, BucketStartMS: dayStart, Outcome: "rate_limit", Count: 3},
				{AccountRef: pureGoRef, BucketStartMS: dayStart, Outcome: "auth_failed", Count: 1},
			},
			hourBuckets: []accountoutcomes.Bucket{
				{AccountRef: goRef, BucketStartMS: hourStart, Outcome: "success", Count: 4},
			},
		},
	})

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		OK   bool     `json:"ok"`
		Data ViewData `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if !resp.OK || len(resp.Data.DayStarts) != DayCount || len(resp.Data.HourStarts) != HourCount {
		t.Fatalf("unexpected header sizes: days=%d hours=%d", len(resp.Data.DayStarts), len(resp.Data.HourStarts))
	}
	if len(resp.Data.Accounts) != 2 {
		t.Fatalf("accounts count = %d, want 2: %+v", len(resp.Data.Accounts), resp.Data.Accounts)
	}
	first := resp.Data.Accounts[0]
	if first.AccountRef != nodeRef || len(first.Days) != 1 || first.Days[0].Success != 8 || first.Days[0].Failures["rate_limit"] != 4 {
		t.Fatalf("merged day mismatch: %+v", first)
	}
	if len(first.Hours) != 1 || first.Hours[0].Success != 6 {
		t.Fatalf("merged hour mismatch: %+v", first.Hours)
	}
	second := resp.Data.Accounts[1]
	if second.AccountRef != pureGoRef.String() || second.Days[0].Failures["auth_failed"] != 1 || len(second.Hours) != 0 {
		t.Fatalf("pure Go account mismatch: %+v", second)
	}
}
