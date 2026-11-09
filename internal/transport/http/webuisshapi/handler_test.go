package webuisshapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeStore struct {
	raw   string
	found bool
	err   error
}

func (fake fakeStore) ReadConnections(context.Context) (string, bool, error) {
	return fake.raw, fake.found, fake.err
}

func newHandler(t *testing.T, store Store) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func decodeConnections(t *testing.T, recorder *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	var payload struct {
		OK          bool             `json:"ok"`
		Connections []map[string]any `json:"connections"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if !payload.OK {
		t.Fatalf("ok = false: %s", recorder.Body.String())
	}
	return payload.Connections
}

func TestMissingConnectionsIsEmptyList(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if len(decodeConnections(t, recorder)) != 0 {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestSecretsAreMaskedAndUnknownFieldsPreserved(t *testing.T) {
	raw := `[{"id":"c1","label":"prod","host":"10.0.0.1","port":22,"identityFile":"/home/u/.ssh/id_ed25519","password":"secret","privateKey":"","extra":{"keep":true}}]`
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: raw, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	connections := decodeConnections(t, recorder)
	if len(connections) != 1 {
		t.Fatalf("connections = %#v", connections)
	}
	connection := connections[0]
	if connection["password"] != passwordMask {
		t.Fatalf("password = %#v", connection["password"])
	}
	if connection["privateKey"] != "" {
		t.Fatalf("privateKey = %#v", connection["privateKey"])
	}
	if connection["host"] != "10.0.0.1" || connection["identityFile"] != "/home/u/.ssh/id_ed25519" {
		t.Fatalf("connection = %#v", connection)
	}
	extra, ok := connection["extra"].(map[string]any)
	if !ok || extra["keep"] != true {
		t.Fatalf("unknown field lost: %#v", connection["extra"])
	}
}

func TestMissingSecretFieldsBecomeEmptyStrings(t *testing.T) {
	raw := `[{"id":"c1","host":"h"}]`
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: raw, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	connection := decodeConnections(t, recorder)[0]
	if connection["password"] != "" || connection["privateKey"] != "" {
		t.Fatalf("connection = %#v", connection)
	}
}

func TestNonArrayIsEmptyList(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: `{"not":"array"}`, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if len(decodeConnections(t, recorder)) != 0 {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestInvalidJSONIsRejected(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: "[", found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}

func TestReadFailureAndAuthAndMethod(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{err: errors.New("boom")}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("read failure status = %d", recorder.Code)
	}

	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, Store: fakeStore{}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", recorder.Code)
	}
}

func TestSourceReadsSameKeyAsNode(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		t.Fatalf("create app_kv: %v", err)
	}
	if _, err := db.Exec("INSERT INTO app_kv (key, value, updated_at) VALUES ('ssh_connections', '[{\"id\":\"c1\",\"password\":\"x\"}]', 1)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	source, err := OpenSource(directory)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	raw, found, err := source.ReadConnections(context.Background())
	if err != nil || !found {
		t.Fatalf("ReadConnections() found=%v err=%v", found, err)
	}
	connections, err := sanitizeConnections(raw, found)
	if err != nil || len(connections) != 1 || connections[0]["password"] != passwordMask {
		t.Fatalf("connections = %#v err=%v", connections, err)
	}
}
