package webuimobileaccountapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const (
	testAccountRef  = "acct_0123456789abcdef0123"
	otherAccountRef = "acct_ffffffffffffffffffff"

	validNativeAuth = `{"auth":{"auth_mode":"chatgpt","tokens":{"access_token":"at","refresh_token":"rt","id_token":"id"}}}`
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

// newAppState 创建带 account_refs/account_credentials 的临时 app-state.db。
func newAppState(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(directory, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, statement := range []string{
		`CREATE TABLE account_refs (
			account_ref TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE account_credentials (
			account_ref TEXT PRIMARY KEY,
			env_json TEXT NOT NULL DEFAULT '{}',
			native_auth_json TEXT NOT NULL DEFAULT '{}',
			env_updated_at INTEGER NOT NULL DEFAULT 0,
			native_auth_updated_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL
		)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	return directory
}

func insertAccount(t *testing.T, directory string, provider string, accountRef string, nativeAuth string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(directory, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(
		`INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
		 VALUES (?, ?, 1, 1)`, accountRef, provider,
	); err != nil {
		t.Fatalf("insert account_refs: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO account_credentials
		 (account_ref, env_json, native_auth_json, env_updated_at, native_auth_updated_at, updated_at)
		 VALUES (?, '{}', ?, 0, 0, 1)`, accountRef, nativeAuth,
	); err != nil {
		t.Fatalf("insert account_credentials: %v", err)
	}
}

func newMux(t *testing.T, aiHomeDir string, setMobile bool, allowed bool) http.Handler {
	t.Helper()
	dependencies := Dependencies{
		Authorizer: fakeAuthorizer{allowed: allowed},
		AIHomeDir:  aiHomeDir,
	}
	var (
		handler *Handler
		err     error
		pattern string
	)
	if setMobile {
		handler, err = NewSetMobileHandler(dependencies)
		pattern = SetMobilePath
	} else {
		handler, err = NewClearMobileHandler(dependencies)
		pattern = ClearMobilePath
	}
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+pattern, handler)
	return mux
}

func requestPath(provider string, accountRef string, setMobile bool) string {
	if setMobile {
		return Path + "/" + provider + "/" + accountRef + "/set-mobile"
	}
	return Path + "/" + provider + "/" + accountRef + "/clear-mobile"
}

func post(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, nil))
	return recorder
}

func decodeSuccess(t *testing.T, recorder *httptest.ResponseRecorder) successResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var payload successResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.OK {
		t.Fatalf("ok = false: %s", recorder.Body.String())
	}
	return payload
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) errorResponse {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d body=%s", recorder.Code, status, recorder.Body.String())
	}
	var payload errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.OK || payload.Error != code {
		t.Fatalf("payload = %+v", payload)
	}
	return payload
}

func writeStateFile(t *testing.T, aiHomeDir string, state map[string]any) string {
	t.Helper()
	path := HookStatePath(aiHomeDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	payload, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatalf("write state: %v", err)
	}
	return path
}

func readStateFile(t *testing.T, path string) map[string]any {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	var state map[string]any
	if err := json.Unmarshal(payload, &state); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	return state
}

func TestSetMobilePersistsTargetAndIsIdempotent(t *testing.T) {
	directory := newAppState(t)
	insertAccount(t, directory, "codex", testAccountRef, validNativeAuth)
	statePath := writeStateFile(t, directory, map[string]any{
		"version":           2,
		"enabled":           true,
		"bundlePath":        "/Applications/ChatGPT.app",
		"desktopAccountRef": "",
		"updatedAt":         "2026-01-01T00:00:00.000Z",
		"custom":            map[string]any{"keep": true},
	})
	handler := newMux(t, directory, true, true)

	first := decodeSuccess(t, post(t, handler, requestPath("codex", testAccountRef, true)))
	if !first.Changed || first.DesktopAccountRef != testAccountRef {
		t.Fatalf("first response = %+v", first)
	}
	afterFirst := readStateFile(t, statePath)
	if afterFirst["desktopAccountRef"] != testAccountRef {
		t.Fatalf("desktopAccountRef = %v", afterFirst["desktopAccountRef"])
	}
	if afterFirst["version"] != float64(2) || afterFirst["enabled"] != true {
		t.Fatalf("保留字段被改写: %+v", afterFirst)
	}
	if afterFirst["bundlePath"] != "/Applications/ChatGPT.app" {
		t.Fatalf("bundlePath = %v", afterFirst["bundlePath"])
	}
	custom, _ := afterFirst["custom"].(map[string]any)
	if custom["keep"] != true {
		t.Fatalf("custom 丢失: %+v", afterFirst["custom"])
	}
	firstUpdatedAt := afterFirst["updatedAt"]

	second := decodeSuccess(t, post(t, handler, requestPath("codex", testAccountRef, true)))
	if second.Changed {
		t.Fatalf("重复设置必须 changed=false: %+v", second)
	}
	afterSecond := readStateFile(t, statePath)
	if afterSecond["updatedAt"] != firstUpdatedAt {
		t.Fatalf("幂等调用不应刷新 updatedAt: %v -> %v", firstUpdatedAt, afterSecond["updatedAt"])
	}
}

func TestClearMobileOnlyClearsMatchingAccount(t *testing.T) {
	directory := newAppState(t)
	insertAccount(t, directory, "codex", testAccountRef, validNativeAuth)
	statePath := writeStateFile(t, directory, map[string]any{
		"version":           2,
		"desktopAccountRef": otherAccountRef,
		"custom":            "keep-me",
	})
	handler := newMux(t, directory, false, true)

	mismatch := decodeSuccess(t, post(t, handler, requestPath("codex", testAccountRef, false)))
	if mismatch.Changed || mismatch.DesktopAccountRef != otherAccountRef {
		t.Fatalf("指向其它账号时不能清空: %+v", mismatch)
	}
	if readStateFile(t, statePath)["desktopAccountRef"] != otherAccountRef {
		t.Fatalf("状态文件被误改")
	}

	writeStateFile(t, directory, map[string]any{
		"version":           2,
		"desktopAccountRef": testAccountRef,
		"custom":            "keep-me",
	})
	cleared := decodeSuccess(t, post(t, handler, requestPath("codex", testAccountRef, false)))
	if !cleared.Changed || cleared.DesktopAccountRef != "" {
		t.Fatalf("cleared = %+v", cleared)
	}
	afterClear := readStateFile(t, statePath)
	if afterClear["desktopAccountRef"] != "" {
		t.Fatalf("desktopAccountRef = %v", afterClear["desktopAccountRef"])
	}
	if afterClear["custom"] != "keep-me" || afterClear["version"] != float64(2) {
		t.Fatalf("保留字段被改写: %+v", afterClear)
	}

	again := decodeSuccess(t, post(t, handler, requestPath("codex", testAccountRef, false)))
	if again.Changed {
		t.Fatalf("重复清空必须 changed=false: %+v", again)
	}
}

func TestSetMobileRejectsCredentialWithoutOAuth(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		nativeAuth string
	}{
		{name: "api key", nativeAuth: `{"auth":{"OPENAI_API_KEY":"sk-test"}}`},
		{name: "empty tokens", nativeAuth: `{"auth":{"tokens":{}}}`},
		{name: "missing auth", nativeAuth: `{}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			directory := newAppState(t)
			insertAccount(t, directory, "codex", testAccountRef, testCase.nativeAuth)
			handler := newMux(t, directory, true, true)

			recorder := post(t, handler, requestPath("codex", testAccountRef, true))
			payload := decodeError(t, recorder, http.StatusBadRequest, "mobile_account_invalid")
			if payload.Code != "missing_codex_desktop_oauth" {
				t.Fatalf("code = %q", payload.Code)
			}
			if _, err := os.Stat(HookStatePath(directory)); !os.IsNotExist(err) {
				t.Fatalf("校验失败不应写状态文件, stat err=%v", err)
			}
		})
	}
}

func TestSetMobileCreatesStateFileWhenMissing(t *testing.T) {
	directory := newAppState(t)
	insertAccount(t, directory, "codex", testAccountRef, validNativeAuth)
	handler := newMux(t, directory, true, true)

	payload := decodeSuccess(t, post(t, handler, requestPath("codex", testAccountRef, true)))
	if !payload.Changed {
		t.Fatalf("changed = false")
	}
	state := readStateFile(t, HookStatePath(directory))
	if state["desktopAccountRef"] != testAccountRef {
		t.Fatalf("state = %+v", state)
	}
}

func TestSetMobileRefusesToClobberInvalidStateFile(t *testing.T) {
	directory := newAppState(t)
	insertAccount(t, directory, "codex", testAccountRef, validNativeAuth)
	path := HookStatePath(directory)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	handler := newMux(t, directory, true, true)

	recorder := post(t, handler, requestPath("codex", testAccountRef, true))
	payload := decodeError(t, recorder, http.StatusInternalServerError, "set_mobile_failed")
	if payload.Reason != "state_file_invalid" {
		t.Fatalf("reason = %q", payload.Reason)
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "{not json" {
		t.Fatalf("非法状态文件被覆盖: %q err=%v", content, err)
	}
}

func TestMobileAccountRoutingErrors(t *testing.T) {
	directory := newAppState(t)
	insertAccount(t, directory, "codex", otherAccountRef, validNativeAuth)
	handler := newMux(t, directory, true, true)

	t.Run("unsupported provider", func(t *testing.T) {
		decodeError(t, post(t, handler, requestPath("claude", testAccountRef, true)),
			http.StatusBadRequest, "mobile_account_unsupported")
	})
	t.Run("unknown account", func(t *testing.T) {
		decodeError(t, post(t, handler, requestPath("codex", testAccountRef, true)),
			http.StatusNotFound, "account_not_found")
	})
	t.Run("invalid account ref", func(t *testing.T) {
		decodeError(t, post(t, handler, requestPath("codex", "not-an-account", true)),
			http.StatusBadRequest, "invalid_account_path")
	})
	t.Run("unauthorized", func(t *testing.T) {
		protected := newMux(t, directory, true, false)
		decodeError(t, post(t, protected, requestPath("codex", testAccountRef, true)),
			http.StatusUnauthorized, "unauthorized")
	})
}
