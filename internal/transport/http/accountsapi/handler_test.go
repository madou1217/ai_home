package accountsapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const testManagementKey = "synthetic-management-key-for-accounts-api"

// TestHandlerListsAccountsWithStableCursor 验证管理列表鉴权、游标和脱敏响应合同。
func TestHandlerListsAccountsWithStableCursor(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	first := newTestOverview(t, service.catalog, 1, "http-list-first")
	second := newTestOverview(t, service.catalog, 2, "http-list-second")
	service.listResult = []accountapp.AccountOverview{first, second}
	handler := newTestHandler(t, service)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(
		unauthorized,
		httptest.NewRequest(http.MethodGet, "/v1/management/accounts?limit=1", nil),
	)
	assertAPIError(t, unauthorized, http.StatusUnauthorized, "unauthorized")
	if service.listCalls != 0 {
		t.Fatalf("未授权请求进入应用层: calls=%d", service.listCalls)
	}

	request := httptest.NewRequest(
		http.MethodGet,
		"/v1/management/accounts?limit=1",
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+testManagementKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("GET accounts status = %d body=%s", response.Code, response.Body)
	}
	if service.listCalls != 1 || service.listQuery.Limit() != 2 {
		t.Fatalf(
			"列表查询未多取一行: calls=%d limit=%d",
			service.listCalls,
			service.listQuery.Limit(),
		)
	}
	responseBody := response.Body.String()
	var document struct {
		Data []struct {
			AccountRef    string `json:"account_ref"`
			ProviderID    string `json:"provider_id"`
			CLIAccountID  int64  `json:"cli_account_id"`
			Enabled       bool   `json:"enabled"`
			HasCredential bool   `json:"has_credential"`
			AuthKind      string `json:"auth_kind"`
		} `json:"data"`
		Page struct {
			Limit        int    `json:"limit"`
			HasMore      bool   `json:"has_more"`
			NextAfterRef string `json:"next_after_ref"`
		} `json:"page"`
	}
	decodeResponseJSON(t, response, &document)
	if len(document.Data) != 1 ||
		document.Data[0].AccountRef != first.Account().Ref().String() ||
		document.Data[0].ProviderID != codex.ProviderID ||
		document.Data[0].CLIAccountID != 1 ||
		!document.Data[0].Enabled ||
		!document.Data[0].HasCredential ||
		document.Data[0].AuthKind != "api_key" {
		t.Fatalf("账号列表响应错误: %#v", document.Data)
	}
	if document.Page.Limit != 1 ||
		!document.Page.HasMore ||
		document.Page.NextAfterRef != first.Account().Ref().String() {
		t.Fatalf("账号分页响应错误: %#v", document.Page)
	}
	if !strings.Contains(responseBody, `"model_summary":null`) ||
		!strings.Contains(responseBody, `"usage_snapshot":null`) {
		t.Fatalf("无派生快照必须显式返回 null: %s", responseBody)
	}
	assertSafeResponseHeaders(t, response)
}

func TestHandlerListsPersistedModelAndUsageEvidence(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	base := newTestOverview(t, service.catalog, 1, "http-list-derived")
	modelSummary, err := accountapp.NewAccountModelSummary(accountapp.AccountModelSummaryInput{
		Known:          true,
		StoredCount:    3,
		EffectiveCount: 2,
		UpdatedAt:      testHTTPTime().Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("NewAccountModelSummary() error = %v", err)
	}
	usageSnapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: base.Account().Ref(),
		ProviderID: base.Account().ProviderID(),
		Source:     "codex_wham_usage",
		CapturedAt: testHTTPTime().Add(2 * time.Minute),
		Entries: []usagecore.EntryInput{{
			Bucket:               "primary",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: 7_500,
			WindowSeconds:        18_000,
			ResetAt:              testHTTPTime().Add(5 * time.Hour),
			Availability:         usagecore.AvailabilityAvailable,
		}},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          base.Account(),
		HasCredential:    base.HasCredential(),
		AuthKind:         base.AuthKind(),
		ModelSummary:     modelSummary,
		HasUsageSnapshot: true,
		UsageSnapshot:    usageSnapshot,
	})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	service.listResult = []accountapp.AccountOverview{overview}

	response := performAuthorizedRequest(
		t,
		newTestHandler(t, service),
		http.MethodGet,
		accountsapi.CollectionPath+"?limit=1",
		nil,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("GET accounts status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		Data []struct {
			ModelSummary *struct {
				StoredCount    int    `json:"stored_count"`
				EffectiveCount int    `json:"effective_count"`
				UpdatedAt      string `json:"updated_at"`
			} `json:"model_summary"`
			UsageSnapshot *struct {
				Source     string `json:"source"`
				CapturedAt string `json:"captured_at"`
				Entries    []struct {
					Bucket               string  `json:"bucket"`
					RemainingBasisPoints *uint16 `json:"remaining_basis_points"`
				} `json:"entries"`
			} `json:"usage_snapshot"`
		} `json:"data"`
	}
	decodeResponseJSON(t, response, &document)
	if len(document.Data) != 1 || document.Data[0].ModelSummary == nil ||
		document.Data[0].ModelSummary.StoredCount != 3 ||
		document.Data[0].ModelSummary.EffectiveCount != 2 ||
		document.Data[0].ModelSummary.UpdatedAt != "2026-07-27T18:01:00Z" ||
		document.Data[0].UsageSnapshot == nil ||
		document.Data[0].UsageSnapshot.Source != "codex_wham_usage" ||
		document.Data[0].UsageSnapshot.CapturedAt != "2026-07-27T18:02:00Z" ||
		len(document.Data[0].UsageSnapshot.Entries) != 1 ||
		document.Data[0].UsageSnapshot.Entries[0].Bucket != "primary" ||
		document.Data[0].UsageSnapshot.Entries[0].RemainingBasisPoints == nil ||
		*document.Data[0].UsageSnapshot.Entries[0].RemainingBasisPoints != 7_500 {
		t.Fatalf("derived account view = %#v", document.Data)
	}
}

// TestHandlerManagesProviderDefaultResource 验证默认账号 PUT、GET 和幂等 DELETE 合同。
func TestHandlerManagesProviderDefaultResource(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 1, "http-provider-default")
	handler := newTestHandler(t, service)
	path := accountsapi.DefaultsPath + "/codex"
	payload := marshalRequestJSON(t, map[string]string{
		"account_ref": overview.Account().Ref().String(),
	})

	set := performAuthorizedRequest(t, handler, http.MethodPut, path, payload)
	if set.Code != http.StatusOK {
		t.Fatalf("PUT default status=%d body=%s", set.Code, set.Body)
	}
	setBody := set.Body.String()
	var setDocument struct {
		Data struct {
			ProviderID string `json:"provider_id"`
			AccountRef string `json:"account_ref"`
			UpdatedAt  string `json:"updated_at"`
		} `json:"data"`
	}
	decodeResponseJSON(t, set, &setDocument)
	if setDocument.Data.ProviderID != "codex" ||
		setDocument.Data.AccountRef != overview.Account().Ref().String() ||
		setDocument.Data.UpdatedAt != "2026-07-27T18:00:00Z" ||
		service.setDefaultCalls != 1 ||
		service.defaultAccountRef != overview.Account().Ref() {
		t.Fatalf("PUT default response=%#v service=%#v", setDocument.Data, service)
	}

	get := performAuthorizedRequest(t, handler, http.MethodGet, path, nil)
	if get.Code != http.StatusOK || get.Body.String() != setBody ||
		service.getDefaultCalls != 1 {
		t.Fatalf("GET default status=%d body=%s", get.Code, get.Body)
	}
	cleared := performAuthorizedRequest(t, handler, http.MethodDelete, path, nil)
	if cleared.Code != http.StatusNoContent || cleared.Body.Len() != 0 ||
		service.clearDefaultCalls != 1 || service.defaultProviderID != "codex" {
		t.Fatalf(
			"DELETE default status=%d body=%q service=%#v",
			cleared.Code,
			cleared.Body.String(),
			service,
		)
	}
	assertSafeResponseHeaders(t, set)
	assertSafeResponseHeaders(t, get)
}

// TestHandlerRejectsInvalidOrIneligibleProviderDefaults 验证入站格式和应用错误映射稳定。
func TestHandlerRejectsInvalidOrIneligibleProviderDefaults(t *testing.T) {
	t.Parallel()

	validRef := newTestOverview(
		t,
		newAccountServiceStub(t).catalog,
		1,
		"http-provider-default-errors",
	).Account().Ref().String()
	tests := []struct {
		name   string
		path   string
		body   string
		err    error
		status int
		code   string
	}{
		{
			name:   "账号引用格式无效",
			path:   accountsapi.DefaultsPath + "/codex",
			body:   `{"account_ref":"invalid"}`,
			status: http.StatusBadRequest,
			code:   "invalid_account_ref",
		},
		{
			name:   "账号已停用",
			path:   accountsapi.DefaultsPath + "/codex",
			body:   `{"account_ref":"` + validRef + `"}`,
			err:    accountapp.ErrProviderDefaultDisabled,
			status: http.StatusUnprocessableEntity,
			code:   "default_account_disabled",
		},
		{
			name:   "账号未配置",
			path:   accountsapi.DefaultsPath + "/claude",
			body:   `{"account_ref":"` + validRef + `"}`,
			err:    accountapp.ErrProviderDefaultUnconfigured,
			status: http.StatusUnprocessableEntity,
			code:   "default_account_unconfigured",
		},
		{
			name:   "Provider 不匹配",
			path:   accountsapi.DefaultsPath + "/claude",
			body:   `{"account_ref":"` + validRef + `"}`,
			err:    accountapp.ErrProviderDefaultMismatch,
			status: http.StatusUnprocessableEntity,
			code:   "default_account_provider_mismatch",
		},
		{
			name:   "本阶段不支持其他 Provider",
			path:   accountsapi.DefaultsPath + "/gemini",
			body:   `{"account_ref":"` + validRef + `"}`,
			err:    accountapp.ErrInvalidProviderDefault,
			status: http.StatusUnprocessableEntity,
			code:   "invalid_provider_default",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			service.defaultErr = test.err
			handler := newTestHandler(t, service)
			response := performAuthorizedRequest(
				t,
				handler,
				http.MethodPut,
				test.path,
				[]byte(test.body),
			)
			assertAPIError(t, response, test.status, test.code)
			wantCalls := 1
			if test.err == nil {
				wantCalls = 0
			}
			if service.setDefaultCalls != wantCalls {
				t.Fatalf("set default calls=%d, want %d", service.setDefaultCalls, wantCalls)
			}
		})
	}

	service := newAccountServiceStub(t)
	service.defaultErr = accountapp.ErrProviderDefaultNotFound
	notFound := performAuthorizedRequest(
		t,
		newTestHandler(t, service),
		http.MethodGet,
		accountsapi.DefaultsPath+"/codex",
		nil,
	)
	assertAPIError(t, notFound, http.StatusNotFound, "default_account_not_found")
}

// TestHandlerResolvesLaunchAccountSelection 验证显式身份和 Provider 默认选择共享非敏感响应合同。
func TestHandlerResolvesLaunchAccountSelection(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 7, "http-launch-selection")
	account := overview.Account()
	selection, err := accountapp.NewLaunchSelection(
		account,
		accountapp.LaunchSelectionSourceAccountRef,
	)
	if err != nil {
		t.Fatalf("NewLaunchSelection() error = %v", err)
	}
	service.selectionResult = selection
	response := performAuthorizedRequest(
		t,
		newTestHandler(t, service),
		http.MethodPost,
		accountsapi.SelectionPath,
		marshalRequestJSON(t, map[string]any{
			"provider_id": "codex",
			"account_ref": account.Ref().String(),
		}),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("POST selection status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		Data struct {
			ProviderID   string `json:"provider_id"`
			AccountRef   string `json:"account_ref"`
			CLIAccountID int64  `json:"cli_account_id"`
			Source       string `json:"selection_source"`
		} `json:"data"`
	}
	decodeResponseJSON(t, response, &document)
	if document.Data.ProviderID != "codex" ||
		document.Data.AccountRef != account.Ref().String() ||
		document.Data.CLIAccountID != 7 ||
		document.Data.Source != "account_ref" ||
		service.selectionCalls != 1 ||
		service.selectionRequest.ProviderID != "codex" ||
		service.selectionRequest.AccountRef != account.Ref() ||
		service.selectionRequest.CLIAccountID != 0 {
		t.Fatalf(
			"selection response=%#v calls=%d request=%#v",
			document.Data,
			service.selectionCalls,
			service.selectionRequest,
		)
	}
	assertSafeResponseHeaders(t, response)
}

// TestHandlerParsesCLIAndDefaultLaunchSelections 验证数字别名与未指定账号的输入不会混淆。
func TestHandlerParsesCLIAndDefaultLaunchSelections(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		body      string
		wantAlias int64
	}{
		{
			name:      "cli account id",
			body:      `{"provider_id":"claude","cli_account_id":9}`,
			wantAlias: 9,
		},
		{
			name: "provider default",
			body: `{"provider_id":"claude"}`,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			service.selectionErr = accountapp.ErrProviderDefaultNotFound
			response := performAuthorizedRequest(
				t,
				newTestHandler(t, service),
				http.MethodPost,
				accountsapi.SelectionPath,
				[]byte(test.body),
			)
			assertAPIError(
				t,
				response,
				http.StatusNotFound,
				"default_account_not_found",
			)
			if service.selectionCalls != 1 ||
				service.selectionRequest.ProviderID != "claude" ||
				service.selectionRequest.CLIAccountID.Int64() != test.wantAlias ||
				service.selectionRequest.AccountRef != "" {
				t.Fatalf("selection request = %#v", service.selectionRequest)
			}
		})
	}
}

// TestHandlerRejectsInvalidOrIneligibleLaunchSelections 验证启动选择的格式和状态错误映射稳定。
func TestHandlerRejectsInvalidOrIneligibleLaunchSelections(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		body      string
		err       error
		status    int
		code      string
		wantCalls int
	}{
		{
			name:   "invalid account ref",
			body:   `{"provider_id":"codex","account_ref":"invalid"}`,
			status: http.StatusBadRequest,
			code:   "invalid_account_ref",
		},
		{
			name:   "invalid cli account id",
			body:   `{"provider_id":"codex","cli_account_id":0}`,
			status: http.StatusBadRequest,
			code:   "invalid_cli_account_id",
		},
		{
			name:      "ambiguous target",
			body:      `{"provider_id":"codex","account_ref":"acct_0123456789abcdef0123","cli_account_id":1}`,
			err:       accountapp.ErrInvalidLaunchSelection,
			status:    http.StatusUnprocessableEntity,
			code:      "invalid_account_selection",
			wantCalls: 1,
		},
		{
			name:      "provider mismatch",
			body:      `{"provider_id":"codex","account_ref":"acct_0123456789abcdef0123"}`,
			err:       accountapp.ErrLaunchSelectionProviderMismatch,
			status:    http.StatusUnprocessableEntity,
			code:      "account_selection_provider_mismatch",
			wantCalls: 1,
		},
		{
			name:      "disabled",
			body:      `{"provider_id":"codex","cli_account_id":1}`,
			err:       accountapp.ErrLaunchSelectionDisabled,
			status:    http.StatusConflict,
			code:      "account_selection_disabled",
			wantCalls: 1,
		},
		{
			name:      "unconfigured",
			body:      `{"provider_id":"codex"}`,
			err:       accountapp.ErrLaunchSelectionUnconfigured,
			status:    http.StatusConflict,
			code:      "account_selection_unconfigured",
			wantCalls: 1,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			service.selectionErr = test.err
			response := performAuthorizedRequest(
				t,
				newTestHandler(t, service),
				http.MethodPost,
				accountsapi.SelectionPath,
				[]byte(test.body),
			)
			assertAPIError(t, response, test.status, test.code)
			if service.selectionCalls != test.wantCalls {
				t.Fatalf(
					"selection calls=%d, want %d",
					service.selectionCalls,
					test.wantCalls,
				)
			}
		})
	}
}

// TestHandlerRotatesStaticCredentialWithoutChangingPublicAccountRef 验证 PUT 子资源不会泄漏或替换账号身份。
func TestHandlerRotatesStaticCredentialWithoutChangingPublicAccountRef(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 7, "http-rotation-old-key")
	service.overview = &overview
	handler := newTestHandler(t, service)
	path := accountsapi.CollectionPath + "/" +
		overview.Account().Ref().String() + "/credential"
	secret := "http-rotation-new-key-must-not-leak"
	request := httptest.NewRequest(
		http.MethodPut,
		path,
		strings.NewReader(`{"auth":{"kind":"api_key","api_key":"`+secret+`",`+
			`"base_url":"https://api.openai.com/v1"}}`),
	)
	request.Header.Set("Authorization", "Bearer "+testManagementKey)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("PUT credential status=%d body=%s", response.Code, response.Body)
	}
	if service.rotationCalls != 1 ||
		service.rotationRef != overview.Account().Ref() ||
		service.rotationCredential == nil ||
		service.rotationCredential.ProviderID() != codex.ProviderID ||
		strings.Contains(response.Body.String(), secret) {
		t.Fatalf(
			"rotation calls=%d ref=%s credential=%T body=%s",
			service.rotationCalls,
			service.rotationRef,
			service.rotationCredential,
			response.Body,
		)
	}
	var document struct {
		Data struct {
			AccountRef   string `json:"account_ref"`
			CLIAccountID int64  `json:"cli_account_id"`
			AuthKind     string `json:"auth_kind"`
		} `json:"data"`
	}
	decodeResponseJSON(t, response, &document)
	if document.Data.AccountRef != overview.Account().Ref().String() ||
		document.Data.CLIAccountID != 7 ||
		document.Data.AuthKind != "api_key" {
		t.Fatalf("rotation response = %#v", document.Data)
	}
	assertSafeResponseHeaders(t, response)
}

// TestBuiltinStaticCredentialFactorySupportsOnlyDeclaredProviderKinds 验证 Claude 类型切换和 Codex 拒绝边界。
func TestBuiltinStaticCredentialFactorySupportsOnlyDeclaredProviderKinds(t *testing.T) {
	t.Parallel()

	factory := accountsapi.NewBuiltinStaticCredentialFactory()
	credential, err := factory.BuildStatic(
		claude.ProviderID,
		"auth_token",
		"",
		"synthetic-claude-auth-token",
		"",
	)
	if err != nil {
		t.Fatalf("BuildStatic(claude auth token) error = %v", err)
	}
	if _, ok := credential.(*claude.AuthTokenAuth); !ok {
		t.Fatalf("credential type = %T", credential)
	}
	_, err = factory.BuildStatic(
		codex.ProviderID,
		"auth_token",
		"",
		"unsupported-codex-token",
		"",
	)
	if !errors.Is(err, accountsapi.ErrUnsupportedStaticAuthKind) {
		t.Fatalf("BuildStatic(codex auth token) error = %v", err)
	}
	_, err = factory.BuildStatic(
		claude.ProviderID,
		"api_key",
		"synthetic-key",
		"unexpected-token",
		"",
	)
	if !errors.Is(err, accountsapi.ErrInvalidStaticCredentialInput) {
		t.Fatalf("BuildStatic(mixed fields) error = %v", err)
	}
}

// TestHandlerRejectsUnsafeStaticCredentialRotations 验证 HTTP 边界保留稳定错误且不泄漏凭据。
func TestHandlerRejectsUnsafeStaticCredentialRotations(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		body          string
		rotationErr   error
		status        int
		code          string
		rotationCalls int
	}{
		{
			name: "OAuth 账号拒绝静态轮换",
			body: `{"auth":{"kind":"api_key",` +
				`"api_key":"oauth-replacement-must-not-leak"}}`,
			rotationErr:   accountapp.ErrStaticCredentialRotationUnsupported,
			status:        http.StatusUnprocessableEntity,
			code:          "static_credential_rotation_unsupported",
			rotationCalls: 1,
		},
		{
			name: "当前凭据被其他账号占用",
			body: `{"auth":{"kind":"api_key",` +
				`"api_key":"conflicting-key-must-not-leak"}}`,
			rotationErr:   accountapp.ErrStaticCredentialRotationConflict,
			status:        http.StatusConflict,
			code:          "static_credential_rotation_conflict",
			rotationCalls: 1,
		},
		{
			name: "Codex 拒绝 auth token",
			body: `{"auth":{"kind":"auth_token",` +
				`"auth_token":"codex-token-must-not-leak"}}`,
			status:        http.StatusUnprocessableEntity,
			code:          "unsupported_auth_kind",
			rotationCalls: 0,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			overview := newTestOverview(t, service.catalog, 8, "rotation-guard-old-key")
			service.overview = &overview
			service.rotationErr = test.rotationErr
			handler := newTestHandler(t, service)
			path := accountsapi.CollectionPath + "/" +
				overview.Account().Ref().String() + "/credential"
			response := performAuthorizedRequest(
				t,
				handler,
				http.MethodPut,
				path,
				[]byte(test.body),
			)

			assertAPIError(t, response, test.status, test.code)
			if service.rotationCalls != test.rotationCalls {
				t.Fatalf(
					"rotation calls=%d, want %d",
					service.rotationCalls,
					test.rotationCalls,
				)
			}
			if strings.Contains(response.Body.String(), "must-not-leak") {
				t.Fatalf("HTTP 错误响应泄漏凭据: %s", response.Body)
			}
			assertSafeResponseHeaders(t, response)
		})
	}
}

// TestHandlerReadsAndRefreshesAccountUsage 验证额度子资源路径、null 数值和显式刷新命令。
func TestHandlerReadsAndRefreshesAccountUsage(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 1, "http-usage-account")
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: overview.Account().Ref(),
		ProviderID: "codex",
		Source:     "codex_wham_usage",
		CapturedAt: testHTTPTime(),
		Entries: []usagecore.EntryInput{
			{
				Bucket:       "credits",
				Kind:         usagecore.KindCredits,
				Scope:        usagecore.ScopeAccount,
				Availability: usagecore.AvailabilityUnlimited,
			},
			{
				Bucket:               "primary",
				Kind:                 usagecore.KindWindow,
				Scope:                usagecore.ScopeAccount,
				HasRemaining:         true,
				RemainingBasisPoints: 7_500,
				WindowSeconds:        18_000,
				ResetAt:              testHTTPTime().Add(time.Hour),
				Availability:         usagecore.AvailabilityAvailable,
			},
		},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	service.usageResult, err = usageapp.NewReadResult(snapshot, true)
	if err != nil {
		t.Fatalf("NewReadResult() error = %v", err)
	}
	handler := newTestHandler(t, service)
	path := accountsapi.CollectionPath + "/" +
		overview.Account().Ref().String() + "/usage"

	getResponse := httptest.NewRecorder()
	getRequest := httptest.NewRequest(http.MethodGet, path, nil)
	getRequest.Header.Set("Authorization", "Bearer "+testManagementKey)
	handler.ServeHTTP(getResponse, getRequest)
	if getResponse.Code != http.StatusOK {
		t.Fatalf("GET usage status=%d body=%s", getResponse.Code, getResponse.Body)
	}
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
			Stale      bool   `json:"stale"`
			Entries    []struct {
				Bucket               string  `json:"bucket"`
				RemainingBasisPoints *uint16 `json:"remaining_basis_points"`
				WindowSeconds        *int64  `json:"window_seconds"`
				ResetAt              *string `json:"reset_at"`
			} `json:"entries"`
		} `json:"data"`
	}
	decodeResponseJSON(t, getResponse, &document)
	if document.Data.AccountRef != overview.Account().Ref().String() ||
		!document.Data.Stale ||
		len(document.Data.Entries) != 2 ||
		document.Data.Entries[0].Bucket != "credits" ||
		document.Data.Entries[0].RemainingBasisPoints != nil ||
		document.Data.Entries[0].WindowSeconds != nil ||
		document.Data.Entries[0].ResetAt != nil ||
		document.Data.Entries[1].RemainingBasisPoints == nil ||
		*document.Data.Entries[1].RemainingBasisPoints != 7_500 {
		t.Fatalf("GET usage response = %#v", document.Data)
	}

	refreshResponse := httptest.NewRecorder()
	refreshRequest := httptest.NewRequest(
		http.MethodPost,
		path+"/refresh",
		nil,
	)
	refreshRequest.Header.Set("Authorization", "Bearer "+testManagementKey)
	handler.ServeHTTP(refreshResponse, refreshRequest)
	if refreshResponse.Code != http.StatusOK ||
		service.getUsageCalls != 1 ||
		service.refreshUsageCalls != 1 {
		t.Fatalf(
			"POST usage refresh status=%d get=%d refresh=%d body=%s",
			refreshResponse.Code,
			service.getUsageCalls,
			service.refreshUsageCalls,
			refreshResponse.Body,
		)
	}
}

// TestBearerAuthorizerRejectsAmbiguousHeaders 验证动态密钥和多值请求头始终失败关闭。
func TestBearerAuthorizerRejectsAmbiguousHeaders(t *testing.T) {
	t.Parallel()

	activeKey := "first-synthetic-management-key"
	authorizer, err := accountsapi.NewBearerAuthorizer(func() string {
		return activeKey
	})
	if err != nil {
		t.Fatalf("NewBearerAuthorizer() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/management/accounts", nil)
	request.Header.Set("Authorization", "Bearer "+activeKey)
	if !authorizer.Authorized(request) {
		t.Fatal("有效 Management Key 未通过鉴权")
	}

	activeKey = "rotated-synthetic-management-key"
	if authorizer.Authorized(request) {
		t.Fatal("轮换前的 Management Key 仍然通过鉴权")
	}
	request.Header.Set("Authorization", "Bearer "+activeKey)
	request.Header.Add("Authorization", "Bearer "+activeKey)
	if authorizer.Authorized(request) {
		t.Fatal("多个 Authorization 请求头不应通过鉴权")
	}
}

// TestHandlerGetsAndDisablesAccount 验证详情点查和 PATCH 启停共享同一公开投影。
func TestHandlerGetsAndDisablesAccount(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 7, "http-detail-account")
	service.overview = &overview
	handler := newTestHandler(t, service)
	path := "/v1/management/accounts/" + overview.Account().Ref().String()

	getResponse := performAuthorizedRequest(t, handler, http.MethodGet, path, nil)
	if getResponse.Code != http.StatusOK {
		t.Fatalf("GET account status = %d body=%s", getResponse.Code, getResponse.Body)
	}
	assertResponseEnabled(t, getResponse, true)

	patchResponse := performAuthorizedRequest(
		t,
		handler,
		http.MethodPatch,
		path,
		[]byte(`{"enabled":false}`),
	)
	if patchResponse.Code != http.StatusOK {
		t.Fatalf("PATCH account status = %d body=%s", patchResponse.Code, patchResponse.Body)
	}
	assertResponseEnabled(t, patchResponse, false)
	if service.setEnabledCalls != 1 ||
		service.setEnabledRef != overview.Account().Ref() ||
		service.setEnabledValue {
		t.Fatalf(
			"启停命令错误: calls=%d ref=%s enabled=%t",
			service.setEnabledCalls,
			service.setEnabledRef,
			service.setEnabledValue,
		)
	}
}

// TestHandlerResolvesAccountAliasWithoutApplyingLaunchEligibility 验证已停用
// 账号仍可通过 Provider 数字别名解析，供后续 enable 命令使用。
func TestHandlerResolvesAccountAliasWithoutApplyingLaunchEligibility(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 7, "http-alias-account")
	disabled, err := overview.Account().WithEnabled(
		false,
		overview.Account().UpdatedAt().Add(time.Minute),
	)
	if err != nil {
		t.Fatalf("WithEnabled(false) error = %v", err)
	}
	disabledOverview := cloneOverviewWithAccount(t, overview, disabled)
	service.overview = &disabledOverview
	handler := newTestHandler(t, service)
	path := accountsapi.AliasesPath + "/codex/7"

	response := performAuthorizedRequest(t, handler, http.MethodGet, path, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("GET alias status = %d body=%s", response.Code, response.Body)
	}
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
			Enabled    bool   `json:"enabled"`
		} `json:"data"`
	}
	decodeResponseJSON(t, response, &document)
	if document.Data.Enabled ||
		document.Data.AccountRef != overview.Account().Ref().String() {
		t.Fatalf("alias response = %+v", document.Data)
	}

	for _, invalidPath := range []string{
		accountsapi.AliasesPath + "/Codex/7",
		accountsapi.AliasesPath + "/codex/07",
		accountsapi.AliasesPath + "/codex/7/extra",
	} {
		invalid := performAuthorizedRequest(
			t,
			handler,
			http.MethodGet,
			invalidPath,
			nil,
		)
		if invalid.Code != http.StatusBadRequest ||
			!strings.Contains(invalid.Body.String(), `"code":"invalid_account_alias"`) {
			t.Fatalf("invalid alias %s status=%d body=%s", invalidPath, invalid.Code, invalid.Body)
		}
	}
}

// TestHandlerDeletesAccountWithNoResponseBody 验证成员 DELETE 的状态、空响应体和应用调用。
func TestHandlerDeletesAccountWithNoResponseBody(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 8, "http-delete-account")
	handler := newTestHandler(t, service)
	path := accountsapi.CollectionPath + "/" + overview.Account().Ref().String()

	response := performAuthorizedRequest(
		t,
		handler,
		http.MethodDelete,
		path,
		nil,
	)
	if response.Code != http.StatusNoContent ||
		response.Body.Len() != 0 ||
		service.deleteCalls != 1 ||
		service.deleteRef != overview.Account().Ref() {
		t.Fatalf(
			"DELETE status=%d body=%q calls=%d ref=%s",
			response.Code,
			response.Body.String(),
			service.deleteCalls,
			service.deleteRef,
		)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("DELETE Cache-Control = %q", response.Header().Get("Cache-Control"))
	}

	service.deleteErr = accountapp.ErrAccountNotFound
	missing := performAuthorizedRequest(
		t,
		handler,
		http.MethodDelete,
		path,
		nil,
	)
	assertAPIError(t, missing, http.StatusNotFound, "account_not_found")
}

// TestHandlerExportsOneAccountAsSub2APIData 验证单账号导出的路由、附件头和原始 JSON。
func TestHandlerExportsOneAccountAsSub2APIData(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 9, "http-export-account")
	service.exportDocument = []byte(
		`{"type":"sub2api-data","exported_at":"2026-07-31T08:09:10Z",` +
			`"proxies":[],"accounts":[{"credentials":{"api_key":` +
			`"synthetic-http-export-key"}}]}`,
	)
	handler := newTestHandler(t, service)
	path := accountsapi.CollectionPath + "/" +
		overview.Account().Ref().String() + "/export"

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(
		unauthorized,
		httptest.NewRequest(http.MethodGet, path, nil),
	)
	assertAPIError(t, unauthorized, http.StatusUnauthorized, "unauthorized")
	if service.exportCalls != 0 {
		t.Fatalf("未授权导出进入应用层: calls=%d", service.exportCalls)
	}

	response := performAuthorizedRequest(
		t,
		handler,
		http.MethodGet,
		path,
		nil,
	)
	if response.Code != http.StatusOK ||
		service.exportCalls != 1 ||
		service.exportRef != overview.Account().Ref() {
		t.Fatalf(
			"GET export status=%d calls=%d ref=%s body=%s",
			response.Code,
			service.exportCalls,
			service.exportRef,
			response.Body,
		)
	}
	if response.Header().Get("Content-Disposition") !=
		`attachment; filename="sub2api-data.json"` {
		t.Fatalf(
			"Content-Disposition = %q",
			response.Header().Get("Content-Disposition"),
		)
	}
	if response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Content-Type") !=
			"application/json; charset=utf-8" {
		t.Fatalf("导出安全响应头 = %#v", response.Header())
	}
	if response.Body.String() != string(service.exportDocument)+"\n" {
		t.Fatalf("导出 body = %q", response.Body.String())
	}
}

// TestHandlerExportsOneAccountAsCLIProxyAPIAuth 验证独立 CPA 路径和导出器接线。
func TestHandlerExportsOneAccountAsCLIProxyAPIAuth(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 10, "http-cpa-export-account")
	exporter := &accountExporterStub{
		document: []byte(
			`{"id_token":"synthetic-id","access_token":"synthetic-access",` +
				`"refresh_token":"synthetic-refresh","account_id":"workspace",` +
				`"last_refresh":"2026-08-01T01:02:03Z",` +
				`"email":"account@example.invalid","type":"codex",` +
				`"expired":"2026-08-01T03:02:03Z","disabled":false}`,
		),
	}
	handler := newTestHandlerWithCLIProxyAPIExporter(t, service, exporter)
	path := accountsapi.CollectionPath + "/" +
		overview.Account().Ref().String() + "/export/cliproxyapi"

	response := performAuthorizedRequest(t, handler, http.MethodGet, path, nil)
	if response.Code != http.StatusOK ||
		exporter.calls != 1 ||
		exporter.accountRef != overview.Account().Ref() ||
		service.exportCalls != 0 {
		t.Fatalf(
			"GET CPA export status=%d calls=%d ref=%s sub2api_calls=%d body=%s",
			response.Code,
			exporter.calls,
			exporter.accountRef,
			service.exportCalls,
			response.Body,
		)
	}
	if response.Header().Get("Content-Disposition") !=
		`attachment; filename="cliproxyapi-auth.json"` {
		t.Fatalf(
			"Content-Disposition = %q",
			response.Header().Get("Content-Disposition"),
		)
	}
	if response.Header().Get("Cache-Control") != "no-store" ||
		response.Body.String() != string(exporter.document)+"\n" {
		t.Fatalf("CPA export headers=%#v body=%q", response.Header(), response.Body)
	}
}

// TestHandlerMapsAccountExportErrors 验证缺账号、缺凭据和不支持类型使用稳定 HTTP 语义。
func TestHandlerMapsAccountExportErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{
			name:   "account not found",
			err:    accountapp.ErrAccountNotFound,
			status: http.StatusNotFound,
			code:   "account_not_found",
		},
		{
			name:   "credential missing",
			err:    accountapp.ErrCredentialNotFound,
			status: http.StatusConflict,
			code:   "credential_not_found",
		},
		{
			name:   "unsupported credential",
			err:    accountapp.ErrUnsupportedAccountExport,
			status: http.StatusUnprocessableEntity,
			code:   "account_export_unsupported",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			service.exportErr = test.err
			handler := newTestHandler(t, service)
			response := performAuthorizedRequest(
				t,
				handler,
				http.MethodGet,
				accountsapi.CollectionPath+
					"/acct_a6624a747e4ccf287aa3/export",
				nil,
			)
			assertAPIError(t, response, test.status, test.code)
		})
	}
}

// TestHandlerManagesAccountModels 验证模型查询、人工策略和显式刷新 HTTP 合同。
func TestHandlerManagesAccountModels(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	overview := newTestOverview(t, service.catalog, 11, "http-model-account")
	service.overview = &overview
	service.modelResult = []accountapp.AccountModel{
		newHTTPAccountModel(
			t,
			overview.Account().Ref(),
			"gpt-5.6-sol",
			true,
			accountapp.ModelPolicyInherit,
		),
	}
	handler := newTestHandler(t, service)
	path := "/v1/management/accounts/" +
		overview.Account().Ref().String() +
		"/models"

	listed := performAuthorizedRequest(t, handler, http.MethodGet, path, nil)
	assertAccountModelResponse(t, listed, "gpt-5.6-sol", "inherit", true)

	updated := performAuthorizedRequest(
		t,
		handler,
		http.MethodPatch,
		path,
		[]byte(
			`{"model_id":"gpt-5.6-sol","manual_policy":"force_disable"}`,
		),
	)
	assertAccountModelResponse(
		t,
		updated,
		"gpt-5.6-sol",
		"force_disable",
		false,
	)
	if service.setModelCalls != 1 ||
		service.setModelRef != overview.Account().Ref() ||
		service.setModelID != "gpt-5.6-sol" ||
		service.setModelPolicy != accountapp.ModelPolicyForceDisable {
		t.Fatalf("set model command = %#v", service)
	}

	refreshed := performAuthorizedRequest(
		t,
		handler,
		http.MethodPost,
		path+"/refresh",
		nil,
	)
	assertAccountModelResponse(
		t,
		refreshed,
		"gpt-5.6-sol",
		"force_disable",
		false,
	)
	if service.refreshModelCalls != 1 ||
		service.refreshModelRef != overview.Account().Ref() {
		t.Fatalf("refresh model command = %#v", service)
	}
}

// TestHandlerRegistersBuiltinStaticCredentialsWithoutEchoingSecret 验证静态凭据共用注册合同且不泄漏。
func TestHandlerRegistersBuiltinStaticCredentialsWithoutEchoingSecret(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		providerID string
		kind       string
		secretKey  string
		baseURL    string
	}{
		{
			name:       "codex",
			providerID: "codex",
			kind:       "api_key",
			secretKey:  "api_key",
			baseURL:    "https://api.openai.com/v1",
		},
		{
			name:       "claude api key",
			providerID: "claude",
			kind:       "api_key",
			secretKey:  "api_key",
			baseURL:    "https://api.anthropic.com",
		},
		{
			name:       "claude auth token",
			providerID: "claude",
			kind:       "auth_token",
			secretKey:  "auth_token",
			baseURL:    "https://api.anthropic.com",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			handler := newTestHandler(t, service)
			secret := "synthetic-" + test.providerID + "-" + test.kind
			auth := map[string]any{
				"kind":     test.kind,
				"base_url": test.baseURL,
			}
			auth[test.secretKey] = secret
			payload := marshalRequestJSON(t, map[string]any{
				"provider_id": test.providerID,
				"auth":        auth,
			})
			response := performAuthorizedRequest(
				t,
				handler,
				http.MethodPost,
				"/v1/management/accounts",
				payload,
			)

			if response.Code != http.StatusCreated {
				t.Fatalf("POST account status = %d body=%s", response.Code, response.Body)
			}
			if service.registerCalls != 1 ||
				service.registeredCredential == nil ||
				service.registeredCredential.ProviderID() != test.providerID {
				t.Fatalf(
					"注册命令错误: calls=%d credential=%#v",
					service.registerCalls,
					service.registeredCredential,
				)
			}
			if strings.Contains(response.Body.String(), secret) {
				t.Fatal("账号注册响应泄漏静态凭据")
			}
			var document struct {
				Data struct {
					ProviderID string `json:"provider_id"`
					AuthKind   string `json:"auth_kind"`
				} `json:"data"`
			}
			decodeResponseJSON(t, response, &document)
			if document.Data.ProviderID != test.providerID ||
				document.Data.AuthKind != test.kind {
				t.Fatalf("账号注册响应错误: %#v", document.Data)
			}
		})
	}
}

// TestHandlerDoesNotTurnCommittedRegistrationIntoReadFailure 验证账号事务提交后
// 不再追加一次点查，否则瞬时读失败会把已成功创建的账号伪装成 500。
func TestHandlerDoesNotTurnCommittedRegistrationIntoReadFailure(t *testing.T) {
	t.Parallel()

	service := newAccountServiceStub(t)
	service.overviewErr = errors.New("synthetic post-commit read failure")
	handler := newTestHandler(t, service)
	response := performAuthorizedRequest(
		t,
		handler,
		http.MethodPost,
		accountsapi.CollectionPath,
		[]byte(`{"provider_id":"codex","auth":{`+
			`"kind":"api_key","api_key":"synthetic-committed-key"}}`),
	)

	if response.Code != http.StatusCreated || service.registerCalls != 1 {
		t.Fatalf(
			"账号创建 status=%d calls=%d body=%s",
			response.Code,
			service.registerCalls,
			response.Body.String(),
		)
	}
}

// TestHandlerRejectsUnsupportedStaticAccountCredentials 验证创建入口复用统一凭据边界且不会进入注册用例。
func TestHandlerRejectsUnsupportedStaticAccountCredentials(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		body string
		code string
	}{
		{
			name: "codex auth token",
			body: `{"provider_id":"codex","auth":{"kind":"auth_token",` +
				`"auth_token":"unsupported-codex-token"}}`,
			code: "unsupported_auth_kind",
		},
		{
			name: "claude mixed credential",
			body: `{"provider_id":"claude","auth":{"kind":"api_key",` +
				`"api_key":"synthetic-key","auth_token":"unexpected-token"}}`,
			code: "invalid_static_credential",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			handler := newTestHandler(t, service)
			response := performAuthorizedRequest(
				t,
				handler,
				http.MethodPost,
				accountsapi.CollectionPath,
				[]byte(test.body),
			)
			assertAPIError(
				t,
				response,
				http.StatusUnprocessableEntity,
				test.code,
			)
			if service.registerCalls != 0 {
				t.Fatalf("无效凭据进入注册用例: calls=%d", service.registerCalls)
			}
		})
	}
}

// TestHandlerRejectsInvalidHTTPInputs 验证 Transport 在进入应用层前拒绝不明确输入。
func TestHandlerRejectsInvalidHTTPInputs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		method      string
		path        string
		contentType string
		body        []byte
		status      int
		code        string
	}{
		{
			name:   "unknown query",
			method: http.MethodGet,
			path:   "/v1/management/accounts?offset=1",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "empty page size",
			method: http.MethodGet,
			path:   "/v1/management/accounts?limit=",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "malformed query",
			method: http.MethodGet,
			path:   "/v1/management/accounts?limit=1;offset=2",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "create query",
			method: http.MethodPost,
			path:   "/v1/management/accounts?dry_run=true",
			body:   []byte(`{}`),
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "member query",
			method: http.MethodGet,
			path:   "/v1/management/accounts/acct_a6624a747e4ccf287aa3?expand=auth",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "delete query",
			method: http.MethodDelete,
			path:   "/v1/management/accounts/acct_a6624a747e4ccf287aa3?force=true",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "delete body",
			method: http.MethodDelete,
			path:   "/v1/management/accounts/acct_a6624a747e4ccf287aa3",
			body:   []byte(`{}`),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:        "wrong media type",
			method:      http.MethodPost,
			path:        "/v1/management/accounts",
			contentType: "text/plain",
			body:        []byte(`{}`),
			status:      http.StatusUnsupportedMediaType,
			code:        "unsupported_media_type",
		},
		{
			name:   "unknown json field",
			method: http.MethodPatch,
			path:   "/v1/management/accounts/acct_a6624a747e4ccf287aa3",
			body:   []byte(`{"enabled":false,"status":"disabled"}`),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "trailing json",
			method: http.MethodPost,
			path:   "/v1/management/accounts",
			body:   []byte(`{} {}`),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "duplicated nested field",
			method: http.MethodPost,
			path:   "/v1/management/accounts",
			body: []byte(
				`{"provider_id":"codex","auth":{"kind":"api_key",` +
					`"api_key":"first","api_key":"second"}}`,
			),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "request too large",
			method: http.MethodPatch,
			path:   "/v1/management/accounts/acct_a6624a747e4ccf287aa3",
			body: []byte(
				`{"enabled":false,"padding":"` +
					strings.Repeat("x", 65*1024) +
					`"}`,
			),
			status: http.StatusRequestEntityTooLarge,
			code:   "request_too_large",
		},
		{
			name:   "unsupported provider",
			method: http.MethodPost,
			path:   "/v1/management/accounts",
			body: marshalRequestJSON(t, map[string]any{
				"provider_id": "gemini",
				"auth": map[string]any{
					"kind":    "api_key",
					"api_key": "synthetic-unsupported-key",
				},
			}),
			status: http.StatusUnprocessableEntity,
			code:   "unsupported_provider",
		},
		{
			name:   "invalid account ref",
			method: http.MethodGet,
			path:   "/v1/management/accounts/not-an-account",
			status: http.StatusBadRequest,
			code:   "invalid_account_ref",
		},
		{
			name:   "method not allowed",
			method: http.MethodPut,
			path:   "/v1/management/accounts/acct_a6624a747e4ccf287aa3",
			status: http.StatusMethodNotAllowed,
			code:   "method_not_allowed",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			handler := newTestHandler(t, service)
			request := httptest.NewRequest(test.method, test.path, bytes.NewReader(test.body))
			request.Header.Set("Authorization", "Bearer "+testManagementKey)
			if test.body != nil {
				contentType := test.contentType
				if contentType == "" {
					contentType = "application/json"
				}
				request.Header.Set("Content-Type", contentType)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			assertAPIError(t, response, test.status, test.code)
		})
	}
}

// TestHandlerMapsApplicationErrors 验证应用错误不会以内部文本泄漏到 HTTP。
func TestHandlerMapsApplicationErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{
			name:   "not found",
			err:    accountapp.ErrAccountNotFound,
			status: http.StatusNotFound,
			code:   "account_not_found",
		},
		{
			name:   "conflict",
			err:    accountapp.ErrAccountConflict,
			status: http.StatusConflict,
			code:   "account_conflict",
		},
		{
			name:   "runtime active",
			err:    accountapp.ErrAccountRuntimeActive,
			status: http.StatusConflict,
			code:   "account_runtime_active",
		},
		{
			name:   "runtime unverifiable",
			err:    accountapp.ErrAccountRuntimeUnverifiable,
			status: http.StatusServiceUnavailable,
			code:   "account_runtime_unverifiable",
		},
		{
			name:   "deletion projection unverifiable",
			err:    accountapp.ErrAccountDeletionPreparationFailed,
			status: http.StatusServiceUnavailable,
			code:   "account_deletion_preparation_failed",
		},
		{
			name:   "internal",
			err:    errors.New("database contains synthetic secret"),
			status: http.StatusInternalServerError,
			code:   "internal_error",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			service.overviewErr = test.err
			handler := newTestHandler(t, service)
			response := performAuthorizedRequest(
				t,
				handler,
				http.MethodGet,
				"/v1/management/accounts/acct_a6624a747e4ccf287aa3",
				nil,
			)
			assertAPIError(t, response, test.status, test.code)
			if strings.Contains(response.Body.String(), test.err.Error()) {
				t.Fatal("HTTP 错误响应泄漏应用错误文本")
			}
		})
	}
}

// accountServiceStub 是 HTTP 入站适配器使用的可观察应用服务替身。
type accountServiceStub struct {
	t                    *testing.T
	catalog              *providers.Catalog
	listResult           []accountapp.AccountOverview
	listErr              error
	listQuery            accountapp.OverviewQuery
	listCalls            int
	overview             *accountapp.AccountOverview
	overviewErr          error
	setEnabledRef        accountcore.AccountRef
	setEnabledValue      bool
	setEnabledCalls      int
	registerErr          error
	registeredCredential accountapp.Credential
	registeredProfile    accountapp.PublicProfile
	registerCalls        int
	modelResult          []accountapp.AccountModel
	modelErr             error
	listModelCalls       int
	setModelRef          accountcore.AccountRef
	setModelID           string
	setModelPolicy       accountapp.ModelManualPolicy
	setModelCalls        int
	refreshModelRef      accountcore.AccountRef
	refreshModelCalls    int
	usageResult          usageapp.ReadResult
	usageErr             error
	getUsageCalls        int
	refreshUsageCalls    int
	deleteRef            accountcore.AccountRef
	deleteErr            error
	deleteCalls          int
	defaultValue         accountcore.ProviderDefault
	defaultErr           error
	defaultProviderID    string
	defaultAccountRef    accountcore.AccountRef
	getDefaultCalls      int
	setDefaultCalls      int
	clearDefaultCalls    int
	selectionResult      accountapp.LaunchSelection
	selectionErr         error
	selectionRequest     accountapp.LaunchSelectionRequest
	selectionCalls       int
	rotationRef          accountcore.AccountRef
	rotationCredential   accountapp.Credential
	rotationErr          error
	rotationCalls        int
	exportDocument       []byte
	exportRef            accountcore.AccountRef
	exportErr            error
	exportCalls          int
}

// accountExporterStub 记录独立外部格式导出端口的调用。
type accountExporterStub struct {
	document   []byte
	accountRef accountcore.AccountRef
	err        error
	calls      int
}

// ExportAccount 返回预设文档并记录目标账号。
func (exporter *accountExporterStub) ExportAccount(
	_ context.Context,
	accountRef accountcore.AccountRef,
) ([]byte, error) {
	exporter.calls++
	exporter.accountRef = accountRef
	return exporter.document, exporter.err
}

// newAccountServiceStub 创建使用内置 Provider Catalog 的应用服务替身。
func newAccountServiceStub(t *testing.T) *accountServiceStub {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return &accountServiceStub{t: t, catalog: catalog}
}

// ListAccountOverviews 记录列表查询并返回预设投影。
func (service *accountServiceStub) ListAccountOverviews(
	_ context.Context,
	query accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
	service.listCalls++
	service.listQuery = query
	return service.listResult, service.listErr
}

// GetAccountOverview 返回预设投影或最近注册的账号投影。
func (service *accountServiceStub) GetAccountOverview(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountapp.AccountOverview, error) {
	if service.overviewErr != nil {
		return accountapp.AccountOverview{}, service.overviewErr
	}
	if service.overview == nil {
		return accountapp.AccountOverview{}, accountapp.ErrAccountNotFound
	}
	return *service.overview, nil
}

// GetAccountOverviewByCLIAccountID 按预设账号严格匹配 Provider 数字别名。
func (service *accountServiceStub) GetAccountOverviewByCLIAccountID(
	_ context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (accountapp.AccountOverview, error) {
	if service.overviewErr != nil {
		return accountapp.AccountOverview{}, service.overviewErr
	}
	if service.overview == nil ||
		service.overview.Account().ProviderID() != providerID ||
		service.overview.Account().CLIAccountID() != cliAccountID {
		return accountapp.AccountOverview{}, accountapp.ErrAccountNotFound
	}
	return *service.overview, nil
}

// SetAccountEnabled 记录启停命令并更新预设公开投影。
func (service *accountServiceStub) SetAccountEnabled(
	_ context.Context,
	accountRef accountcore.AccountRef,
	enabled bool,
) (accountcore.Account, error) {
	service.setEnabledCalls++
	service.setEnabledRef = accountRef
	service.setEnabledValue = enabled
	if service.overview == nil {
		return accountcore.Account{}, accountapp.ErrAccountNotFound
	}
	account, err := service.overview.Account().WithEnabled(
		enabled,
		service.overview.Account().UpdatedAt().Add(time.Minute),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	updated := cloneOverviewWithAccount(service.t, *service.overview, account)
	service.overview = &updated
	return account, nil
}

// Register 记录 Provider 凭据并生成供注册响应点查的公开投影。
func (service *accountServiceStub) Register(
	_ context.Context,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	service.registerCalls++
	service.registeredCredential = credential
	service.registeredProfile = profile
	if service.registerErr != nil {
		return accountcore.Account{}, service.registerErr
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		service.t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(service.catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    testHTTPTime(),
	})
	if err != nil {
		service.t.Fatalf("NewAccount() error = %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          account,
		HasCredential:    true,
		AuthKind:         credentialKind(credential),
		AuthMode:         credentialMode(credential),
		HasProfile:       profile != nil,
		DisplayName:      profileDisplayName(profile),
		Email:            profileEmail(profile),
		SubscriptionKind: profileSubscriptionKind(profile),
		SubscriptionRaw:  profileSubscriptionRaw(profile),
		ProfileUpdatedAt: profileUpdatedAt(profile),
	})
	if err != nil {
		service.t.Fatalf("NewAccountOverview() error = %v", err)
	}
	service.overview = &overview
	return account, nil
}

// ListAccountModels 返回预设的账号模型管理快照。
func (service *accountServiceStub) ListAccountModels(
	_ context.Context,
	_ accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	service.listModelCalls++
	return service.modelResult, service.modelErr
}

// SetManualModelPolicy 记录人工策略命令并返回预设快照。
func (service *accountServiceStub) SetManualModelPolicy(
	_ context.Context,
	accountRef accountcore.AccountRef,
	modelID string,
	policy accountapp.ModelManualPolicy,
) ([]accountapp.AccountModel, error) {
	service.setModelCalls++
	service.setModelRef = accountRef
	service.setModelID = modelID
	service.setModelPolicy = policy
	if len(service.modelResult) == 1 &&
		service.modelResult[0].ModelID().String() == modelID {
		model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
			AccountRef:        accountRef,
			ModelID:           modelID,
			UpstreamAvailable: service.modelResult[0].UpstreamAvailable(),
			ManualPolicy:      policy,
			UpdatedAt:         testHTTPTime().Add(time.Minute),
		})
		if err != nil {
			service.t.Fatalf("NewAccountModel(update) error = %v", err)
		}
		service.modelResult = []accountapp.AccountModel{model}
	}
	return service.modelResult, service.modelErr
}

// RefreshAccountModels 记录显式刷新命令并返回预设快照。
func (service *accountServiceStub) RefreshAccountModels(
	_ context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	service.refreshModelCalls++
	service.refreshModelRef = accountRef
	return service.modelResult, service.modelErr
}

// GetUsage 返回预设的离线额度结果。
func (service *accountServiceStub) GetUsage(
	_ context.Context,
	_ accountcore.AccountRef,
) (usageapp.ReadResult, error) {
	service.getUsageCalls++
	return service.usageResult, service.usageErr
}

// RefreshUsage 返回预设的显式刷新结果。
func (service *accountServiceStub) RefreshUsage(
	_ context.Context,
	_ accountcore.AccountRef,
) (usageapp.ReadResult, error) {
	service.refreshUsageCalls++
	return service.usageResult, service.usageErr
}

// DeleteAccount 记录账号删除命令并返回预设结果。
func (service *accountServiceStub) DeleteAccount(
	_ context.Context,
	accountRef accountcore.AccountRef,
) error {
	service.deleteCalls++
	service.deleteRef = accountRef
	return service.deleteErr
}

// Get 返回预设的 Provider 默认启动账号。
func (service *accountServiceStub) Get(
	_ context.Context,
	providerID string,
) (accountcore.ProviderDefault, error) {
	service.getDefaultCalls++
	service.defaultProviderID = providerID
	return service.defaultValue, service.defaultErr
}

// Set 记录并返回 Provider 默认启动账号。
func (service *accountServiceStub) Set(
	_ context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (accountcore.ProviderDefault, error) {
	service.setDefaultCalls++
	service.defaultProviderID = providerID
	service.defaultAccountRef = accountRef
	if service.defaultErr != nil {
		return accountcore.ProviderDefault{}, service.defaultErr
	}
	providerDefault, err := accountcore.NewProviderDefault(
		providerID,
		accountRef,
		testHTTPTime(),
	)
	if err != nil {
		return accountcore.ProviderDefault{}, err
	}
	service.defaultValue = providerDefault
	return providerDefault, nil
}

// Clear 记录并清除 Provider 默认启动账号。
func (service *accountServiceStub) Clear(
	_ context.Context,
	providerID string,
) error {
	service.clearDefaultCalls++
	service.defaultProviderID = providerID
	if service.defaultErr == nil {
		service.defaultValue = accountcore.ProviderDefault{}
	}
	return service.defaultErr
}

// Resolve 记录启动账号解析命令并返回预设非敏感结果。
func (service *accountServiceStub) Resolve(
	_ context.Context,
	request accountapp.LaunchSelectionRequest,
) (accountapp.LaunchSelection, error) {
	service.selectionCalls++
	service.selectionRequest = request
	return service.selectionResult, service.selectionErr
}

// Rotate 记录静态凭据轮换并保持测试账号引用和数字别名不变。
func (service *accountServiceStub) Rotate(
	_ context.Context,
	accountRef accountcore.AccountRef,
	replacement accountapp.Credential,
) (accountcore.Account, error) {
	service.rotationCalls++
	service.rotationRef = accountRef
	service.rotationCredential = replacement
	if service.rotationErr != nil {
		return accountcore.Account{}, service.rotationErr
	}
	if service.overview == nil || service.overview.Account().Ref() != accountRef {
		return accountcore.Account{}, accountapp.ErrAccountNotFound
	}
	current := service.overview.Account()
	updated, err := accountcore.RestoreAccount(service.catalog, accountcore.RestoreAccountInput{
		Ref:          current.Ref(),
		ProviderID:   current.ProviderID(),
		CLIAccountID: current.CLIAccountID(),
		Enabled:      current.Enabled(),
		CreatedAt:    current.CreatedAt(),
		UpdatedAt:    current.UpdatedAt().Add(time.Minute),
	})
	if err != nil {
		return accountcore.Account{}, err
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       updated,
		HasCredential: true,
		AuthKind:      credentialKind(replacement),
	})
	if err != nil {
		return accountcore.Account{}, err
	}
	service.overview = &overview
	return updated, nil
}

// ExportAccount 记录单账号导出并返回预设 JSON 文档。
func (service *accountServiceStub) ExportAccount(
	_ context.Context,
	accountRef accountcore.AccountRef,
) ([]byte, error) {
	service.exportCalls++
	service.exportRef = accountRef
	return service.exportDocument, service.exportErr
}

// credentialKind 返回测试凭据对应的公开认证类型。
func credentialKind(credential accountapp.Credential) string {
	switch credential.(type) {
	case *codex.OAuthAuth, *claude.OAuthAuth:
		return "oauth"
	case *codex.APIKeyAuth, *claude.APIKeyAuth:
		return "api_key"
	case *claude.AuthTokenAuth:
		return "auth_token"
	default:
		return ""
	}
}

// credentialMode 返回只有 Claude 可刷新 OAuth 使用的公开模式。
func credentialMode(credential accountapp.Credential) string {
	if _, valid := credential.(*claude.OAuthAuth); valid {
		return "refreshable"
	}
	return ""
}

// profileDisplayName 安全读取可选公开资料展示名。
func profileDisplayName(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	return profile.DisplayName()
}

// profileEmail 安全读取可选公开资料邮箱。
func profileEmail(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	return profile.Email()
}

// profileSubscriptionKind 安全读取可选公开资料订阅分类。
func profileSubscriptionKind(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	return profile.SubscriptionKind()
}

// profileSubscriptionRaw 安全读取可选公开资料订阅原值。
func profileSubscriptionRaw(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	return profile.SubscriptionRaw()
}

// profileUpdatedAt 为携带公开资料的测试注册生成稳定采集时间。
func profileUpdatedAt(profile accountapp.PublicProfile) time.Time {
	if profile == nil {
		return time.Time{}
	}
	return testHTTPTime()
}

// newTestHandler 创建使用真实 Bearer 校验与内置凭据工厂的 HTTP Handler。
func newTestHandler(t *testing.T, service *accountServiceStub) http.Handler {
	return newTestHandlerWithCLIProxyAPIExporter(t, service, service)
}

// newTestHandlerWithCLIProxyAPIExporter 允许测试观察两个导出格式的依赖隔离。
func newTestHandlerWithCLIProxyAPIExporter(
	t *testing.T,
	service *accountServiceStub,
	cliProxyAPIExporter accountsapi.AccountExporter,
) http.Handler {
	t.Helper()

	authorizer, err := accountsapi.NewBearerAuthorizer(
		func() string { return testManagementKey },
	)
	if err != nil {
		t.Fatalf("NewBearerAuthorizer() error = %v", err)
	}
	credentialFactory := accountsapi.NewBuiltinStaticCredentialFactory()
	handler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:          service,
		Models:              service,
		Usage:               service,
		Deletion:            service,
		Defaults:            service,
		Selections:          service,
		CredentialRotation:  service,
		Sub2APIExporter:     service,
		CLIProxyAPIExporter: cliProxyAPIExporter,
		Registrar:           service,
		Importer:            newAccountServiceImporter(t, service),
		StaticCredentials:   credentialFactory,
		NativeAccounts:      nativeaccount.NewDecoder(),
		Sub2APIAccounts:     sub2api.NewDecoder(),
		Authorizer:          authorizer,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// newHTTPAccountModel 创建账号模型 HTTP 测试使用的完整领域关系。
func newHTTPAccountModel(
	t *testing.T,
	accountRef accountcore.AccountRef,
	modelID string,
	upstream bool,
	policy accountapp.ModelManualPolicy,
) accountapp.AccountModel {
	t.Helper()

	model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accountRef,
		ModelID:           modelID,
		UpstreamAvailable: upstream,
		ManualPolicy:      policy,
		UpdatedAt:         testHTTPTime(),
	})
	if err != nil {
		t.Fatalf("NewAccountModel() error = %v", err)
	}
	return model
}

// assertAccountModelResponse 校验模型管理接口的公开关系字段。
func assertAccountModelResponse(
	t *testing.T,
	response *httptest.ResponseRecorder,
	modelID string,
	policy string,
	effective bool,
) {
	t.Helper()

	if response.Code != http.StatusOK {
		t.Fatalf("model response status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		Data []struct {
			ModelID      string `json:"model_id"`
			ManualPolicy string `json:"manual_policy"`
			Effective    bool   `json:"effective"`
		} `json:"data"`
	}
	decodeResponseJSON(t, response, &document)
	if len(document.Data) != 1 ||
		document.Data[0].ModelID != modelID ||
		document.Data[0].ManualPolicy != policy ||
		document.Data[0].Effective != effective {
		t.Fatalf("model response = %#v", document.Data)
	}
}

// newTestOverview 创建不含敏感字段的 Codex API Key 管理投影。
func newTestOverview(
	t *testing.T,
	catalog *providers.Catalog,
	aliasValue int64,
	secret string,
) accountapp.AccountOverview {
	t.Helper()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: secret})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(aliasValue)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    testHTTPTime(),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
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

// cloneOverviewWithAccount 保留公开字段并替换基础账号快照。
func cloneOverviewWithAccount(
	t *testing.T,
	current accountapp.AccountOverview,
	account accountcore.Account,
) accountapp.AccountOverview {
	t.Helper()
	usageSnapshot, hasUsageSnapshot := current.UsageSnapshot()

	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          account,
		HasCredential:    current.HasCredential(),
		AuthKind:         current.AuthKind(),
		AuthMode:         current.AuthMode(),
		HasProfile:       current.HasProfile(),
		DisplayName:      current.DisplayName(),
		Email:            current.Email(),
		SubscriptionKind: current.SubscriptionKind(),
		SubscriptionRaw:  current.SubscriptionRaw(),
		ProfileUpdatedAt: current.ProfileUpdatedAt(),
		ModelSummary:     current.ModelSummary(),
		HasUsageSnapshot: hasUsageSnapshot,
		UsageSnapshot:    usageSnapshot,
	})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	return overview
}

// performAuthorizedRequest 执行携带测试 Management Key 的 JSON 请求。
func performAuthorizedRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	body []byte,
) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+testManagementKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// assertAPIError 校验统一 HTTP 错误 envelope。
func assertAPIError(
	t *testing.T,
	response *httptest.ResponseRecorder,
	status int,
	code string,
) {
	t.Helper()

	if response.Code != status {
		t.Fatalf("status = %d, want %d body=%s", response.Code, status, response.Body)
	}
	var document struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeResponseJSON(t, response, &document)
	if document.Error.Code != code {
		t.Fatalf("error code = %q, want %q", document.Error.Code, code)
	}
	assertSafeResponseHeaders(t, response)
}

// assertResponseEnabled 校验详情响应的启停状态。
func assertResponseEnabled(
	t *testing.T,
	response *httptest.ResponseRecorder,
	expected bool,
) {
	t.Helper()

	var document struct {
		Data struct {
			Enabled bool `json:"enabled"`
		} `json:"data"`
	}
	decodeResponseJSON(t, response, &document)
	if document.Data.Enabled != expected {
		t.Fatalf("enabled = %t, want %t", document.Data.Enabled, expected)
	}
}

// assertSafeResponseHeaders 校验管理响应禁止缓存并使用 JSON。
func assertSafeResponseHeaders(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()

	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	if response.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", response.Header().Get("Content-Type"))
	}
}

// decodeResponseJSON 解码并校验测试响应只有一个 JSON 文档。
func decodeResponseJSON(
	t *testing.T,
	response *httptest.ResponseRecorder,
	target any,
) {
	t.Helper()

	decoder := json.NewDecoder(response.Body)
	if err := decoder.Decode(target); err != nil {
		t.Fatalf("decode response error = %v body=%s", err, response.Body)
	}
}

// marshalRequestJSON 为测试请求生成 JSON payload。
func marshalRequestJSON(t *testing.T, value any) []byte {
	t.Helper()

	document, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return document
}

// testHTTPTime 返回账号 HTTP 测试共享的稳定业务时间。
func testHTTPTime() time.Time {
	return time.Date(2026, time.July, 27, 18, 0, 0, 0, time.UTC)
}
