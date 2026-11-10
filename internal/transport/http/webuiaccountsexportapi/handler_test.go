package webuiaccountsexportapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

type denyAll struct{}

func (denyAll) Authorized(*http.Request) bool { return false }

// fakeOverviews 按稳定游标切片，模拟真实 store 的 afterRef + limit 语义。
type fakeOverviews struct {
	overviews []accountapp.AccountOverview
	err       error
}

func (source *fakeOverviews) ListAccountOverviews(
	_ context.Context,
	query accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
	if source.err != nil {
		return nil, source.err
	}
	start := 0
	if after := query.AfterRef(); after != "" {
		for index, overview := range source.overviews {
			if overview.Account().Ref() == after {
				start = index + 1
				break
			}
		}
	}
	end := start + query.Limit()
	if end > len(source.overviews) {
		end = len(source.overviews)
	}
	if start > len(source.overviews) {
		return nil, nil
	}
	return source.overviews[start:end], nil
}

// fakeCredentials 按账号返回凭据快照，missing 中的账号模拟凭据不可读。
type fakeCredentials struct {
	credentials map[accountcore.AccountRef]accountapp.CredentialSnapshot
	missing     map[accountcore.AccountRef]struct{}
}

func (source *fakeCredentials) GetCredentialSnapshot(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	if _, ok := source.missing[accountRef]; ok {
		return accountapp.CredentialSnapshot{}, errors.New("凭据不可读")
	}
	snapshot, ok := source.credentials[accountRef]
	if !ok {
		return accountapp.CredentialSnapshot{}, errors.New("凭据不存在")
	}
	return snapshot, nil
}

func mustCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

// mustCodexAccount 造一个可导出的 codex 静态凭据账号。
func mustCodexAccount(
	t *testing.T,
	catalog *providers.Catalog,
	apiKey string,
	cliAccountID int64,
) (accountcore.Account, accountapp.Credential) {
	t.Helper()
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  apiKey,
		BaseURL: "https://export.example/v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: accountcore.CLIAccountID(cliAccountID),
		CreatedAt:    time.UnixMilli(1000).UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return account, credential
}

func mustOverview(t *testing.T, account accountcore.Account) accountapp.AccountOverview {
	t.Helper()
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       account,
		HasCredential: true,
		AuthKind:      "api_key",
	})
	if err != nil {
		t.Fatal(err)
	}
	return overview
}

func mustSnapshot(
	t *testing.T,
	account accountcore.Account,
	credential accountapp.Credential,
) accountapp.CredentialSnapshot {
	t.Helper()
	snapshot, err := accountapp.NewCredentialSnapshot(
		account.Ref(),
		account.ProviderID(),
		credential,
		time.UnixMilli(2000).UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

type fixture struct {
	overviews   *fakeOverviews
	credentials *fakeCredentials
	accounts    []accountcore.Account
}

func newFixture(t *testing.T, count int) fixture {
	t.Helper()
	catalog := mustCatalog(t)
	result := fixture{
		overviews:   &fakeOverviews{},
		credentials: &fakeCredentials{credentials: map[accountcore.AccountRef]accountapp.CredentialSnapshot{}},
	}
	for index := 0; index < count; index++ {
		account, credential := mustCodexAccount(
			t,
			catalog,
			"sk-export-"+strconv.Itoa(index),
			int64(index+1),
		)
		result.accounts = append(result.accounts, account)
		result.overviews.overviews = append(result.overviews.overviews, mustOverview(t, account))
		result.credentials.credentials[account.Ref()] = mustSnapshot(t, account, credential)
	}
	return result
}

func newTestHandler(t *testing.T, fixture fixture) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer:  allowAll{},
		Overviews:   fixture.overviews,
		Credentials: fixture.credentials,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func exportedDocument(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("响应不是 JSON: %v\n%s", err, body)
	}
	return document
}

func TestExportWritesAttachmentForEveryAccount(t *testing.T) {
	fixture := newFixture(t, 3)
	recorder := httptest.NewRecorder()
	newTestHandler(t, fixture).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path, nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if disposition := recorder.Header().Get("Content-Disposition"); disposition != `attachment; filename="`+FileName+`"` {
		t.Fatalf("Content-Disposition = %q", disposition)
	}
	if exported := recorder.Header().Get("X-AIH-Exported-Accounts"); exported != "3" {
		t.Fatalf("X-AIH-Exported-Accounts = %q", exported)
	}
	document := exportedDocument(t, recorder.Body.Bytes())
	if document["kind"] != "aih-accounts" || document["version"] != float64(1) {
		t.Fatalf("document = %#v", document)
	}
	accounts, ok := document["accounts"].([]any)
	if !ok || len(accounts) != 3 {
		t.Fatalf("accounts = %#v", document["accounts"])
	}
}

func TestExportFiltersByProviderAndAccountRef(t *testing.T) {
	fixture := newFixture(t, 3)
	handler := newTestHandler(t, fixture)
	target := fixture.accounts[1].Ref().String()

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(
			http.MethodGet,
			Path+"?provider=codex&accountRef="+target,
			nil,
		),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	document := exportedDocument(t, recorder.Body.Bytes())
	accounts := document["accounts"].([]any)
	if len(accounts) != 1 {
		t.Fatalf("accounts = %#v", accounts)
	}
	entry := accounts[0].(map[string]any)
	if entry["accountRef"] != target || entry["provider"] != "codex" {
		t.Fatalf("entry = %#v", entry)
	}
	if entry["env"].(map[string]any)["OPENAI_API_KEY"] == nil {
		t.Fatalf("env = %#v", entry["env"])
	}

	// 不存在的 provider 过滤后为空集合，但仍是成功导出。
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path+"?provider=claude", nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if accounts := exportedDocument(t, recorder.Body.Bytes())["accounts"]; len(accounts.([]any)) != 0 {
		t.Fatalf("accounts = %#v", accounts)
	}
}

func TestExportPaginatesBeyondOnePage(t *testing.T) {
	fixture := newFixture(t, 101)
	recorder := httptest.NewRecorder()
	newTestHandler(t, fixture).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path, nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if exported := recorder.Header().Get("X-AIH-Exported-Accounts"); exported != "101" {
		t.Fatalf("X-AIH-Exported-Accounts = %q", exported)
	}
}

func TestExportCountsUnreadableCredentialsAsSkipped(t *testing.T) {
	fixture := newFixture(t, 2)
	fixture.credentials.missing = map[accountcore.AccountRef]struct{}{
		fixture.accounts[0].Ref(): {},
	}
	recorder := httptest.NewRecorder()
	newTestHandler(t, fixture).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path, nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if exported := recorder.Header().Get("X-AIH-Exported-Accounts"); exported != "1" {
		t.Fatalf("X-AIH-Exported-Accounts = %q", exported)
	}
	if skipped := recorder.Header().Get("X-AIH-Skipped-Accounts"); skipped != "1" {
		t.Fatalf("X-AIH-Skipped-Accounts = %q", skipped)
	}
}

func TestExportRejectsUnknownQueryParameter(t *testing.T) {
	fixture := newFixture(t, 1)
	recorder := httptest.NewRecorder()
	newTestHandler(t, fixture).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path+"?ref="+fixture.accounts[0].Ref().String(), nil),
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.OK || body.Error.Code != "invalid_export_query" {
		t.Fatalf("body = %#v", body)
	}
}

func TestExportRequiresBearerAndGet(t *testing.T) {
	fixture := newFixture(t, 1)
	handler, err := NewHandler(Dependencies{
		Authorizer:  denyAll{},
		Overviews:   fixture.overviews,
		Credentials: fixture.credentials,
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	newTestHandler(t, fixture).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", recorder.Code)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodGet {
		t.Fatalf("Allow = %q", allow)
	}
}

func TestNewHandlerRequiresDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("err = %v", err)
	}
}
