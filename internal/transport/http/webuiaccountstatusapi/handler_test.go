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

// fakeHostGrant 记录宿主授权回收调用。
type fakeHostGrant struct {
	supported  bool
	calls      int
	revocation accountapp.GrantRevocation
	err        error
}

func (fake *fakeHostGrant) SupportsHostGrant(string) bool { return fake.supported }

func (fake *fakeHostGrant) RevokeHostGrant(
	context.Context,
	accountcore.Account,
) (accountapp.GrantRevocation, error) {
	fake.calls++
	if fake.err != nil {
		return accountapp.GrantRevocation{}, fake.err
	}
	return fake.revocation, nil
}

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
	return newHandlerWith(t, accounts, &fakeHostGrant{})
}

func newHandlerWith(
	t *testing.T,
	accounts accountapp.AccountLifecycleStore,
	hostGrant HostGrantRevoker,
) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Accounts:   accounts,
		HostGrant:  hostGrant,
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
	hostGrant := &fakeHostGrant{
		supported:  true,
		revocation: accountapp.GrantRevocation{OK: true, Revoked: true},
	}
	handler := newHandlerWith(t, store, hostGrant)

	recorder, decoded := postStatus(t, handler, "codex", ref.String(), `{"status":"down"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["ok"] != true || decoded["status"] != "down" || decoded["enabled"] != false {
		t.Fatalf("body = %v", decoded)
	}
	if _, found := decoded["partial"]; found {
		t.Fatal("Go 已成为唯一权威，响应不应再有 partial 标记")
	}
	if _, found := decoded["unfilledFields"]; found {
		t.Fatal("Go 已成为唯一权威，响应不应再有 unfilledFields")
	}
	accountPayload, ok := decoded["account"].(map[string]any)
	if !ok {
		t.Fatalf("account = %v", decoded["account"])
	}
	if accountPayload["accountRef"] != ref.String() ||
		accountPayload["provider"] != "codex" ||
		accountPayload["status"] != "down" ||
		accountPayload["configured"] != true {
		t.Fatalf("account = %v", accountPayload)
	}
	if hostGrant.calls != 1 {
		t.Fatalf("宿主授权回收调用 = %d", hostGrant.calls)
	}
	revoke, ok := decoded["hostGrantRevoke"].(map[string]any)
	if !ok || revoke["revoked"] != true {
		t.Fatalf("hostGrantRevoke = %v", decoded["hostGrantRevoke"])
	}
	if updatedAt, _ := decoded["updatedAt"].(float64); int64(updatedAt) != fixedClock().UnixMilli() {
		t.Fatalf("updatedAt = %v, want %d", decoded["updatedAt"], fixedClock().UnixMilli())
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
	hostGrant := &fakeHostGrant{supported: true}
	handler := newHandlerWith(t, store, hostGrant)

	if recorder, _ := postStatus(t, handler, "codex", ref.String(), `{"status":"down"}`); recorder.Code != http.StatusOK {
		t.Fatalf("disable status = %d", recorder.Code)
	}
	hostGrant.calls = 0
	recorder, decoded := postStatus(t, handler, "CODEX", ref.String(), `{"status":"UP"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["status"] != "up" || decoded["enabled"] != true || decoded["provider"] != "codex" {
		t.Fatalf("body = %v", decoded)
	}
	if _, found := decoded["hostGrantRevoke"]; found {
		t.Fatalf("启用不应回收宿主授权: %v", decoded["hostGrantRevoke"])
	}
	if hostGrant.calls != 0 {
		t.Fatalf("启用时宿主授权回收被调用 %d 次", hostGrant.calls)
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
	hostGrant := &fakeHostGrant{supported: true}
	handler := newHandlerWith(t, store, hostGrant)

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
	if hostGrant.calls != 0 {
		t.Fatalf("非法请求不得回收授权: host=%d", hostGrant.calls)
	}
}

func TestStatusRejectsUnknownAccount(t *testing.T) {
	store, _ := newStore(t)
	handler := newHandlerWith(t, store, &fakeHostGrant{supported: true})

	recorder, decoded := postStatus(t, handler, "codex", otherRef, `{"status":"down"}`)
	if recorder.Code != http.StatusNotFound || decoded["error"] != "account_not_found" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
}

func TestStatusRejectsProviderMismatch(t *testing.T) {
	store, ref := newStore(t)
	hostGrant := &fakeHostGrant{supported: true}
	handler := newHandlerWith(t, store, hostGrant)

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
	if hostGrant.calls != 0 {
		t.Fatalf("Provider 不匹配不得回收授权: host=%d", hostGrant.calls)
	}
}

func TestStatusRequiresAuthorizationAndPost(t *testing.T) {
	store, ref := newStore(t)
	hostGrant := &fakeHostGrant{supported: true}

	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Accounts:   store,
		HostGrant:  hostGrant,
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
		HostGrant:  hostGrant,
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
	if hostGrant.calls != 0 {
		t.Fatalf("未授权/错误方法不得回收授权: host=%d", hostGrant.calls)
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

	writeHandler := newHandlerWith(t, failingAccounts{account: account, setErr: errors.New("boom")},
		&fakeHostGrant{supported: true})
	recorder, decoded = postStatus(t, writeHandler, "codex", accountRef, `{"status":"down"}`)
	if recorder.Code != http.StatusBadGateway || decoded["error"] != "go_account_status_update_failed" {
		t.Fatalf("write failure status = %d, error = %v", recorder.Code, decoded["error"])
	}
}

func TestStatusReportsHostGrantFailureWithoutFailingStatus(t *testing.T) {
	store, ref := newStore(t)
	handler := newHandlerWith(t, store, &fakeHostGrant{
		supported: true,
		err:       errors.New("host sync unavailable"),
	})

	recorder, decoded := postStatus(t, handler, "codex", ref.String(), `{"status":"down"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	revoke, ok := decoded["hostGrantRevoke"].(map[string]any)
	if !ok || revoke["ok"] != false || revoke["reason"] != "host_grant_revoke_failed" {
		t.Fatalf("hostGrantRevoke = %v", decoded["hostGrantRevoke"])
	}
	account, err := store.GetByRef(context.Background(), ref)
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	if account.Enabled() {
		t.Fatal("宿主回收失败不应回滚已提交的启停")
	}
}

func TestStatusSkipsHostGrantForUnsupportedProvider(t *testing.T) {
	store, ref := newStore(t)
	hostGrant := &fakeHostGrant{supported: false}
	handler := newHandlerWith(t, store, hostGrant)

	recorder, decoded := postStatus(t, handler, "codex", ref.String(), `{"status":"down"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if _, found := decoded["hostGrantRevoke"]; found {
		t.Fatalf("没有回收钩子的 Provider 不应返回 hostGrantRevoke: %v", decoded["hostGrantRevoke"])
	}
	if hostGrant.calls != 0 {
		t.Fatalf("没有回收钩子的 Provider 被调用 %d 次", hostGrant.calls)
	}
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v", err)
	}
}
