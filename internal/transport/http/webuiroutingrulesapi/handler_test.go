package webuiroutingrulesapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

const (
	testRef  = "acct_0123456789abcdef0123"
	testProv = "codex"
)

type fakeAuthorizer bool

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return bool(fake) }

// fakeAccounts 同时实现 AccountResolver / AccountIdentityResolver / GoRulesSyncer。
type fakeAccounts struct {
	provider string
	goRef    string
	nodeRef  string
	exists   bool
	resolve  error

	syncChanged bool
	syncErr     error

	providerCalls int
	syncCalls     int
	lastGoRef     string
	lastRules     []rulescore.Rule
	lastGroups    []string
}

func (fake *fakeAccounts) ProviderOf(context.Context, string) (string, bool, error) {
	fake.providerCalls++
	return fake.provider, fake.exists, fake.resolve
}

func (fake *fakeAccounts) ResolveAccountIdentity(context.Context, string) (string, string, string, bool, error) {
	if fake.resolve != nil {
		return "", "", "", false, fake.resolve
	}
	goRef := fake.goRef
	if goRef == "" {
		goRef = testRef
	}
	nodeRef := fake.nodeRef
	if nodeRef == "" {
		nodeRef = testRef
	}
	return fake.provider, goRef, nodeRef, fake.exists, nil
}

func (fake *fakeAccounts) SyncAccountRules(_ context.Context, goRef string, rules []rulescore.Rule, groupIDs []string) (bool, error) {
	fake.syncCalls++
	fake.lastGoRef = goRef
	fake.lastRules = rules
	fake.lastGroups = groupIDs
	if fake.syncErr != nil {
		return false, fake.syncErr
	}
	return fake.syncChanged, nil
}

// providerOnlyResolver 只实现 AccountResolver + GoRulesSyncer，用于验证没有身份端口时的回退。
type providerOnlyResolver struct {
	provider      string
	exists        bool
	providerCalls int
	syncCalls     int
}

func (fake *providerOnlyResolver) ProviderOf(context.Context, string) (string, bool, error) {
	fake.providerCalls++
	return fake.provider, fake.exists, nil
}

func (fake *providerOnlyResolver) SyncAccountRules(context.Context, string, []rulescore.Rule, []string) (bool, error) {
	fake.syncCalls++
	return true, nil
}

type fakeRuntime struct {
	evidence accountcore.StatusEventKind
	err      error
	calls    int
}

func (fake *fakeRuntime) ClearManualAdminBlocks(context.Context, accountcore.AccountRef) (accountcore.StatusEventKind, error) {
	fake.calls++
	if fake.err != nil {
		return "", fake.err
	}
	return fake.evidence, nil
}

func testCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func newHandler(t *testing.T, accounts AccountResolver, runtime RuntimeBlockClearer) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer(true),
		Accounts:   accounts,
		Catalog:    testCatalog(t),
		Runtime:    runtime,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path, handler)
	return mux
}

func post(t *testing.T, handler http.Handler, provider, ref, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	url := "/v1/management/webui/accounts/" + provider + "/" + ref + "/routing-rules"
	request := httptest.NewRequest(http.MethodPost, url, strings.NewReader(body))
	handler.ServeHTTP(recorder, request)
	decoded := map[string]any{}
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, decoded
}

const validRule = `{"name":"rate","kind":"rate_limited","enabled":true,"statuses":[429],"matchers":[{"field":"message","pattern":"rate limit"}]}`

func validBody(extra string) string {
	return `{"upstreamErrorRules":[` + validRule + `],"upstreamErrorGroupIds":["grp-demo"]` + extra + `}`
}

func TestRoutingRulesAuthMethodAndAvailability(t *testing.T) {
	accounts := &fakeAccounts{provider: testProv, exists: true}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer(false),
		Accounts:   accounts,
		Catalog:    testCatalog(t),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path, handler)
	recorder, decoded := post(t, mux, testProv, testRef, validBody(""))
	if recorder.Code != http.StatusUnauthorized || decoded["error"] != "unauthorized" {
		t.Fatalf("unauthorized: status=%d body=%v", recorder.Code, decoded)
	}

	raw, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer(true),
		Accounts:   accounts,
		Catalog:    testCatalog(t),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/irrelevant", nil)
	request.SetPathValue("provider", testProv)
	request.SetPathValue("accountRef", testRef)
	methodRecorder := httptest.NewRecorder()
	raw.ServeHTTP(methodRecorder, request)
	if methodRecorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method: status=%d", methodRecorder.Code)
	}

	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v", err)
	}
	var zero Handler
	zeroRecorder := httptest.NewRecorder()
	zero.ServeHTTP(zeroRecorder, httptest.NewRequest(http.MethodPost, "/", nil))
	if zeroRecorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("zero handler: status=%d", zeroRecorder.Code)
	}
}

func TestRoutingRulesRejectsPathAndProvider(t *testing.T) {
	accounts := &fakeAccounts{provider: testProv, exists: true}
	handler := newHandler(t, accounts, nil)

	raw, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer(true),
		Accounts:   accounts,
		Catalog:    testCatalog(t),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	emptyPathRequest := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(validBody("")))
	emptyPathRequest.SetPathValue("accountRef", testRef)
	emptyPathRecorder := httptest.NewRecorder()
	raw.ServeHTTP(emptyPathRecorder, emptyPathRequest)
	if emptyPathRecorder.Code != http.StatusBadRequest {
		t.Fatalf("empty provider: status=%d", emptyPathRecorder.Code)
	}
	var emptyPathBody map[string]any
	_ = json.Unmarshal(emptyPathRecorder.Body.Bytes(), &emptyPathBody)
	if emptyPathBody["error"] != "invalid_account_path" {
		t.Fatalf("empty provider body=%v", emptyPathBody)
	}
	recorder, decoded := post(t, handler, testProv, testRef, validBody(""))
	recorder, decoded = post(t, handler, "nope", testRef, validBody(""))
	if recorder.Code != http.StatusBadRequest || decoded["error"] != "unsupported_provider" {
		t.Fatalf("unsupported provider: status=%d body=%v", recorder.Code, decoded)
	}
}

func TestRoutingRulesRejectsMalformedBody(t *testing.T) {
	accounts := &fakeAccounts{provider: testProv, exists: true}
	handler := newHandler(t, accounts, nil)
	for _, body := range []string{
		"",
		"[]",
		`{"unknown":true}`,
		`{"upstreamErrorRules":[]} {}`,
	} {
		recorder, decoded := post(t, handler, testProv, testRef, body)
		if recorder.Code != http.StatusBadRequest || decoded["error"] != "invalid_routing_rules" {
			t.Fatalf("body %q: status=%d body=%v", body, recorder.Code, decoded)
		}
	}
	if accounts.syncCalls != 0 {
		t.Fatalf("非法请求不得写库: %d", accounts.syncCalls)
	}
}

func TestRoutingRulesRejectsUnknownAccountAndMismatch(t *testing.T) {
	missing := &fakeAccounts{provider: testProv, exists: false}
	recorder, decoded := post(t, newHandler(t, missing, nil), testProv, testRef, validBody(""))
	if recorder.Code != http.StatusNotFound || decoded["error"] != "account_not_found" {
		t.Fatalf("missing: status=%d body=%v", recorder.Code, decoded)
	}

	mismatch := &fakeAccounts{provider: "claude", exists: true}
	recorder, decoded = post(t, newHandler(t, mismatch, nil), testProv, testRef, validBody(""))
	if recorder.Code != http.StatusNotFound || decoded["error"] != "account_not_found" {
		t.Fatalf("mismatch: status=%d body=%v", recorder.Code, decoded)
	}
}

func TestRoutingRulesValidatesRulesAndGroups(t *testing.T) {
	accounts := &fakeAccounts{provider: testProv, exists: true}
	handler := newHandler(t, accounts, nil)
	recorder, decoded := post(t, handler, testProv, testRef, `{"upstreamErrorRules":[{"name":"bad","kind":"rate_limited"}]}`)
	if recorder.Code != http.StatusBadRequest || decoded["error"] != "invalid_upstream_error_rules" {
		t.Fatalf("invalid rule: status=%d body=%v", recorder.Code, decoded)
	}
	recorder, decoded = post(t, handler, testProv, testRef, validBody(`, "upstreamErrorGroupIds":["bad id!"]`))
	if recorder.Code != http.StatusBadRequest || decoded["error"] != "invalid_upstream_error_group" {
		t.Fatalf("invalid group: status=%d body=%v", recorder.Code, decoded)
	}
	if accounts.syncCalls != 0 {
		t.Fatalf("校验失败不得写库: %d", accounts.syncCalls)
	}
}

func TestRoutingRulesSyncsValidatedPayload(t *testing.T) {
	accounts := &fakeAccounts{provider: testProv, exists: true, syncChanged: true, nodeRef: "acct_ffffffffffffffffffff"}
	recorder, decoded := post(t, newHandler(t, accounts, nil), testProv, testRef, validBody(""))
	if recorder.Code != http.StatusOK || decoded["ok"] != true {
		t.Fatalf("status=%d body=%v", recorder.Code, decoded)
	}
	if decoded["provider"] != testProv || decoded["accountRef"] != testRef || decoded["changed"] != true {
		t.Fatalf("body=%v", decoded)
	}
	if accounts.syncCalls != 1 || accounts.lastGoRef != testRef {
		t.Fatalf("sync 调用=%d ref=%q", accounts.syncCalls, accounts.lastGoRef)
	}
	if len(accounts.lastRules) != 1 || !accounts.lastRules[0].Enabled() {
		t.Fatalf("规则未通过领域校验：%+v", accounts.lastRules)
	}
	if len(accounts.lastGroups) != 1 || accounts.lastGroups[0] != "grp-demo" {
		t.Fatalf("groupIDs=%v", accounts.lastGroups)
	}
	rules, ok := decoded["upstreamErrorRules"].([]any)
	if !ok || len(rules) != 1 {
		t.Fatalf("upstreamErrorRules=%v", decoded["upstreamErrorRules"])
	}
}

func TestRoutingRulesMapsSyncFailures(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{rulesapp.ErrAccountNotFound, http.StatusNotFound, "account_not_found"},
		{rulesapp.ErrInvalidAccountRef, http.StatusBadRequest, "invalid_account_path"},
		{rulescore.ErrInvalidRules, http.StatusBadRequest, "invalid_upstream_error_rules"},
		{rulesapp.ErrInvalidGroupIDs, http.StatusBadRequest, "invalid_upstream_error_group"},
		{errors.New("boom"), http.StatusInternalServerError, "routing_rules_failed"},
	}
	for _, testCase := range cases {
		accounts := &fakeAccounts{provider: testProv, exists: true, syncErr: testCase.err}
		recorder, decoded := post(t, newHandler(t, accounts, nil), testProv, testRef, validBody(""))
		if recorder.Code != testCase.status || decoded["error"] != testCase.code {
			t.Fatalf("%v: status=%d body=%v", testCase.err, recorder.Code, decoded)
		}
	}
}

func TestRoutingRulesClearsRuntimeBlocks(t *testing.T) {
	accounts := &fakeAccounts{provider: testProv, exists: true}
	runtime := &fakeRuntime{evidence: accountcore.StatusEventManualAdminClear}
	recorder, decoded := post(t, newHandler(t, accounts, runtime), testProv, testRef, validBody(`,"clearErrorBlock":true`))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%v", recorder.Code, decoded)
	}
	if runtime.calls != 1 {
		t.Fatalf("runtime calls=%d", runtime.calls)
	}
	if decoded["clearEvidence"] != string(accountcore.StatusEventManualAdminClear) {
		t.Fatalf("clearEvidence=%v", decoded["clearEvidence"])
	}

	recorder, decoded = post(t, newHandler(t, accounts, nil), testProv, testRef, validBody(`,"clearErrorBlock":true`))
	if recorder.Code != http.StatusNotImplemented || decoded["error"] != "runtime_block_clear_unavailable" {
		t.Fatalf("no runtime: status=%d body=%v", recorder.Code, decoded)
	}

	recorder, decoded = post(t, newHandler(t, accounts, &fakeRuntime{err: errors.New("boom")}), testProv, testRef, validBody(`,"clearErrorBlock":true`))
	if recorder.Code != http.StatusInternalServerError || decoded["error"] != "runtime_block_clear_failed" {
		t.Fatalf("runtime error: status=%d body=%v", recorder.Code, decoded)
	}
}

func TestRoutingRulesFallsBackWithoutIdentityResolver(t *testing.T) {
	accounts := &providerOnlyResolver{provider: testProv, exists: true}
	recorder, decoded := post(t, newHandler(t, accounts, nil), testProv, testRef, validBody(""))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%v", recorder.Code, decoded)
	}
	if accounts.providerCalls != 1 || accounts.syncCalls != 1 {
		t.Fatalf("应走 ProviderOf 回退并同步：provider=%d sync=%d", accounts.providerCalls, accounts.syncCalls)
	}
}
