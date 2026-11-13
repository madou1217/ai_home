package webuiaccountupdateapi

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
)

const (
	testProvider = "codex"
	testRefText  = "acct_0123456789abcdef0123"
)

var testTime = time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)

type testAuthorizer bool

func (authorizer testAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type editCall struct {
	accountRef accountcore.AccountRef
	edit       accountapp.StaticCredentialEdit
}

type stubEditor struct {
	calls   []editCall
	account accountcore.Account
	err     error
}

func (editor *stubEditor) Edit(
	_ context.Context,
	accountRef accountcore.AccountRef,
	edit accountapp.StaticCredentialEdit,
) (accountcore.Account, error) {
	editor.calls = append(editor.calls, editCall{accountRef: accountRef, edit: edit})
	if editor.err != nil {
		return accountcore.Account{}, editor.err
	}
	return editor.account, nil
}

type stubDirectory struct {
	overview accountapp.AccountOverview
	err      error
}

func (directory stubDirectory) GetAccountOverview(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountapp.AccountOverview, error) {
	if directory.err != nil {
		return accountapp.AccountOverview{}, directory.err
	}
	return directory.overview, nil
}

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(testRefText)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func testOverview(t *testing.T, provider string, accountRef accountcore.AccountRef) accountapp.AccountOverview {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          accountRef,
		ProviderID:   provider,
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    testTime,
		UpdatedAt:    testTime,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{Account: account})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	return overview
}

func newUpdateHandler(
	t *testing.T,
	authorizer Authorizer,
	directory AccountDirectory,
	editor CredentialEditor,
) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: authorizer,
		Accounts:   directory,
		Editor:     editor,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func postUpdate(
	t *testing.T,
	handler *Handler,
	provider string,
	accountRef string,
	body string,
) *httptest.ResponseRecorder {
	t.Helper()
	target := Path + "/" + provider + "/" + accountRef + "/update"
	request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	request.SetPathValue("provider", provider)
	request.SetPathValue("accountRef", accountRef)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) errorResponse {
	t.Helper()
	var payload errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error body %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func TestNewHandlerValidatesDependencies(t *testing.T) {
	validEditor := &stubEditor{}
	validDirectory := stubDirectory{}
	validAuthorizer := testAuthorizer(true)
	cases := []struct {
		name         string
		dependencies Dependencies
	}{
		{name: "missing authorizer", dependencies: Dependencies{Accounts: validDirectory, Editor: validEditor}},
		{name: "missing accounts", dependencies: Dependencies{Authorizer: validAuthorizer, Editor: validEditor}},
		{name: "missing editor", dependencies: Dependencies{Authorizer: validAuthorizer, Accounts: validDirectory}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := NewHandler(testCase.dependencies); !errors.Is(err, ErrInvalidDependencies) {
				t.Fatalf("NewHandler() error = %v, want %v", err, ErrInvalidDependencies)
			}
		})
	}
}

func TestUpdatePreservesUnspecifiedCredentialFields(t *testing.T) {
	accountRef := testAccountRef(t)
	cases := []struct {
		name string
		body string
		want accountapp.StaticCredentialEdit
	}{
		{
			name: "api key only keeps base url",
			body: `{"apiKey":"sk-new"}`,
			want: accountapp.StaticCredentialEdit{APIKey: "sk-new"},
		},
		{
			name: "base url only keeps api key",
			body: `{"baseUrl":"https://relay.example.com/v1"}`,
			want: accountapp.StaticCredentialEdit{
				BaseURL:        "https://relay.example.com/v1",
				IncludeBaseURL: true,
			},
		},
		{
			name: "empty object changes nothing",
			body: `{}`,
			want: accountapp.StaticCredentialEdit{},
		},
		{
			name: "explicit empty base url clears address",
			body: `{"baseUrl":""}`,
			want: accountapp.StaticCredentialEdit{IncludeBaseURL: true},
		},
		{
			name: "null base url clears address",
			body: `{"baseUrl":null}`,
			want: accountapp.StaticCredentialEdit{IncludeBaseURL: true},
		},
		{
			name: "unknown fields are ignored",
			body: `{"apiKey":"sk-new","baseUrl":"https://relay.example.com","upstreamErrorRules":[]}`,
			want: accountapp.StaticCredentialEdit{
				APIKey:         "sk-new",
				BaseURL:        "https://relay.example.com",
				IncludeBaseURL: true,
			},
		},
		{
			name: "empty body changes nothing",
			body: "",
			want: accountapp.StaticCredentialEdit{},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			editor := &stubEditor{}
			handler := newUpdateHandler(t, testAuthorizer(true), stubDirectory{
				overview: testOverview(t, testProvider, accountRef),
			}, editor)

			recorder := postUpdate(t, handler, testProvider, testRefText, testCase.body)

			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if len(editor.calls) != 1 {
				t.Fatalf("Edit() calls = %d, want 1", len(editor.calls))
			}
			if editor.calls[0].accountRef != accountRef {
				t.Fatalf("Edit() accountRef = %q, want %q", editor.calls[0].accountRef, accountRef)
			}
			if editor.calls[0].edit != testCase.want {
				t.Fatalf("Edit() edit = %+v, want %+v", editor.calls[0].edit, testCase.want)
			}

			var payload successResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode success body: %v", err)
			}
			if !payload.OK || payload.Provider != testProvider || payload.AccountRef != testRefText {
				t.Fatalf("success payload = %+v", payload)
			}
		})
	}
}

func TestUpdateRejectsMethodAndAuthorization(t *testing.T) {
	accountRef := testAccountRef(t)
	t.Run("method", func(t *testing.T) {
		editor := &stubEditor{}
		handler := newUpdateHandler(t, testAuthorizer(true), stubDirectory{
			overview: testOverview(t, testProvider, accountRef),
		}, editor)
		request := httptest.NewRequest(http.MethodGet,
			Path+"/"+testProvider+"/"+testRefText+"/update", nil)
		request.SetPathValue("provider", testProvider)
		request.SetPathValue("accountRef", testRefText)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
		}
		if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
			t.Fatalf("Allow = %q, want %q", allow, http.MethodPost)
		}
		if len(editor.calls) != 0 {
			t.Fatalf("Edit() calls = %d, want 0", len(editor.calls))
		}
	})

	t.Run("authorization", func(t *testing.T) {
		editor := &stubEditor{}
		handler := newUpdateHandler(t, testAuthorizer(false), stubDirectory{
			overview: testOverview(t, testProvider, accountRef),
		}, editor)
		recorder := postUpdate(t, handler, testProvider, testRefText, `{"apiKey":"sk-new"}`)

		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnauthorized)
		}
		if challenge := recorder.Header().Get("WWW-Authenticate"); challenge != "Bearer" {
			t.Fatalf("WWW-Authenticate = %q, want Bearer", challenge)
		}
		if len(editor.calls) != 0 {
			t.Fatalf("Edit() calls = %d, want 0", len(editor.calls))
		}
	})
}

func TestUpdateRejectsInvalidPath(t *testing.T) {
	accountRef := testAccountRef(t)
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
			editor := &stubEditor{}
			handler := newUpdateHandler(t, testAuthorizer(true), stubDirectory{
				overview: testOverview(t, testProvider, accountRef),
			}, editor)
			recorder := postUpdate(t, handler, testCase.provider, testCase.ref, `{}`)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if payload := decodeError(t, recorder); payload.Error != "invalid_account_path" {
				t.Fatalf("error = %q, want invalid_account_path", payload.Error)
			}
			if len(editor.calls) != 0 {
				t.Fatalf("Edit() calls = %d, want 0", len(editor.calls))
			}
		})
	}
}

func TestUpdateRejectsProviderMismatch(t *testing.T) {
	accountRef := testAccountRef(t)
	editor := &stubEditor{}
	handler := newUpdateHandler(t, testAuthorizer(true), stubDirectory{
		overview: testOverview(t, "claude", accountRef),
	}, editor)

	recorder := postUpdate(t, handler, testProvider, testRefText, `{"apiKey":"sk-new"}`)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeError(t, recorder); payload.Error != "account_not_found" {
		t.Fatalf("error = %q, want account_not_found", payload.Error)
	}
	if len(editor.calls) != 0 {
		t.Fatalf("Edit() calls = %d, want 0", len(editor.calls))
	}
}

func TestUpdateRejectsMalformedBody(t *testing.T) {
	accountRef := testAccountRef(t)
	cases := []struct {
		name string
		body string
	}{
		{name: "invalid json", body: `{"apiKey":`},
		{name: "trailing json", body: `{} {}`},
		{name: "wrong field type", body: `{"baseUrl":42}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			editor := &stubEditor{}
			handler := newUpdateHandler(t, testAuthorizer(true), stubDirectory{
				overview: testOverview(t, testProvider, accountRef),
			}, editor)
			recorder := postUpdate(t, handler, testProvider, testRefText, testCase.body)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if payload := decodeError(t, recorder); payload.Error != "invalid_request" {
				t.Fatalf("error = %q, want invalid_request", payload.Error)
			}
			if len(editor.calls) != 0 {
				t.Fatalf("Edit() calls = %d, want 0", len(editor.calls))
			}
		})
	}
}

func TestUpdateRejectsOversizedBody(t *testing.T) {
	accountRef := testAccountRef(t)
	editor := &stubEditor{}
	handler := newUpdateHandler(t, testAuthorizer(true), stubDirectory{
		overview: testOverview(t, testProvider, accountRef),
	}, editor)
	body := `{"apiKey":"` + strings.Repeat("a", maxBodyBytes+1) + `"}`

	recorder := postUpdate(t, handler, testProvider, testRefText, body)

	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeError(t, recorder); payload.Error != "request_too_large" {
		t.Fatalf("error = %q, want request_too_large", payload.Error)
	}
	if len(editor.calls) != 0 {
		t.Fatalf("Edit() calls = %d, want 0", len(editor.calls))
	}
}

func TestUpdateMapsUseCaseErrors(t *testing.T) {
	accountRef := testAccountRef(t)
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "account not found",
			err:        accountapp.ErrAccountNotFound,
			wantStatus: http.StatusNotFound,
			wantCode:   "account_not_found",
		},
		{
			name:       "edit incomplete",
			err:        accountapp.ErrStaticCredentialEditIncomplete,
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_static_credential_edit",
		},
		{
			name:       "rotation unsupported",
			err:        accountapp.ErrStaticCredentialRotationUnsupported,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "static_credential_rotation_unsupported",
		},
		{
			name:       "rotation conflict",
			err:        accountapp.ErrStaticCredentialRotationConflict,
			wantStatus: http.StatusConflict,
			wantCode:   "static_credential_rotation_conflict",
		},
		{
			name:       "invalid rotation",
			err:        accountapp.ErrInvalidStaticCredentialRotation,
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "invalid_account",
		},
		{
			name:       "base url unsupported",
			err:        accountapp.ErrStaticBaseURLUnsupported,
			wantStatus: http.StatusBadRequest,
			wantCode:   "base_url_unsupported",
		},
		{
			name:       "invalid base url",
			err:        accountcore.ErrInvalidStaticBaseURL,
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_base_url",
		},
		{
			name:       "invalid api key",
			err:        accountcore.ErrInvalidStaticAPIKey,
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_api_key",
		},
		{
			name:       "unexpected failure",
			err:        errors.New("boom"),
			wantStatus: http.StatusInternalServerError,
			wantCode:   "internal_error",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			editor := &stubEditor{err: testCase.err}
			handler := newUpdateHandler(t, testAuthorizer(true), stubDirectory{
				overview: testOverview(t, testProvider, accountRef),
			}, editor)
			recorder := postUpdate(t, handler, testProvider, testRefText, `{"apiKey":"sk-new"}`)

			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if payload := decodeError(t, recorder); payload.Error != testCase.wantCode {
				t.Fatalf("error = %q, want %q", payload.Error, testCase.wantCode)
			}
			if len(editor.calls) != 1 {
				t.Fatalf("Edit() calls = %d, want 1", len(editor.calls))
			}
		})
	}
}

func TestUpdateForwardsAuthKindAndNonCodexProvider(t *testing.T) {
	accountRef := testAccountRef(t)
	cases := []struct {
		name     string
		provider string
		body     string
		wantKind string
	}{
		{
			name:     "claude credentialType",
			provider: "claude",
			body:     `{"apiKey":"tok-new","credentialType":"auth-token"}`,
			wantKind: "auth-token",
		},
		{
			name:     "claude authMode fallback",
			provider: "claude",
			body:     `{"apiKey":"sk-new","authMode":"api-key"}`,
			wantKind: "api-key",
		},
		{
			name:     "kimi generic static provider",
			provider: "kimi",
			body:     `{"apiKey":"sk-kimi","baseUrl":"https://api.moonshot.cn/v1"}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			editor := &stubEditor{}
			handler := newUpdateHandler(t, testAuthorizer(true), stubDirectory{
				overview: testOverview(t, testCase.provider, accountRef),
			}, editor)
			recorder := postUpdate(t, handler, testCase.provider, testRefText, testCase.body)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if len(editor.calls) != 1 || editor.calls[0].edit.AuthKind != testCase.wantKind {
				t.Fatalf("calls = %+v, want AuthKind=%q", editor.calls, testCase.wantKind)
			}
		})
	}
}
