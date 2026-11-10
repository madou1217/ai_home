package webuirestoreschedulingapi

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

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const (
	accountRef = "acct_0123456789abcdef0123"
	otherRef   = "acct_fedcba98765432100123"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeRestorer struct {
	mu   sync.Mutex
	refs []accountcore.AccountRef
	err  error
}

func (fake *fakeRestorer) RestoreScheduling(_ context.Context, ref accountcore.AccountRef) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.refs = append(fake.refs, ref)
	return fake.err
}

func (fake *fakeRestorer) calls() []accountcore.AccountRef {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]accountcore.AccountRef(nil), fake.refs...)
}

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
	if _, err := database.Exec("INSERT INTO account_refs VALUES (?, 'codex', 1, 1)", accountRef); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	return directory
}

func newHandler(t *testing.T, aiHomeDir string, restorer RuntimeRestorer) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  aiHomeDir,
		Runtime:    restorer,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+RouteSuffix, handler)
	return mux
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

func TestRestoreSchedulingClearsTargetAccount(t *testing.T) {
	restorer := &fakeRestorer{}
	handler := newHandler(t, seed(t), restorer)

	recorder, decoded := post(t, handler, Path+"/codex/"+accountRef+"/restore-scheduling")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["ok"] != true {
		t.Fatalf("ok = %v, want true", decoded["ok"])
	}
	calls := restorer.calls()
	if len(calls) != 1 || calls[0].String() != accountRef {
		t.Fatalf("RestoreScheduling calls = %v, want [%s]", calls, accountRef)
	}
}

func TestRestoreSchedulingProviderMatchIsCaseInsensitive(t *testing.T) {
	restorer := &fakeRestorer{}
	handler := newHandler(t, seed(t), restorer)

	recorder, _ := post(t, handler, Path+"/CODEX/"+accountRef+"/restore-scheduling")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(restorer.calls()) != 1 {
		t.Fatal("大写 Provider 也必须命中同一账号")
	}
}

func TestRestoreSchedulingRejectsProviderMismatch(t *testing.T) {
	restorer := &fakeRestorer{}
	handler := newHandler(t, seed(t), restorer)

	recorder, decoded := post(t, handler, Path+"/claude/"+accountRef+"/restore-scheduling")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "account_provider_mismatch" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if len(restorer.calls()) != 0 {
		t.Fatal("归属不匹配时不能触碰运行态")
	}
}

func TestRestoreSchedulingUnknownAccount(t *testing.T) {
	restorer := &fakeRestorer{}
	handler := newHandler(t, seed(t), restorer)

	recorder, decoded := post(t, handler, Path+"/codex/"+otherRef+"/restore-scheduling")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "account_not_found" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if len(restorer.calls()) != 0 {
		t.Fatal("账号不存在时不能触碰运行态")
	}
}

func TestRestoreSchedulingRejectsInvalidAccountRef(t *testing.T) {
	restorer := &fakeRestorer{}
	handler := newHandler(t, seed(t), restorer)

	recorder, decoded := post(t, handler, Path+"/codex/acct_short/restore-scheduling")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "invalid_account_ref" {
		t.Fatalf("error = %v", decoded["error"])
	}
}

func TestRestoreSchedulingRejectsNonPostAndUnauthorized(t *testing.T) {
	restorer := &fakeRestorer{}
	handler := newHandler(t, seed(t), restorer)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/codex/"+accountRef+"/restore-scheduling", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", recorder.Code)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q", allow)
	}

	unauthenticated, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		AIHomeDir:  seed(t),
		Runtime:    restorer,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder = httptest.NewRecorder()
	unauthenticated.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path+"/codex/"+accountRef+"/restore-scheduling", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	if len(restorer.calls()) != 0 {
		t.Fatal("未授权请求不能触碰运行态")
	}
}

func TestRestoreSchedulingReportsRuntimeFailure(t *testing.T) {
	handler := newHandler(t, seed(t), &fakeRestorer{err: errors.New("boom")})

	recorder, decoded := post(t, handler, Path+"/codex/"+accountRef+"/restore-scheduling")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["error"] != "restore_scheduling_failed" {
		t.Fatalf("error = %v", decoded["error"])
	}
}

func TestNewHandlerRejectsInvalidDependencies(t *testing.T) {
	valid := Dependencies{Authorizer: fakeAuthorizer{allowed: true}, AIHomeDir: t.TempDir(), Runtime: &fakeRestorer{}}
	cases := map[string]Dependencies{
		"nil authorizer": {AIHomeDir: valid.AIHomeDir, Runtime: valid.Runtime},
		"nil runtime":    {Authorizer: valid.Authorizer, AIHomeDir: valid.AIHomeDir},
		"empty root":     {Authorizer: valid.Authorizer, Runtime: valid.Runtime},
	}
	for name, dependencies := range cases {
		if _, err := NewHandler(dependencies); !errors.Is(err, ErrInvalidDependencies) {
			t.Fatalf("%s: error = %v, want ErrInvalidDependencies", name, err)
		}
	}
}

// 端到端：真实运行态里的账号阻塞必须被这个入口解除，且额度权重保留。
func TestRestoreSchedulingUnblocksRealRuntime(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	runtimeInstance, err := inmemory.New(func() time.Time { return now })
	if err != nil {
		t.Fatalf("inmemory.New() error = %v", err)
	}
	ref, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		t.Fatal(err)
	}
	route, err := runtimecore.NewModelRoute(ref, "test-model")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	document, err := json.Marshal(map[string]any{
		"lastFailureKind":   "auth_invalid",
		"lastFailureReason": "account_recovery_required:auth_invalid",
		"lastFailureAt":     now.UnixMilli(),
		"authInvalidUntil":  now.Add(time.Hour).UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: ref,
		Document:   document,
		UpdatedAt:  now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtimeInstance.ApplyAccountState(ctx, state); err != nil {
		t.Fatalf("ApplyAccountState() error = %v", err)
	}
	eligibility, err := runtimeInstance.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() {
		t.Fatal("造数据失败：账号应处于阻塞状态")
	}

	handler := newHandler(t, seed(t), runtimeInstance)
	recorder, _ := post(t, handler, Path+"/codex/"+accountRef+"/restore-scheduling")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	eligibility, err = runtimeInstance.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() after restore error = %v", err)
	}
	if !eligibility.Eligible() {
		t.Fatalf("恢复调度后必须重新可征召，实际 = %v", eligibility.Status())
	}
}
