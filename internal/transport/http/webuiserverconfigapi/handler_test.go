package webuiserverconfigapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeStore struct {
	raw      string
	found    bool
	err      error
	written  *string
	writeErr error
}

func (fake fakeStore) ReadServerConfig(context.Context) (string, bool, error) {
	return fake.raw, fake.found, fake.err
}

func (fake fakeStore) UpdateServerConfig(_ context.Context, mutate func(current string, found bool) (string, error)) error {
	if fake.writeErr != nil {
		return fake.writeErr
	}
	next, err := mutate(fake.raw, fake.found)
	if err == nil && fake.written != nil {
		*fake.written = next
	}
	return err
}

func newHandler(t *testing.T, store Store) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func asMap(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return result
}

// TestParityFixture 读 Node 生成的同一份夹具：两边规则必须逐字段一致。
func TestParityFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "test", "fixtures", "server-config-sanitize-cases.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []struct {
		Name   string         `json:"name"`
		Input  map[string]any `json:"input"`
		Public map[string]any `json:"public"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	for _, testCase := range cases {
		t.Run(testCase.Name, func(t *testing.T) {
			inputJSON, err := json.Marshal(testCase.Input)
			if err != nil {
				t.Fatalf("marshal input: %v", err)
			}
			config, err := sanitizeServerConfigFromJSON(string(inputJSON), true)
			if err != nil {
				t.Fatalf("sanitize: %v", err)
			}
			actual := asMap(t, config)
			if !reflect.DeepEqual(actual, testCase.Public) {
				t.Fatalf("config mismatch\nactual: %#v\nwant:   %#v", actual, testCase.Public)
			}
		})
	}
}

func TestMissingConfigUsesDefaults(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var payload struct {
		OK     bool       `json:"ok"`
		Config ConfigView `json:"config"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.OK || payload.Config.Host != defaultServerHost || payload.Config.Port != defaultServerPort {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestSecretsAreHidden(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: `{"apiKey":" secret ","managementKey":" mgmt "}`, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	var payload struct {
		Config ConfigView `json:"config"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Config.APIKey != "" || payload.Config.ManagementKey != "" {
		t.Fatalf("secrets leaked: %#v", payload.Config)
	}
	if !payload.Config.APIKeyConfigured || !payload.Config.ManagementKeyConfigured {
		t.Fatalf("configured flags = %#v", payload.Config)
	}
}

func TestInvalidJSONIsRejected(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: "{", found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
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
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT status = %d", recorder.Code)
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
	if _, err := db.Exec("INSERT INTO app_kv (key, value, updated_at) VALUES ('config:server', '{\"port\":8080}', 1)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	source, err := OpenSource(directory)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	raw, found, err := source.ReadServerConfig(context.Background())
	if err != nil || !found {
		t.Fatalf("ReadServerConfig() found=%v err=%v", found, err)
	}
	config, err := sanitizeServerConfigFromJSON(raw, found)
	if err != nil || config.Port != 8080 {
		t.Fatalf("config = %#v err=%v", config, err)
	}
}

func postServerConfig(t *testing.T, handler http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body)))
	return recorder
}

func TestWriteMergesSanitizesAndHidesSecrets(t *testing.T) {
	written := ""
	store := fakeStore{
		raw:     "{\"maxAttempts\":7,\"apiKey\":\"sk-old\",\"managementKey\":\"mgmt\",\"host\":\"127.0.0.1\"}",
		found:   true,
		written: &written,
	}
	handler := newHandler(t, store)
	recorder := postServerConfig(t, handler, "{\"config\":{\"maxAttempts\":9,\"apiKey\":\"sk-new\",\"port\":8080,\"modelsProbeAccounts\":99,\"unknown\":\"x\"}}")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(written), &stored); err != nil {
		t.Fatalf("written = %q: %v", written, err)
	}
	if stored["maxAttempts"] != float64(9) || stored["apiKey"] != "sk-new" || stored["managementKey"] != "mgmt" {
		t.Fatalf("stored = %#v", stored)
	}
	if stored["port"] != float64(8080) || stored["modelsProbeAccounts"] != float64(8) {
		t.Fatalf("stored = %#v", stored)
	}
	if _, exists := stored["unknown"]; exists {
		t.Fatalf("unknown key leaked: %#v", stored)
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	config := response["config"].(map[string]any)
	if config["apiKey"] != "" || config["managementKey"] != "" {
		t.Fatalf("secrets leaked: %#v", config)
	}
	if config["apiKeyConfigured"] != true || config["managementKeyConfigured"] != true {
		t.Fatalf("configured flags = %#v", config)
	}
}

func TestWriteRejectsManagementKeyAndEmptySecret(t *testing.T) {
	written := ""
	handler := newHandler(t, fakeStore{raw: "{\"apiKey\":\"sk-old\"}", found: true, written: &written})
	recorder := postServerConfig(t, handler, "{\"config\":{\"managementKey\":\"new-key\"}}")
	if recorder.Code != http.StatusBadRequest || written != "" {
		t.Fatalf("status = %d written = %q", recorder.Code, written)
	}
	recorder = postServerConfig(t, handler, "{\"config\":{\"apiKey\":\"   \"}}")
	if recorder.Code != http.StatusOK {
		t.Fatalf("empty apiKey status = %d", recorder.Code)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(written), &stored); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if stored["apiKey"] != "sk-old" {
		t.Fatalf("apiKey was cleared: %#v", stored)
	}
}

func TestWriteOpenNetworkFalseRestoresDefaultHost(t *testing.T) {
	written := ""
	handler := newHandler(t, fakeStore{raw: "{\"host\":\"0.0.0.0\",\"openNetwork\":true}", found: true, written: &written})
	recorder := postServerConfig(t, handler, "{\"config\":{\"openNetwork\":false}}")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(written), &stored); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if stored["host"] != defaultServerHost || stored["openNetwork"] != false {
		t.Fatalf("stored = %#v", stored)
	}
}

func TestWriteValidation(t *testing.T) {
	handler := newHandler(t, fakeStore{})
	for _, body := range []string{"{}", "{\"config\":null}", "{\"config\":[]}", "{"} {
		recorder := postServerConfig(t, handler, body)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body %s status = %d", body, recorder.Code)
		}
	}
	failing := newHandler(t, fakeStore{writeErr: errors.New("boom")})
	recorder := postServerConfig(t, failing, "{\"config\":{}}")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("write failure status = %d", recorder.Code)
	}
}
