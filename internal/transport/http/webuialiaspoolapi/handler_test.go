package webuialiaspoolapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const testAccountRef = "acct_0123456789abcdef0123"

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeStore struct {
	provider     string
	found        bool
	participates bool
	err          error
	writeErr     error
	written      *bool
}

func (fake fakeStore) LookupProvider(context.Context, string) (string, bool, error) {
	return fake.provider, fake.found, nil
}

func (fake fakeStore) ReadParticipation(context.Context, string) (bool, error) {
	return fake.participates, fake.err
}

func (fake fakeStore) WriteParticipation(_ context.Context, _ string, participates bool, _ int64) error {
	if fake.writeErr != nil {
		return fake.writeErr
	}
	if fake.written != nil {
		*fake.written = participates
	}
	return nil
}

func newHandler(t *testing.T, store Store) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/alias-pool", handler)
	mux.Handle("POST "+Path+"/{provider}/{accountRef}/alias-pool", handler)
	return mux
}

func seedDB(t *testing.T, withSetting string) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create account_refs: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO account_refs (account_ref, provider, created_at, updated_at) VALUES (?, 'claude', 1, 1)`, testAccountRef); err != nil {
		t.Fatalf("insert account_refs: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create app_kv: %v", err)
	}
	if withSetting != "" {
		if _, err := db.Exec(`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, 1)`, aliasPoolKeyPrefix+testAccountRef, withSetting); err != nil {
			t.Fatalf("insert app_kv: %v", err)
		}
	}
	return directory
}

func doGet(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

func TestDefaultParticipationIsTrue(t *testing.T) {
	source, err := OpenSource(seedDB(t, ""))
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	recorder := doGet(t, newHandler(t, source), Path+"/claude/"+testAccountRef+"/alias-pool")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		OK      bool `json:"ok"`
		Setting struct {
			Participates bool `json:"participates"`
		} `json:"setting"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.OK || !payload.Setting.Participates {
		t.Fatalf("payload = %+v", payload)
	}
}

func TestExplicitFalseIsReturned(t *testing.T) {
	source, _ := OpenSource(seedDB(t, `{"participates":false,"updatedAt":10}`))
	recorder := doGet(t, newHandler(t, source), Path+"/claude/"+testAccountRef+"/alias-pool")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"participates":false`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestCorruptRecordFails(t *testing.T) {
	source, _ := OpenSource(seedDB(t, `not-json`))
	recorder := doGet(t, newHandler(t, source), Path+"/claude/"+testAccountRef+"/alias-pool")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}

func TestProviderMismatchIsConflict(t *testing.T) {
	source, _ := OpenSource(seedDB(t, ""))
	recorder := doGet(t, newHandler(t, source), Path+"/codex/"+testAccountRef+"/alias-pool")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", recorder.Code)
	}
}

func TestUnknownAccountIsNotFound(t *testing.T) {
	source, _ := OpenSource(seedDB(t, ""))
	recorder := doGet(t, newHandler(t, source), Path+"/claude/acct_ffffffffffffffffffff/alias-pool")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
}

func TestRequiresAuthorization(t *testing.T) {
	handler, _ := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Store:      fakeStore{provider: "claude", found: true, participates: true},
	})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, Path+"/claude/"+testAccountRef+"/alias-pool", nil)
	request.SetPathValue("provider", "claude")
	request.SetPathValue("accountRef", testAccountRef)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func postAliasPool(t *testing.T, handler http.Handler, path string, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestWriteParticipation(t *testing.T) {
	written := true
	store := fakeStore{provider: "claude", found: true, written: &written}
	handler := newHandler(t, store)
	recorder := postAliasPool(t, handler, Path+"/claude/"+testAccountRef+"/alias-pool", "{\"participates\":false}")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if written != false {
		t.Fatalf("written = %v", written)
	}
	var payload responseView
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Setting.Participates != false || payload.Provider != "claude" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestWriteParticipationValidation(t *testing.T) {
	handler := newHandler(t, fakeStore{provider: "claude", found: true})
	path := Path + "/claude/" + testAccountRef + "/alias-pool"
	cases := []struct {
		name string
		body string
		code string
	}{
		{name: "invalid json", body: "{", code: "invalid_json_body"},
		{name: "array body", body: "[]", code: "invalid_request_body"},
		{name: "non bool", body: "{\"participates\":\"yes\"}", code: "invalid_participates"},
		{name: "missing", body: "{}", code: "invalid_participates"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := postAliasPool(t, handler, path, testCase.body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d", recorder.Code)
			}
			var payload errorView
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if payload.Error != testCase.code {
				t.Fatalf("error = %q, want %q", payload.Error, testCase.code)
			}
		})
	}
}

func TestWriteParticipationFailures(t *testing.T) {
	writeFailure := newHandler(t, fakeStore{provider: "claude", found: true, writeErr: context.DeadlineExceeded})
	recorder := postAliasPool(t, writeFailure, Path+"/claude/"+testAccountRef+"/alias-pool", "{\"participates\":true}")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("write failure status = %d", recorder.Code)
	}
	mismatch := newHandler(t, fakeStore{provider: "codex", found: true})
	recorder = postAliasPool(t, mismatch, Path+"/claude/"+testAccountRef+"/alias-pool", "{\"participates\":true}")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("mismatch status = %d", recorder.Code)
	}
}

func TestSourceWritePersists(t *testing.T) {
	directory := seedDB(t, "")
	source, err := OpenSource(directory)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	if err := source.WriteParticipation(context.Background(), testAccountRef, false, 1700000000000); err != nil {
		t.Fatalf("WriteParticipation() error = %v", err)
	}
	participates, err := source.ReadParticipation(context.Background(), testAccountRef)
	if err != nil || participates != false {
		t.Fatalf("ReadParticipation() = %v/%v", participates, err)
	}
}
