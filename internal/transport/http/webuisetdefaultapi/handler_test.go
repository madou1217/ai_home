package webuisetdefaultapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
	_ "modernc.org/sqlite"
)

const (
	codexAccountRef  = "acct_0123456789abcdef0123"
	geminiAccountRef = "acct_fedcba98765432100123"
	missingRef       = "acct_aaaaaaaaaaaaaaaaaaaa"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeDefaults struct {
	mu         sync.Mutex
	setCalls   []string
	clearCalls []string
	setErr     error
	clearErr   error
	now        time.Time
}

func (fake *fakeDefaults) Set(
	_ context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (accountcore.ProviderDefault, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.setCalls = append(fake.setCalls, providerID+"/"+accountRef.String())
	if fake.setErr != nil {
		return accountcore.ProviderDefault{}, fake.setErr
	}
	return accountcore.NewProviderDefault(providerID, accountRef, fake.now)
}

func (fake *fakeDefaults) Clear(_ context.Context, providerID string) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.clearCalls = append(fake.clearCalls, providerID)
	return fake.clearErr
}

func (fake *fakeDefaults) setCallsSnapshot() []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]string(nil), fake.setCalls...)
}

func (fake *fakeDefaults) clearCallsSnapshot() []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]string(nil), fake.clearCalls...)
}

type fakeHost struct {
	mu          sync.Mutex
	selectCalls []string
	landCalls   []string
	revokeCalls []string
	selectErr   error
	landErr     error
	revokeErr   error
	revoked     bool
}

func (fake *fakeHost) SelectAccount(
	_ context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.selectCalls = append(fake.selectCalls, providerID+"/"+accountRef.String())
	return fake.selectErr
}

func (fake *fakeHost) LandGateway(_ context.Context, providerID string) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.landCalls = append(fake.landCalls, providerID)
	return fake.landErr
}

func (fake *fakeHost) RevokeGrant(
	_ context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (bool, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.revokeCalls = append(fake.revokeCalls, providerID+"/"+accountRef.String())
	return fake.revoked, fake.revokeErr
}

func (fake *fakeHost) calls(kind string) []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	switch kind {
	case "select":
		return append([]string(nil), fake.selectCalls...)
	case "land":
		return append([]string(nil), fake.landCalls...)
	default:
		return append([]string(nil), fake.revokeCalls...)
	}
}

func testCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

// seed 建 app-state.db 的最小表：账号台账 + app_kv（落点指针）。
func seed(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	database, err := sql.Open("sqlite", filepath.Join(directory, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = database.Close() }()
	for _, statement := range []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
	} {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	if _, err := database.Exec(
		"INSERT INTO account_refs VALUES (?, 'codex', 1, 1)", codexAccountRef,
	); err != nil {
		t.Fatalf("insert codex account: %v", err)
	}
	if _, err := database.Exec(
		"INSERT INTO account_refs VALUES (?, 'gemini', 1, 1)", geminiAccountRef,
	); err != nil {
		t.Fatalf("insert gemini account: %v", err)
	}
	return directory
}

func seedLanding(t *testing.T, aiHomeDir string, provider string) {
	t.Helper()
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	if err := appstate.WriteKV(
		context.Background(),
		databasePath,
		aihdefault.ProviderDefaultKey(provider),
		"\".aih-server\"",
		1,
	); err != nil {
		t.Fatalf("seed landing pointer: %v", err)
	}
}

func readLanding(t *testing.T, aiHomeDir string, provider string) (string, bool) {
	t.Helper()
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	raw, found, err := appstate.ReadKV(
		context.Background(), databasePath, aihdefault.ProviderDefaultKey(provider),
	)
	if err != nil {
		t.Fatalf("ReadKV() error = %v", err)
	}
	if !found {
		return "", false
	}
	var value string
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatalf("decode landing pointer %q: %v", raw, err)
	}
	return value, true
}

func newTestHandler(t *testing.T, dependencies Dependencies) (*Handler, http.Handler) {
	t.Helper()
	dependencies.Authorizer = fakeAuthorizer{allowed: true}
	dependencies.Catalog = testCatalog(t)
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+SetDefaultRouteSuffix, handler)
	mux.Handle("POST "+Path+ClearDefaultRouteSuffix, handler)
	return handler, mux
}

func post(t *testing.T, handler http.Handler, path string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, nil))
	var decoded map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, decoded
}

func TestSetDefaultReturns501WhenHostProjectionMissing(t *testing.T) {
	directory := seed(t)
	seedLanding(t, directory, "codex")
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	_, handler := newTestHandler(t, Dependencies{AIHomeDir: directory, Defaults: defaults})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/set-default")
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "host_projection_unavailable" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if len(defaults.setCallsSnapshot()) != 0 {
		t.Fatal("投影不可用时不能先写默认关系")
	}
	if value, found := readLanding(t, directory, "codex"); !found || value != aihdefault.ServerProfileID {
		t.Fatalf("投影不可用时不能改动落点指针，got %q found=%v", value, found)
	}
}

func TestSetDefaultWiresRelationHostAndPointer(t *testing.T) {
	directory := seed(t)
	seedLanding(t, directory, "codex")
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	host := &fakeHost{}
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir:    directory,
		Defaults:     defaults,
		HostSelector: host,
		HostGate:     host,
		HostGrant:    host,
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/set-default")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["ok"] != true || decoded["provider"] != "codex" ||
		decoded["accountRef"] != codexAccountRef {
		t.Fatalf("response = %v", decoded)
	}
	if calls := defaults.setCallsSnapshot(); len(calls) != 1 ||
		calls[0] != "codex/"+codexAccountRef {
		t.Fatalf("Set calls = %v", calls)
	}
	if calls := host.calls("select"); len(calls) != 1 ||
		calls[0] != "codex/"+codexAccountRef {
		t.Fatalf("SelectAccount calls = %v", calls)
	}
	if value, found := readLanding(t, directory, "codex"); found {
		t.Fatalf("显式默认必须撤掉落点指针，got %q", value)
	}
}

func TestSetDefaultRejectsProviderMismatch(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	host := &fakeHost{}
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir:    directory,
		Defaults:     defaults,
		HostSelector: host,
	})

	recorder, decoded := post(t, handler, Path+"/claude/"+codexAccountRef+"/set-default")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "account_provider_mismatch" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if len(defaults.setCallsSnapshot()) != 0 || len(host.calls("select")) != 0 {
		t.Fatal("归属不匹配时不能写默认关系或宿主配置")
	}
}

func TestSetDefaultUnknownAccount(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	host := &fakeHost{}
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir:    directory,
		Defaults:     defaults,
		HostSelector: host,
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+missingRef+"/set-default")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "account_not_found" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if len(host.calls("select")) != 0 {
		t.Fatal("账号不存在时不能触碰宿主")
	}
}

func TestSetDefaultMapsRelationConflictTo409(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{
		now:    time.UnixMilli(1_800_000_000_000).UTC(),
		setErr: accountapp.ErrProviderDefaultConflict,
	}
	host := &fakeHost{}
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir:    directory,
		Defaults:     defaults,
		HostSelector: host,
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/set-default")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "default_provider_conflict" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if len(host.calls("select")) != 0 {
		t.Fatal("默认关系写入失败后不能改宿主配置")
	}
}

func TestSetDefaultReportsHostFailureWithoutClearingLanding(t *testing.T) {
	directory := seed(t)
	seedLanding(t, directory, "codex")
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	host := &fakeHost{selectErr: errors.New("boom")}
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir:    directory,
		Defaults:     defaults,
		HostSelector: host,
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/set-default")
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "set_default_host_sync_failed" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if value, found := readLanding(t, directory, "codex"); !found || value != aihdefault.ServerProfileID {
		t.Fatalf("宿主钉选失败时不能先撤落点指针，got %q found=%v", value, found)
	}
}

func TestClearDefaultReturns501WhenHostProjectionMissing(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	_, handler := newTestHandler(t, Dependencies{AIHomeDir: directory, Defaults: defaults})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/clear-default")
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "host_projection_unavailable" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if len(defaults.clearCallsSnapshot()) != 0 {
		t.Fatal("投影不可用时不能先清默认关系")
	}
}

func TestClearDefaultClearsRelationRevokesGrantAndLands(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	host := &fakeHost{revoked: true}
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir:    directory,
		Defaults:     defaults,
		HostSelector: host,
		HostGate:     host,
		HostGrant:    host,
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/clear-default")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if calls := defaults.clearCallsSnapshot(); len(calls) != 1 || calls[0] != "codex" {
		t.Fatalf("Clear calls = %v", calls)
	}
	if calls := host.calls("revoke"); len(calls) != 1 ||
		calls[0] != "codex/"+codexAccountRef {
		t.Fatalf("RevokeGrant calls = %v", calls)
	}
	if calls := host.calls("land"); len(calls) != 1 || calls[0] != "codex" {
		t.Fatalf("LandGateway calls = %v", calls)
	}
	if decoded["hostGrantRevoked"] != true {
		t.Fatalf("hostGrantRevoked = %v", decoded["hostGrantRevoked"])
	}
	landing, ok := decoded["aiServerDefault"].(map[string]any)
	if !ok || landing["landed"] != true || landing["profile"] != aihdefault.ServerProfileID {
		t.Fatalf("aiServerDefault = %v", decoded["aiServerDefault"])
	}
	if value, found := readLanding(t, directory, "codex"); !found || value != aihdefault.ServerProfileID {
		t.Fatalf("clear-default 必须落回 AIH Server，got %q found=%v", value, found)
	}
}

func TestClearDefaultSkipsLandingForProviderWithoutGatewayProfile(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	_, handler := newTestHandler(t, Dependencies{AIHomeDir: directory, Defaults: defaults})

	recorder, decoded := post(t, handler, Path+"/gemini/"+geminiAccountRef+"/clear-default")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(defaults.clearCallsSnapshot()) != 1 {
		t.Fatal("非网关档 Provider 也必须清除默认关系")
	}
	landing, ok := decoded["aiServerDefault"].(map[string]any)
	if !ok || landing["landed"] != false ||
		landing["reason"] != aihdefault.CodeProfileUnsupported {
		t.Fatalf("aiServerDefault = %v", decoded["aiServerDefault"])
	}
	if _, exists := decoded["hostGrantRevoked"]; exists {
		t.Fatal("没有授权钩子时不应伪造 hostGrantRevoked")
	}
}

func TestClearDefaultMapsHostStateConflictTo409(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	host := &fakeHost{landErr: &aihdefault.Error{Code: aihdefault.CodeHostConfigChanged}}
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir: directory,
		Defaults:  defaults,
		HostGate:  host,
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/clear-default")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "gateway_default_host_config_changed" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if _, found := readLanding(t, directory, "codex"); found {
		t.Fatal("宿主同步失败时不能记落点档位")
	}
}

func TestClearDefaultReportsLandingSyncFailure(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	host := &fakeHost{landErr: errors.New("boom")}
	_, handler := newTestHandler(t, Dependencies{
		AIHomeDir: directory,
		Defaults:  defaults,
		HostGate:  host,
	})

	recorder, decoded := post(t, handler, Path+"/codex/"+codexAccountRef+"/clear-default")
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "gateway_config_sync_failed" {
		t.Fatalf("error = %v", decoded["error"])
	}
}

func TestHandlerRejectsNonPostAndUnauthorized(t *testing.T) {
	directory := seed(t)
	defaults := &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  directory,
		Catalog:    testCatalog(t),
		Defaults:   defaults,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, Path+"/codex/"+codexAccountRef+"/set-default", nil)
	request.SetPathValue("provider", "codex")
	request.SetPathValue("accountRef", codexAccountRef)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", recorder.Code)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q", allow)
	}

	unauthorized, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		AIHomeDir:  directory,
		Catalog:    testCatalog(t),
		Defaults:   defaults,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request = httptest.NewRequest(http.MethodPost, Path+"/codex/"+codexAccountRef+"/set-default", nil)
	request.SetPathValue("provider", "codex")
	request.SetPathValue("accountRef", codexAccountRef)
	recorder = httptest.NewRecorder()
	unauthorized.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	if len(defaults.setCallsSnapshot()) != 0 {
		t.Fatal("未授权请求不能写默认关系")
	}
}

func TestHandlerRejectsUnknownRoute(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  t.TempDir(),
		Catalog:    testCatalog(t),
		Defaults:   &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path+"/codex/x/other", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestNewHandlerRejectsInvalidDependencies(t *testing.T) {
	valid := Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  t.TempDir(),
		Catalog:    testCatalog(t),
		Defaults:   &fakeDefaults{now: time.UnixMilli(1_800_000_000_000).UTC()},
	}
	cases := map[string]Dependencies{
		"nil authorizer": {AIHomeDir: valid.AIHomeDir, Catalog: valid.Catalog, Defaults: valid.Defaults},
		"empty root":     {Authorizer: valid.Authorizer, Catalog: valid.Catalog, Defaults: valid.Defaults},
		"nil catalog":    {Authorizer: valid.Authorizer, AIHomeDir: valid.AIHomeDir, Defaults: valid.Defaults},
		"nil defaults":   {Authorizer: valid.Authorizer, AIHomeDir: valid.AIHomeDir, Catalog: valid.Catalog},
	}
	for name, dependencies := range cases {
		if _, err := NewHandler(dependencies); !errors.Is(err, ErrInvalidDependencies) {
			t.Fatalf("%s: error = %v, want ErrInvalidDependencies", name, err)
		}
	}
}
