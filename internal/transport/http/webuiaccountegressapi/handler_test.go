package webuiaccountegressapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/agy/egress"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

const (
	accountRef = "acct_0123456789abcdef0123"
	otherRef   = "acct_fedcba98765432100123"
)

func seed(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(directory, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, statement := range []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	if _, err := db.Exec("INSERT INTO account_refs VALUES (?, 'zcode', 1, 1)", accountRef); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	return directory
}

func newCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func newHandler(t *testing.T, aiHomeDir string) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  aiHomeDir,
		Catalog:    newCatalog(t),
		Store:      egress.NewStore(aiHomeDir),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/egress", handler)
	mux.Handle("POST "+Path+"/{provider}/{accountRef}/egress", handler)
	return mux
}

func post(t *testing.T, handler http.Handler, path string, payload any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body)))
	return recorder, decode(t, recorder)
}

func get(t *testing.T, handler http.Handler, path string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder, decode(t, recorder)
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var decoded map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return decoded
}

func readKV(t *testing.T, aiHomeDir string, key string) (map[string]any, bool) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(aiHomeDir, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	var raw string
	err = db.QueryRow("SELECT value FROM app_kv WHERE key = ?", key).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, false
	}
	if err != nil {
		t.Fatalf("read kv: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("decode kv: %v", err)
	}
	return decoded, true
}

func TestReadUnbound(t *testing.T) {
	handler := newHandler(t, seed(t))
	recorder, payload := get(t, handler, Path+"/zcode/"+accountRef+"/egress")
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("status=%d payload=%#v", recorder.Code, payload)
	}
	if value, exists := payload["binding"]; !exists || value != nil {
		t.Fatalf("binding = %#v，期望显式 null", payload["binding"])
	}
}

func TestWriteURLBindingAndReadBack(t *testing.T) {
	aiHomeDir := seed(t)
	handler := newHandler(t, aiHomeDir)
	recorder, payload := post(t, handler, Path+"/zcode/"+accountRef+"/egress", map[string]any{
		"mode": "url", "proxyUrl": "http://127.0.0.1:7890",
	})
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("status=%d payload=%#v", recorder.Code, payload)
	}
	binding := payload["binding"].(map[string]any)
	if binding["mode"] != "url" || binding["proxyUrl"] != "http://127.0.0.1:7890" || binding["updatedAt"] == float64(0) {
		t.Fatalf("binding = %#v", binding)
	}
	stored, found := readKV(t, aiHomeDir, "account:egress:"+accountRef)
	if !found || stored["mode"] != "url" || stored["proxyUrl"] != "http://127.0.0.1:7890" {
		t.Fatalf("stored = %#v found=%v", stored, found)
	}
	recorder, payload = get(t, handler, Path+"/zcode/"+accountRef+"/egress")
	if recorder.Code != http.StatusOK {
		t.Fatalf("read status = %d", recorder.Code)
	}
	if payload["binding"].(map[string]any)["proxyUrl"] != "http://127.0.0.1:7890" {
		t.Fatalf("read binding = %#v", payload["binding"])
	}
}

func TestWritePoolBindingMirrorsAssignment(t *testing.T) {
	aiHomeDir := seed(t)
	handler := newHandler(t, aiHomeDir)
	recorder, payload := post(t, handler, Path+"/zcode/"+accountRef+"/egress", map[string]any{
		"mode": "pool",
		"scope": map[string]any{
			"kind":   "groups",
			"groups": []string{"pool-group-a", "pool-group-a", "pool-group-b"},
			"nodes":  []string{"ignored"},
		},
		"strategy": "sticky",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d payload=%#v", recorder.Code, payload)
	}
	binding := payload["binding"].(map[string]any)
	scope := binding["scope"].(map[string]any)
	if binding["mode"] != "pool" || binding["proxyUrl"] != "" || binding["strategy"] != "sticky" {
		t.Fatalf("binding = %#v", binding)
	}
	if scope["kind"] != "groups" || len(scope["groups"].([]any)) != 2 || len(scope["nodes"].([]any)) != 0 {
		t.Fatalf("scope = %#v", scope)
	}
	assignment, found := readKV(t, aiHomeDir, "egress:entity:assignment:"+accountRef)
	if !found {
		t.Fatal("分配投影未写入")
	}
	if assignment["accountRef"] != accountRef || assignment["selectionMode"] != "auto" ||
		assignment["strategy"] != "sticky" || assignment["fallbackPolicy"] != "none" {
		t.Fatalf("assignment = %#v", assignment)
	}
}

func TestClearBindingAlsoClearsAssignment(t *testing.T) {
	aiHomeDir := seed(t)
	handler := newHandler(t, aiHomeDir)
	if recorder, _ := post(t, handler, Path+"/zcode/"+accountRef+"/egress", map[string]any{"mode": "pool"}); recorder.Code != http.StatusOK {
		t.Fatalf("pool write status = %d", recorder.Code)
	}
	recorder, payload := post(t, handler, Path+"/zcode/"+accountRef+"/egress", map[string]any{"mode": "url", "proxyUrl": ""})
	if recorder.Code != http.StatusOK || payload["binding"] != nil {
		t.Fatalf("clear status=%d payload=%#v", recorder.Code, payload)
	}
	if _, found := readKV(t, aiHomeDir, "account:egress:"+accountRef); found {
		t.Fatal("绑定记录未删除")
	}
	if _, found := readKV(t, aiHomeDir, "egress:entity:assignment:"+accountRef); found {
		t.Fatal("分配投影未删除")
	}
	if previous, _ := payload["previous"].(map[string]any); previous == nil || previous["mode"] != "pool" {
		t.Fatalf("previous = %#v", payload["previous"])
	}
}

func TestWriteRejectsInvalidInput(t *testing.T) {
	handler := newHandler(t, seed(t))
	path := Path + "/zcode/" + accountRef + "/egress"

	recorder, payload := post(t, handler, path, map[string]any{"mode": "tunnel"})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "invalid_egress_mode" {
		t.Fatalf("mode status=%d payload=%#v", recorder.Code, payload)
	}
	recorder, payload = post(t, handler, path, map[string]any{"mode": "url", "proxyUrl": "ftp://127.0.0.1:21"})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "proxy_scheme_unsupported" {
		t.Fatalf("scheme status=%d payload=%#v", recorder.Code, payload)
	}
	recorder, payload = post(t, handler, path, map[string]any{"mode": "url", "proxyUrl": "http://user:pass@127.0.0.1:7890"})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "invalid_proxy_url" {
		t.Fatalf("credentials status=%d payload=%#v", recorder.Code, payload)
	}
	recorder, payload = post(t, handler, path, []int{1})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "invalid_request_body" {
		t.Fatalf("array status=%d payload=%#v", recorder.Code, payload)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte("{"))))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid json status = %d", recorder.Code)
	}
}

func TestProviderSchemeNarrowing(t *testing.T) {
	handler := newHandler(t, seed(t))
	recorder, payload := post(t, handler, Path+"/zcode/"+accountRef+"/egress", map[string]any{
		"mode": "url", "proxyUrl": "socks5://127.0.0.1:1080",
	})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "zcode_native_proxy_scheme_unsupported" {
		t.Fatalf("zcode socks status=%d payload=%#v", recorder.Code, payload)
	}
}

func TestAccountAndProviderErrors(t *testing.T) {
	handler := newHandler(t, seed(t))
	recorder, payload := get(t, handler, Path+"/codex/"+accountRef+"/egress")
	if recorder.Code != http.StatusConflict || payload["error"] != "account_provider_mismatch" {
		t.Fatalf("mismatch status=%d payload=%#v", recorder.Code, payload)
	}
	recorder, payload = get(t, handler, Path+"/zcode/"+otherRef+"/egress")
	if recorder.Code != http.StatusNotFound || payload["error"] != "account_not_found" {
		t.Fatalf("missing status=%d payload=%#v", recorder.Code, payload)
	}
	recorder, payload = get(t, handler, Path+"/not-a-provider/"+accountRef+"/egress")
	if recorder.Code != http.StatusBadRequest || payload["error"] != "egress_unsupported_provider" {
		t.Fatalf("provider status=%d payload=%#v", recorder.Code, payload)
	}
}

func TestRetiredBindingIsReadableButNotWritable(t *testing.T) {
	aiHomeDir := seed(t)
	db, err := sql.Open("sqlite", filepath.Join(aiHomeDir, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	retired := `{"mode":"node","nodeId":"old-node","proxyUrl":""}`
	if _, err := db.Exec("INSERT INTO app_kv VALUES (?, ?, 1)", "account:egress:"+accountRef, retired); err != nil {
		t.Fatalf("seed retired: %v", err)
	}
	_ = db.Close()

	handler := newHandler(t, aiHomeDir)
	recorder, payload := get(t, handler, Path+"/zcode/"+accountRef+"/egress")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	binding := payload["binding"].(map[string]any)
	if binding["retired"] != true || binding["mode"] != "node" || binding["nodeId"] != "old-node" {
		t.Fatalf("binding = %#v", binding)
	}
	// 写入侧不接受历史模式：只能改绑或解绑。
	recorder, payload = post(t, handler, Path+"/zcode/"+accountRef+"/egress", map[string]any{"mode": "node"})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "invalid_egress_mode" {
		t.Fatalf("retired write status=%d payload=%#v", recorder.Code, payload)
	}
}

func TestRequiresAuthorization(t *testing.T) {
	aiHomeDir := seed(t)
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{},
		AIHomeDir:  aiHomeDir,
		Catalog:    newCatalog(t),
		Store:      egress.NewStore(aiHomeDir),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/egress", handler)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/zcode/"+accountRef+"/egress", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
}
