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
}

func (fake fakeStore) LookupProvider(context.Context, string) (string, bool, error) {
	return fake.provider, fake.found, nil
}

func (fake fakeStore) ReadParticipation(context.Context, string) (bool, error) {
	return fake.participates, fake.err
}

func newHandler(t *testing.T, store Store) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/alias-pool", handler)
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
