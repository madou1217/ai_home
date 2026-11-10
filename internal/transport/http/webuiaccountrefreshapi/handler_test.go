package webuiaccountrefreshapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	testProvider = "codex"
	testRefText  = "acct_0123456789abcdef0123"
)

var testTime = time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)

type testAuthorizer bool

func (authorizer testAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type stubDirectory struct {
	account accountcore.Account
	err     error
}

func (directory stubDirectory) GetByRef(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountcore.Account, error) {
	if directory.err != nil {
		return accountcore.Account{}, directory.err
	}
	return directory.account, nil
}

type stubStatusRefresher struct {
	run func(ctx context.Context) error
}

func (stub stubStatusRefresher) RefreshAccountStatus(
	ctx context.Context,
	_ accountcore.AccountRef,
) error {
	return stub.run(ctx)
}

type stubModelRefresher struct {
	run func(ctx context.Context) error
}

func (stub stubModelRefresher) RefreshAccountModels(
	ctx context.Context,
	_ accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	if stub.run == nil {
		return nil, nil
	}
	return nil, stub.run(ctx)
}

type stubQuotaRefresher struct {
	run func(ctx context.Context) error
}

func (stub stubQuotaRefresher) RefreshUsage(
	ctx context.Context,
	_ accountcore.AccountRef,
) (accountusage.ReadResult, error) {
	if stub.run == nil {
		return accountusage.ReadResult{}, nil
	}
	return accountusage.ReadResult{}, stub.run(ctx)
}

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(testRefText)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func testAccount(t *testing.T, provider string) accountcore.Account {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          testAccountRef(t),
		ProviderID:   provider,
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    testTime,
		UpdatedAt:    testTime,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}

func newRefreshHandler(t *testing.T, dependencies Dependencies) *Handler {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func newRefreshRequest(provider string, accountRef string) *http.Request {
	request := httptest.NewRequest(
		http.MethodPost,
		Path+"/"+provider+"/"+accountRef+"/refresh",
		nil,
	)
	request.SetPathValue("provider", provider)
	request.SetPathValue("accountRef", accountRef)
	return request
}

func postRefresh(
	t *testing.T,
	handler *Handler,
	provider string,
	accountRef string,
) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, newRefreshRequest(provider, accountRef))
	return recorder
}

func decodeRefreshResponse(t *testing.T, recorder *httptest.ResponseRecorder) Response {
	t.Helper()
	var payload Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode refresh body %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func decodeRefreshError(t *testing.T, recorder *httptest.ResponseRecorder) errorResponse {
	t.Helper()
	var payload errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error body %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func TestNewHandlerValidatesDependencies(t *testing.T) {
	validAuthorizer := testAuthorizer(true)
	validDirectory := stubDirectory{account: testAccount(t, testProvider)}
	cases := []struct {
		name         string
		dependencies Dependencies
	}{
		{name: "missing authorizer", dependencies: Dependencies{Accounts: validDirectory}},
		{name: "missing accounts", dependencies: Dependencies{Authorizer: validAuthorizer}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := NewHandler(testCase.dependencies); !errors.Is(err, ErrInvalidDependencies) {
				t.Fatalf("NewHandler() error = %v, want %v", err, ErrInvalidDependencies)
			}
		})
	}
}

func TestRefreshRejectsUnauthorized(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(false),
		Accounts:   stubDirectory{account: testAccount(t, testProvider)},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if challenge := recorder.Header().Get("WWW-Authenticate"); challenge != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q, want Bearer", challenge)
	}
	if payload := decodeRefreshError(t, recorder); payload.Error != "unauthorized" {
		t.Fatalf("error = %q, want unauthorized", payload.Error)
	}
}

func TestRefreshRejectsMethod(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(true),
		Accounts:   stubDirectory{account: testAccount(t, testProvider)},
	})
	request := newRefreshRequest(testProvider, testRefText)
	request.Method = http.MethodGet
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q, want %q", allow, http.MethodPost)
	}
}

func TestRefreshRejectsInvalidPath(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		ref      string
	}{
		{name: "invalid provider", provider: "Codex!", ref: testRefText},
		{name: "invalid account ref", provider: testProvider, ref: "acct_short"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := newRefreshHandler(t, Dependencies{
				Authorizer: testAuthorizer(true),
				Accounts:   stubDirectory{account: testAccount(t, testProvider)},
			})

			recorder := postRefresh(t, handler, testCase.provider, testCase.ref)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if payload := decodeRefreshError(t, recorder); payload.Error != "invalid_account_path" {
				t.Fatalf("error = %q, want invalid_account_path", payload.Error)
			}
		})
	}
}

func TestRefreshRejectsUnknownAccount(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(true),
		Accounts:   stubDirectory{err: accountapp.ErrAccountNotFound},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeRefreshError(t, recorder); payload.Error != "account_not_found" {
		t.Fatalf("error = %q, want account_not_found", payload.Error)
	}
}

func TestRefreshRejectsProviderMismatch(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(true),
		Accounts:   stubDirectory{account: testAccount(t, "claude")},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeRefreshError(t, recorder); payload.Error != "account_not_found" {
		t.Fatalf("error = %q, want account_not_found", payload.Error)
	}
}

func TestRefreshReportsUnavailableBranches(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(true),
		Accounts:   stubDirectory{account: testAccount(t, testProvider)},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeRefreshResponse(t, recorder)
	if payload.OK {
		t.Fatalf("OK = true, want false when every refresher is missing")
	}
	if payload.TimedOut {
		t.Fatalf("TimedOut = true, want false")
	}
	if payload.Provider != testProvider || payload.AccountRef != testRefText {
		t.Fatalf("payload = %+v", payload)
	}
	for _, name := range []string{BranchStatus, BranchModels, BranchUsage} {
		branch, ok := payload.Branches[name]
		if !ok {
			t.Fatalf("branch %q missing from %+v", name, payload.Branches)
		}
		if branch.OK || branch.Code != codeRefreshUnavailable {
			t.Fatalf("branch %q = %+v, want refresh_unavailable", name, branch)
		}
	}
	wantFailed := []string{BranchStatus, BranchModels, BranchUsage}
	if !reflect.DeepEqual(payload.FailedBranches, wantFailed) {
		t.Fatalf("failedBranches = %v, want %v", payload.FailedBranches, wantFailed)
	}
}

func TestRefreshRunsBranchesConcurrently(t *testing.T) {
	started := make(chan struct{}, 3)
	release := make(chan struct{})
	waitForPeers := func(ctx context.Context) error {
		started <- struct{}{}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	handler := newRefreshHandler(t, Dependencies{
		Authorizer:      testAuthorizer(true),
		Accounts:        stubDirectory{account: testAccount(t, testProvider)},
		StatusRefresher: stubStatusRefresher{run: waitForPeers},
		ModelRefresher:  stubModelRefresher{run: waitForPeers},
		QuotaRefresher:  stubQuotaRefresher{run: waitForPeers},
		Timeout:         2 * time.Second,
	})
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, newRefreshRequest(testProvider, testRefText))
		close(done)
	}()

	// 三段都进入刷新体之后才放行：串行实现会卡在第二段，这里会超时失败。
	for index := 0; index < 3; index++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("三段刷新没有并发启动")
		}
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("刷新未在预期时间内完成")
	}

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeRefreshResponse(t, recorder)
	if !payload.OK || len(payload.FailedBranches) != 0 {
		t.Fatalf("payload = %+v, want all branches succeeded", payload)
	}
}

func TestRefreshKeepsSuccessfulBranchesWhenOneFails(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer:      testAuthorizer(true),
		Accounts:        stubDirectory{account: testAccount(t, testProvider)},
		StatusRefresher: stubStatusRefresher{run: func(context.Context) error { return nil }},
		ModelRefresher: stubModelRefresher{run: func(context.Context) error {
			return errors.New("上游 500")
		}},
		QuotaRefresher: stubQuotaRefresher{run: func(context.Context) error { return nil }},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeRefreshResponse(t, recorder)
	if !payload.OK {
		t.Fatalf("OK = false, want true when two branches succeeded")
	}
	if !reflect.DeepEqual(payload.FailedBranches, []string{BranchModels}) {
		t.Fatalf("failedBranches = %v, want [models]", payload.FailedBranches)
	}
	if !payload.Branches[BranchStatus].OK || !payload.Branches[BranchUsage].OK {
		t.Fatalf("branches = %+v, want status/usage succeeded", payload.Branches)
	}
	models := payload.Branches[BranchModels]
	if models.OK || models.Code != codeRefreshFailed || models.Error != "上游 500" {
		t.Fatalf("models = %+v, want refresh_failed 上游 500", models)
	}
}

func TestRefreshReportsAllFailedAsNotOK(t *testing.T) {
	fail := func(context.Context) error { return errors.New("boom") }
	handler := newRefreshHandler(t, Dependencies{
		Authorizer:      testAuthorizer(true),
		Accounts:        stubDirectory{account: testAccount(t, testProvider)},
		StatusRefresher: stubStatusRefresher{run: fail},
		ModelRefresher:  stubModelRefresher{run: fail},
		QuotaRefresher:  stubQuotaRefresher{run: fail},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeRefreshResponse(t, recorder)
	if payload.OK {
		t.Fatalf("OK = true, want false when every branch failed")
	}
	if !reflect.DeepEqual(payload.FailedBranches,
		[]string{BranchStatus, BranchModels, BranchUsage}) {
		t.Fatalf("failedBranches = %v", payload.FailedBranches)
	}
}

func TestRefreshMarksUnfinishedBranchesAsTimeout(t *testing.T) {
	blockUntilDone := func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}
	handler := newRefreshHandler(t, Dependencies{
		Authorizer:      testAuthorizer(true),
		Accounts:        stubDirectory{account: testAccount(t, testProvider)},
		StatusRefresher: stubStatusRefresher{run: func(context.Context) error { return nil }},
		ModelRefresher:  stubModelRefresher{run: blockUntilDone},
		QuotaRefresher:  stubQuotaRefresher{run: blockUntilDone},
		Timeout:         50 * time.Millisecond,
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeRefreshResponse(t, recorder)
	if !payload.TimedOut {
		t.Fatalf("TimedOut = false, want true")
	}
	if !payload.Branches[BranchStatus].OK {
		t.Fatalf("status branch = %+v, want succeeded", payload.Branches[BranchStatus])
	}
	for _, name := range []string{BranchModels, BranchUsage} {
		branch := payload.Branches[name]
		if branch.OK || branch.Code != codeTimeout {
			t.Fatalf("branch %q = %+v, want timeout", name, branch)
		}
	}
	if !payload.OK {
		t.Fatalf("OK = false, want true when status branch succeeded")
	}
	if !reflect.DeepEqual(payload.FailedBranches, []string{BranchModels, BranchUsage}) {
		t.Fatalf("failedBranches = %v, want [models usage]", payload.FailedBranches)
	}
}

func TestRefreshTruncatesLongError(t *testing.T) {
	longError := errors.New(strings.Repeat("错", maxErrorRunes+20))
	handler := newRefreshHandler(t, Dependencies{
		Authorizer:      testAuthorizer(true),
		Accounts:        stubDirectory{account: testAccount(t, testProvider)},
		StatusRefresher: stubStatusRefresher{run: func(context.Context) error { return longError }},
		ModelRefresher:  stubModelRefresher{run: func(context.Context) error { return nil }},
		QuotaRefresher:  stubQuotaRefresher{run: func(context.Context) error { return nil }},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	payload := decodeRefreshResponse(t, recorder)
	status := payload.Branches[BranchStatus]
	if !utf8.ValidString(status.Error) {
		t.Fatalf("error is not valid UTF-8: %q", status.Error)
	}
	if runes := []rune(status.Error); len(runes) != maxErrorRunes+1 {
		t.Fatalf("error runes = %d, want %d", len(runes), maxErrorRunes+1)
	}
	if !strings.HasSuffix(status.Error, "…") {
		t.Fatalf("error = %q, want ellipsis suffix", status.Error)
	}
}
