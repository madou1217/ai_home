package accountsapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

// TestImportHandlersReportCreateAndIdempotentOutcomes 验证两个导入协议共享同一
// 应用用例，并用 HTTP 状态区分新建和同身份幂等命中。
func TestImportHandlersReportCreateAndIdempotentOutcomes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		path          string
		body          string
		alreadyExists bool
		wantStatus    int
	}{
		{
			name:       "native creates",
			path:       NativeImportPath,
			body:       `{"provider_id":"codex","artifacts":{"auth_json":{}}}`,
			wantStatus: http.StatusCreated,
		},
		{
			name:          "native idempotent",
			path:          NativeImportPath,
			body:          `{"provider_id":"codex","artifacts":{"auth_json":{}}}`,
			alreadyExists: true,
			wantStatus:    http.StatusOK,
		},
		{
			name:       "sub2api creates",
			path:       Sub2APIImportPath,
			body:       `{}`,
			wantStatus: http.StatusCreated,
		},
		{
			name:          "sub2api idempotent",
			path:          Sub2APIImportPath,
			body:          `{}`,
			alreadyExists: true,
			wantStatus:    http.StatusOK,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
				APIKey: "synthetic-import-handler-key",
			})
			if err != nil {
				t.Fatalf("NewAPIKeyAuth() error = %v", err)
			}
			account := newImportHandlerAccount(t, credential)
			registration := &importHandlerRegistration{
				account:       account,
				alreadyExists: test.alreadyExists,
			}
			reader := &importHandlerReader{account: account}
			importer, err := accountapp.NewAccountImporter(
				registration,
				reader,
				importHandlerReauthentication{},
			)
			if err != nil {
				t.Fatalf("NewAccountImporter() error = %v", err)
			}
			overview := newImportHandlerOverview(t, account)
			management := &importHandlerManagement{overview: overview}
			handler := &Handler{
				management: management,
				importer:   importer,
				native:     importHandlerDecoder{credential: credential},
				sub2api:    importHandlerDecoder{credential: credential},
			}

			request := httptest.NewRequest(
				http.MethodPost,
				test.path,
				strings.NewReader(test.body),
			)
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			if test.path == NativeImportPath {
				handler.handleNativeImport(response, request)
			} else {
				handler.handleSub2APIImport(response, request)
			}

			if response.Code != test.wantStatus {
				t.Fatalf(
					"import status=%d, want=%d body=%s",
					response.Code,
					test.wantStatus,
					response.Body,
				)
			}
			wantReads := 0
			if test.alreadyExists {
				wantReads = 1
			}
			if registration.calls != 1 || reader.calls != wantReads ||
				management.accountRef != account.Ref() {
				t.Fatalf(
					"registration=%d reader=%d overview_ref=%q",
					registration.calls,
					reader.calls,
					management.accountRef,
				)
			}
			if strings.Contains(response.Body.String(), credential.APIKey()) {
				t.Fatal("导入响应泄漏静态凭据")
			}
		})
	}
}

type importHandlerRegistration struct {
	account       accountcore.Account
	alreadyExists bool
	calls         int
}

func (registration *importHandlerRegistration) Register(
	context.Context,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	registration.calls++
	if registration.alreadyExists {
		return accountcore.Account{}, accountapp.ErrAccountConflict
	}
	return registration.account, nil
}

type importHandlerReader struct {
	account accountcore.Account
	calls   int
}

func (reader *importHandlerReader) GetByRef(
	context.Context,
	accountcore.AccountRef,
) (accountcore.Account, error) {
	reader.calls++
	return reader.account, nil
}

type importHandlerReauthentication struct{}

func (importHandlerReauthentication) Reauthenticate(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	return accountcore.Account{}, accountapp.ErrInvalidAccountImport
}

type importHandlerManagement struct {
	overview   accountapp.AccountOverview
	accountRef accountcore.AccountRef
}

func (*importHandlerManagement) ListAccountOverviews(
	context.Context,
	accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
	return nil, accountapp.ErrInvalidOverview
}

func (management *importHandlerManagement) GetAccountOverview(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.AccountOverview, error) {
	management.accountRef = accountRef
	return management.overview, nil
}

func (*importHandlerManagement) GetAccountOverviewByCLIAccountID(
	context.Context,
	string,
	accountcore.CLIAccountID,
) (accountapp.AccountOverview, error) {
	return accountapp.AccountOverview{}, accountapp.ErrAccountNotFound
}

func (*importHandlerManagement) SetAccountEnabled(
	context.Context,
	accountcore.AccountRef,
	bool,
) (accountcore.Account, error) {
	return accountcore.Account{}, accountapp.ErrAccountNotFound
}

type importHandlerDecoder struct {
	credential accountapp.Credential
}

func (importHandlerDecoder) Supports(providerID string) bool {
	return providerID == codex.ProviderID
}

func (decoder importHandlerDecoder) Decode(
	string,
	[]byte,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	return decoder.credential, nil, nil
}

func (decoder importHandlerDecoder) DecodeAccount(
	[]byte,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	return decoder.credential, nil, nil
}

func newImportHandlerAccount(
	t *testing.T,
	credential accountapp.Credential,
) accountcore.Account {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    time.Date(2026, 8, 15, 1, 2, 3, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return account
}

func newImportHandlerOverview(
	t *testing.T,
	account accountcore.Account,
) accountapp.AccountOverview {
	t.Helper()

	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       account,
		HasCredential: true,
		AuthKind:      "api_key",
	})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	return overview
}
