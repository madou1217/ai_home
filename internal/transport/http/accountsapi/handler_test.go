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
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
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
	assertSafeResponseHeaders(t, response)
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

// TestHandlerRegistersBuiltinAPIKeysWithoutEchoingSecret 验证 Codex、Claude 共用注册合同且不泄漏密钥。
func TestHandlerRegistersBuiltinAPIKeysWithoutEchoingSecret(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		providerID string
		baseURL    string
	}{
		{
			name:       "codex",
			providerID: "codex",
			baseURL:    "https://api.openai.com/v1",
		},
		{
			name:       "claude",
			providerID: "claude",
			baseURL:    "https://api.anthropic.com",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			handler := newTestHandler(t, service)
			secret := "synthetic-" + test.providerID + "-http-api-key"
			payload := marshalRequestJSON(t, map[string]any{
				"provider_id": test.providerID,
				"auth": map[string]any{
					"kind":     "api_key",
					"api_key":  secret,
					"base_url": test.baseURL,
				},
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
				t.Fatal("账号注册响应泄漏 API Key")
			}
			var document struct {
				Data struct {
					ProviderID string `json:"provider_id"`
					AuthKind   string `json:"auth_kind"`
				} `json:"data"`
			}
			decodeResponseJSON(t, response, &document)
			if document.Data.ProviderID != test.providerID ||
				document.Data.AuthKind != "api_key" {
				t.Fatalf("账号注册响应错误: %#v", document.Data)
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
			method: http.MethodDelete,
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

// credentialKind 返回测试凭据对应的公开认证类型。
func credentialKind(credential accountapp.Credential) string {
	switch credential.(type) {
	case *codex.OAuthAuth, *claude.OAuthAuth:
		return "oauth"
	case *codex.APIKeyAuth, *claude.APIKeyAuth:
		return "api_key"
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
	t.Helper()

	authorizer, err := accountsapi.NewBearerAuthorizer(
		func() string { return testManagementKey },
	)
	if err != nil {
		t.Fatalf("NewBearerAuthorizer() error = %v", err)
	}
	handler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:     service,
		Models:         service,
		Registrar:      service,
		APIKeys:        accountsapi.NewBuiltinAPIKeyCredentialFactory(),
		NativeAccounts: nativeaccount.NewDecoder(),
		Authorizer:     authorizer,
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
