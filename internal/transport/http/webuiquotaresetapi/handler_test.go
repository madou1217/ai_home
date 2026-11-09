package webuiquotaresetapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

const testAccountRef = "acct_0123456789abcdef0123"

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeAccounts struct {
	provider string
	found    bool
	err      error
}

func (fake fakeAccounts) LookupProvider(
	context.Context,
	string,
) (string, bool, error) {
	return fake.provider, fake.found, fake.err
}

func newTestHandler(t *testing.T, source EventSource) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Accounts:   fakeAccounts{provider: "claude", found: true},
		Events:     source,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/quota-reset-events", handler)
	return mux
}

func seedAppState(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	databasePath := filepath.Join(directory, appStateDatabaseFileName)
	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()
	_, err = db.Exec(`CREATE TABLE account_refs (
			account_ref TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`)
	if err != nil {
		t.Fatalf("create account_refs: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO account_refs (account_ref, provider, created_at, updated_at) VALUES (?, 'claude', 1, 1)`,
		testAccountRef,
	); err != nil {
		t.Fatalf("insert account_refs: %v", err)
	}
	_, err = db.Exec(`
		CREATE TABLE account_quota_reset_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_key TEXT,
			account_ref TEXT,
			provider TEXT,
			quota_key TEXT,
			window_label TEXT,
			window_minutes INTEGER,
			event_kind TEXT,
			classification TEXT,
			cause TEXT,
			previous_remaining_pct REAL,
			current_remaining_pct REAL,
			previous_expected_reset_at_ms INTEGER,
			detected_at_ms INTEGER,
			early_duration_ms INTEGER,
			exhausted_at_ms INTEGER,
			occurred_at_ms INTEGER,
			previous_plan_type TEXT,
			current_plan_type TEXT
		)`)
	if err != nil {
		t.Fatalf("create table: %v", err)
	}
	for index := 1; index <= 3; index++ {
		_, err = db.Exec(
			`INSERT INTO account_quota_reset_events
			 (event_key, account_ref, provider, quota_key, window_label, window_minutes,
			  event_kind, classification, cause, previous_remaining_pct, current_remaining_pct,
			  previous_expected_reset_at_ms, detected_at_ms, early_duration_ms, exhausted_at_ms,
			  occurred_at_ms, previous_plan_type, current_plan_type)
			 VALUES (?, ?, 'claude', 'five_hour', '5h', 300, 'reset', 'early', 'manual',
			         0.1, 1.0, 1000, ?, 200, NULL, ?, '', '')`,
			"event-"+string(rune('0'+index)),
			testAccountRef,
			int64(1000*index),
			int64(900*index),
		)
		if err != nil {
			t.Fatalf("insert event %d: %v", index, err)
		}
	}
	return directory
}

func TestHandlerReturnsEventsNewestFirst(t *testing.T) {
	directory := seedAppState(t)
	source, err := OpenSource(directory)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodGet,
		Path+"/claude/"+testAccountRef+"/quota-reset-events?limit=2",
		nil,
	)
	newTestHandler(t, source).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		OK         bool    `json:"ok"`
		Provider   string  `json:"provider"`
		AccountRef string  `json:"accountRef"`
		Events     []Event `json:"events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.OK || payload.Provider != "claude" || payload.AccountRef != testAccountRef {
		t.Fatalf("payload = %+v", payload)
	}
	if len(payload.Events) != 2 {
		t.Fatalf("events = %d, want 2", len(payload.Events))
	}
	if payload.Events[0].ID <= payload.Events[1].ID {
		t.Fatalf("事件未按倒序返回: %d, %d", payload.Events[0].ID, payload.Events[1].ID)
	}
	if payload.Events[0].OccurredAtMS != 900*3 && payload.Events[0].OccurredAtMS == 0 {
		t.Fatalf("occurredAtMs = %d", payload.Events[0].OccurredAtMS)
	}
	if payload.Events[0].PreviousPlanType != nil || payload.Events[0].CurrentPlanType != nil {
		t.Fatalf("空 planType 必须是 null: %+v", payload.Events[0])
	}
}

func TestHandlerRejectsProviderMismatch(t *testing.T) {
	source, _ := OpenSource(seedAppState(t))
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodGet,
		Path+"/codex/"+testAccountRef+"/quota-reset-events",
		nil,
	)
	newTestHandler(t, source).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
}

func TestHandlerMissingDatabaseReturnsEmpty(t *testing.T) {
	source, err := OpenSource(t.TempDir())
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodGet,
		Path+"/claude/"+testAccountRef+"/quota-reset-events",
		nil,
	)
	newTestHandler(t, source).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if body := recorder.Body.String(); body == "" || !json.Valid(recorder.Body.Bytes()) {
		t.Fatalf("body = %s", body)
	}
}

func TestHandlerRequiresAuthorization(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Accounts:   fakeAccounts{provider: "claude", found: true},
		Events:     &Source{},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, Path+"/claude/"+testAccountRef+"/quota-reset-events", nil)
	request.SetPathValue("provider", "claude")
	request.SetPathValue("accountRef", testAccountRef)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestParseLimitClamps(t *testing.T) {
	cases := map[string]int{"": DefaultLimit, "0": DefaultLimit, "abc": DefaultLimit, "500": MaxLimit, "7": 7}
	for raw, want := range cases {
		if got := parseLimit(raw); got != want {
			t.Fatalf("parseLimit(%q) = %d, want %d", raw, got, want)
		}
	}
}
