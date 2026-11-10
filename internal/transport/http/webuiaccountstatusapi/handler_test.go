package webuiaccountstatusapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

const (
	accountRef = "acct_0123456789abcdef0123"
	otherRef   = "acct_fedcba98765432100123"
)

// 启停真值由 sqliteaccount.Store 承担；端口形状必须与它保持一致。
var _ accountapp.AccountLifecycleStore = (*sqliteaccount.Store)(nil)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type failingAccounts struct {
	account accountcore.Account
	getErr  error
	setErr  error
}

func (fake failingAccounts) GetByRef(
	context.Context,
	accountcore.AccountRef,
) (accountcore.Account, error) {
	if fake.getErr != nil {
		return accountcore.Account{}, fake.getErr
	}
	return fake.account, nil
}

func (fake failingAccounts) SetEnabled(
	context.Context,
	accountcore.AccountRef,
	bool,
	time.Time,
) (accountcore.Account, error) {
	if fake.setErr != nil {
		return accountcore.Account{}, fake.setErr
	}
	return fake.account, nil
}

func newTestCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func newAccount(
	t *testing.T,
	catalog *providers.Catalog,
	refText string,
	enabled bool,
) accountcore.Account {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(refText)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   "codex",
		CLIAccountID: 1,
		Enabled:      enabled,
		CreatedAt:    time.UnixMilli(100).UTC(),
		UpdatedAt:    time.UnixMilli(100).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}

func newStore(t *testing.T) (*sqliteaccount.Store, accountcore.AccountRef) {
	t.Helper()
	catalog := newTestCatalog(t)
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: t.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	account := newAccount(t, catalog, accountRef, true)
	if err := store.Create(context.Background(), account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	return store, account.Ref()
}

func fixedClock() time.Time { return time.UnixMilli(1_700_000_000_000).UTC() }

func newHandler(t *testing.T, accounts accountapp.AccountLifecycleStore) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Accounts:   accounts,
		Now:        fixedClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+RouteSuffix, handler)
	return mux
}

func postStatus(
	t *testing.T,
	handler http.Handler,
	provider string,
	ref string,
	body string,
) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		Path+"/"+provider+"/"+ref+"/status",
		strings.NewReader(body),
	)
	handler.ServeHTTP(recorder, request)
	var decoded map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, decoded
}

func TestStatusDisablesEnabledAccount(t *testing.T) {
	store, ref := newStore(t)
	handler := newHandler(t, store)

	recorder, decoded := postStatus(t, handler, "codex", ref.String(), `{"status":"down"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["ok"] != true || decoded["status"] != "down" || decoded["enabled"] != false {
		t.Fatalf("body = %v", decoded)
	}
	if decoded["partial"] != true || decoded["accountStateProjection"] != "pending" {
		t.Fatalf("partial marker = %v/%v", decoded["partial"], decoded["accountStateProjection"])
	}
	if updatedAt, _ := decoded["updatedAt"].(float64); int64(updatedAt) != fixedClock().UnixMilli() {
		t.Fatalf("updatedAt = %v, want %d", decoded["updatedAt"], fixedClock().UnixMilli())
	}
	unfilled, ok := decoded["unfilledFields"].([]any)
	if !ok || len(unfilled) != 3 {
		t.Fatalf("unfilledFields = %v", decoded["unfilledFields"])
	}

	account, err := store.GetByRef(context.Background(), ref)
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	if account.Enabled() {
		t.Fatal("accounts.enabled 必须写成 false")
	}
}

func TestStatusEnablesDisabledAccount(t *testing.T) {
	store, ref := newStore(t)
	handler := newHandler(t, store)

	if recorder, _ := postStatus(t, handler, "codex", ref.String(), `{"status":"down"}`); recorder.Code != http.StatusOK {
		t.Fatalf("disable status = %d", recorder.Code)
	}
	recorder, decoded := postStatus(t, handler, "CODEX", ref.String(), `{"status":"UP"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["status"] != "up" || decoded["enabled"] != true || decoded["provider"] != "codex" {
		t.Fatalf("body = %v", decoded)
	}
	account, err := store.GetByRef(context.Background(), ref)
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	if !account.Enabled() {
		t.Fatal("accounts.enabled 必须写成 true")
	}
}

func TestStatusRejectsInvalidStatusWithoutWriting(t *testing.T) {
	store, ref := newStore(t)
	handler := newHandler(t, store)

	for _, body := range []string{
		"",
		"{}",
		`{"status":""}`,
		`{"status":"online"}`,
		`{"status":}`,
		strings.Repeat("a", maxBodyBytes+1),
	} {
		recorder, decoded := postStatus(t, handler, "codex", ref.String(), body)
		if recorder.Code != http.StatusBadRequest || decoded["error"] != "invalid_status" {
			t.Fatalf("body %q: status = %d, error = %v", body, recorder.Code, decoded["error"])
		}
	}
	account, err := store.GetByRef(context.Background(), ref)
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	if !account.Enabled() {
		t.Fatal("非法请求不得修改 accounts.enabled")
	}
}

func TestStatusRejectsUnknownAccount(t *testing.T) {
	store, _ := newStore(t)
	handler := newHandler(t, store)

	recorder, decoded := postStatus(t, handler, "codex", otherRef, `{"status":"down"}`)
	if recorder.Code != http.StatusNotFound || decoded["error"] != "account_not_found" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
}

func TestStatusRejectsProviderMismatch(t *testing.T) {
	store, ref := newStore(t)
	handler := newHandler(t, store)

	recorder, decoded := postStatus(t, handler, "claude", ref.String(), `{"status":"down"}`)
	if recorder.Code != http.StatusConflict || decoded["error"] != "account_provider_mismatch" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	account, err := store.GetByRef(context.Background(), ref)
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	if !account.Enabled() {
		t.Fatal("Provider 不匹配时不得修改 accounts.enabled")
	}
}

func TestStatusRequiresAuthorizationAndPost(t *testing.T) {
	store, ref := newStore(t)

	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Accounts:   store,
		Now:        fixedClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder, decoded := postStatus(t, handler, "codex", ref.String(), `{"status":"down"}`)
	if recorder.Code != http.StatusUnauthorized || decoded["error"] != "unauthorized" {
		t.Fatalf("unauthorized status = %d, error = %v", recorder.Code, decoded["error"])
	}

	allowed, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Accounts:   store,
		Now:        fixedClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/irrelevant", nil)
	request.SetPathValue("provider", "codex")
	request.SetPathValue("accountRef", ref.String())
	methodRecorder := httptest.NewRecorder()
	allowed.ServeHTTP(methodRecorder, request)
	if methodRecorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method status = %d", methodRecorder.Code)
	}
}

func TestStatusMapsStoreFailures(t *testing.T) {
	catalog := newTestCatalog(t)
	account := newAccount(t, catalog, accountRef, true)

	readHandler := newHandler(t, failingAccounts{account: account, getErr: errors.New("boom")})
	recorder, decoded := postStatus(t, readHandler, "codex", accountRef, `{"status":"down"}`)
	if recorder.Code != http.StatusInternalServerError || decoded["error"] != "account_status_read_failed" {
		t.Fatalf("read failure status = %d, error = %v", recorder.Code, decoded["error"])
	}

	writeHandler := newHandler(t, failingAccounts{account: account, setErr: errors.New("boom")})
	recorder, decoded = postStatus(t, writeHandler, "codex", accountRef, `{"status":"down"}`)
	if recorder.Code != http.StatusBadGateway || decoded["error"] != "go_account_status_update_failed" {
		t.Fatalf("write failure status = %d, error = %v", recorder.Code, decoded["error"])
	}
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v", err)
	}
}
