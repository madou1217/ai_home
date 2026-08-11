package accountsapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/cliproxyapi"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestAccountsAPILiveSmoke 通过真实 TCP Listener 验证 HTTP 到临时 aih.db 的完整链路。
func TestAccountsAPILiveSmoke(t *testing.T) {
	t.Parallel()

	registeredAt := time.Date(2026, time.July, 27, 19, 0, 0, 0, time.UTC)
	server := newAccountsLiveServer(t, registeredAt)

	codexSecret := "synthetic-codex-live-http-key"
	codexPayload := marshalRequestJSON(t, map[string]any{
		"provider_id": "codex",
		"auth": map[string]any{
			"kind":     "api_key",
			"api_key":  codexSecret,
			"base_url": "https://api.openai.com/v1",
		},
	})
	codexCreate := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.CollectionPath,
		codexPayload,
	)
	logLiveExchange(t, codexCreate)
	assertLiveStatus(t, codexCreate, http.StatusCreated)

	claudeSecret := "synthetic-claude-live-http-key"
	claudePayload := marshalRequestJSON(t, map[string]any{
		"provider_id": "claude",
		"auth": map[string]any{
			"kind":     "api_key",
			"api_key":  claudeSecret,
			"base_url": "https://api.anthropic.com",
		},
	})
	claudeCreate := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.CollectionPath,
		claudePayload,
	)
	logLiveExchange(t, claudeCreate)
	assertLiveStatus(t, claudeCreate, http.StatusCreated)

	list := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"?limit=50",
		nil,
	)
	logLiveExchange(t, list)
	assertLiveStatus(t, list, http.StatusOK)
	var listDocument struct {
		Data []struct {
			AccountRef   string `json:"account_ref"`
			ProviderID   string `json:"provider_id"`
			CLIAccountID int64  `json:"cli_account_id"`
		} `json:"data"`
	}
	decodeLiveBody(t, list.responseBody, &listDocument)
	if len(listDocument.Data) != 2 {
		t.Fatalf("live account count = %d, want 2", len(listDocument.Data))
	}
	codexRef := ""
	claudeRef := ""
	for _, account := range listDocument.Data {
		if account.CLIAccountID != 1 {
			t.Fatalf(
				"Provider %s alias = %d, want 1",
				account.ProviderID,
				account.CLIAccountID,
			)
		}
		if account.ProviderID == "codex" {
			codexRef = account.AccountRef
		}
		if account.ProviderID == "claude" {
			claudeRef = account.AccountRef
		}
	}
	if codexRef == "" || claudeRef == "" {
		t.Fatal("live account list missing Codex or Claude")
	}
	codexDefaultURL := server.URL + accountsapi.DefaultsPath + "/codex"
	codexDefaultPayload := marshalRequestJSON(t, map[string]string{
		"account_ref": codexRef,
	})
	codexDefault := performLiveRequest(
		t,
		server.Client(),
		http.MethodPut,
		codexDefaultURL,
		codexDefaultPayload,
	)
	logLiveExchange(t, codexDefault)
	assertLiveStatus(t, codexDefault, http.StatusOK)
	assertLiveProviderDefault(
		t,
		codexDefault,
		"codex",
		codexRef,
		"2026-07-27T19:25:00Z",
	)
	codexDefaultRead := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		codexDefaultURL,
		nil,
	)
	logLiveExchange(t, codexDefaultRead)
	assertLiveStatus(t, codexDefaultRead, http.StatusOK)
	if codexDefaultRead.responseBody != codexDefault.responseBody {
		t.Fatalf(
			"默认账号写读不一致: put=%s get=%s",
			codexDefault.responseBody,
			codexDefaultRead.responseBody,
		)
	}
	claudeDefaultURL := server.URL + accountsapi.DefaultsPath + "/claude"
	claudeDefault := performLiveRequest(
		t,
		server.Client(),
		http.MethodPut,
		claudeDefaultURL,
		marshalRequestJSON(t, map[string]string{"account_ref": claudeRef}),
	)
	logLiveExchange(t, claudeDefault)
	assertLiveStatus(t, claudeDefault, http.StatusOK)
	assertLiveProviderDefault(
		t,
		claudeDefault,
		"claude",
		claudeRef,
		"2026-07-27T19:25:00Z",
	)
	selectionURL := server.URL + accountsapi.SelectionPath
	explicitRefSelection := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		selectionURL,
		marshalRequestJSON(t, map[string]any{
			"provider_id": "codex",
			"account_ref": codexRef,
		}),
	)
	logLiveExchange(t, explicitRefSelection)
	assertLiveStatus(t, explicitRefSelection, http.StatusOK)
	assertLiveLaunchSelection(
		t,
		explicitRefSelection,
		"codex",
		codexRef,
		1,
		"account_ref",
	)
	explicitAliasSelection := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		selectionURL,
		marshalRequestJSON(t, map[string]any{
			"provider_id":    "claude",
			"cli_account_id": 1,
		}),
	)
	logLiveExchange(t, explicitAliasSelection)
	assertLiveStatus(t, explicitAliasSelection, http.StatusOK)
	assertLiveLaunchSelection(
		t,
		explicitAliasSelection,
		"claude",
		claudeRef,
		1,
		"cli_account_id",
	)
	defaultSelection := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		selectionURL,
		marshalRequestJSON(t, map[string]string{"provider_id": "codex"}),
	)
	logLiveExchange(t, defaultSelection)
	assertLiveStatus(t, defaultSelection, http.StatusOK)
	assertLiveLaunchSelection(
		t,
		defaultSelection,
		"codex",
		codexRef,
		1,
		"provider_default",
	)

	detailURL := server.URL + accountsapi.CollectionPath + "/" + codexRef
	detail := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		detailURL,
		nil,
	)
	logLiveExchange(t, detail)
	assertLiveStatus(t, detail, http.StatusOK)

	exported := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		detailURL+"/export",
		nil,
	)
	if exported.status != http.StatusOK {
		t.Fatalf("GET export status=%d", exported.status)
	}
	if exported.responseHeaders.Get("Content-Disposition") !=
		`attachment; filename="sub2api-data.json"` ||
		exported.responseHeaders.Get("Cache-Control") != "no-store" {
		t.Fatalf("GET export headers=%#v", exported.responseHeaders)
	}
	assertLiveAccountExport(
		t,
		exported.responseBody,
		"openai",
		codexSecret,
		"https://api.openai.com/v1",
	)
	redactedExport := exported
	redactedExport.responseBody = redactSub2ApiExport(exported.responseBody)
	logLiveExchange(t, redactedExport)

	claudeExported := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"/"+claudeRef+"/export",
		nil,
	)
	assertLiveStatus(t, claudeExported, http.StatusOK)
	assertLiveAccountExport(
		t,
		claudeExported.responseBody,
		"anthropic",
		claudeSecret,
		"https://api.anthropic.com",
	)
	redactedClaudeExport := claudeExported
	redactedClaudeExport.responseBody = redactSub2ApiExport(
		claudeExported.responseBody,
	)
	logLiveExchange(t, redactedClaudeExport)

	targetServer := newAccountsLiveServer(t, registeredAt.Add(24*time.Hour))
	importedCodex := importLiveSub2APIAccount(
		t,
		targetServer,
		exported,
		"openai",
		codexSecret,
		"https://api.openai.com/v1",
	)
	importedClaude := importLiveSub2APIAccount(
		t,
		targetServer,
		claudeExported,
		"anthropic",
		claudeSecret,
		"https://api.anthropic.com",
	)
	targetList := performLiveRequest(
		t,
		targetServer.Client(),
		http.MethodGet,
		targetServer.URL+accountsapi.CollectionPath+"?limit=50",
		nil,
	)
	logLiveExchange(t, targetList)
	assertLiveStatus(t, targetList, http.StatusOK)
	var targetListDocument struct {
		Data []any `json:"data"`
	}
	decodeLiveBody(t, targetList.responseBody, &targetListDocument)
	if len(targetListDocument.Data) != 2 {
		t.Fatalf(
			"sub2api round-trip target account count=%d, want 2",
			len(targetListDocument.Data),
		)
	}
	claudeAuthToken := "synthetic-claude-live-auth-token"
	claudeRotationPayload := marshalRequestJSON(t, map[string]any{
		"auth": map[string]any{
			"kind":       "auth_token",
			"auth_token": claudeAuthToken,
			"base_url":   "https://api.anthropic.com",
		},
	})
	claudeRotated := performLiveRequest(
		t,
		server.Client(),
		http.MethodPut,
		server.URL+accountsapi.CollectionPath+"/"+claudeRef+"/credential",
		claudeRotationPayload,
	)
	logLiveExchange(t, claudeRotated)
	assertLiveStatus(t, claudeRotated, http.StatusOK)
	var claudeRotatedDocument struct {
		Data struct {
			AccountRef   string `json:"account_ref"`
			CLIAccountID int64  `json:"cli_account_id"`
			AuthKind     string `json:"auth_kind"`
		} `json:"data"`
	}
	decodeLiveBody(t, claudeRotated.responseBody, &claudeRotatedDocument)
	if claudeRotatedDocument.Data.AccountRef != claudeRef ||
		claudeRotatedDocument.Data.CLIAccountID != 1 ||
		claudeRotatedDocument.Data.AuthKind != "auth_token" {
		t.Fatalf("live Claude rotation response = %#v", claudeRotatedDocument.Data)
	}
	claudeDefaultAfterRotation := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		claudeDefaultURL,
		nil,
	)
	logLiveExchange(t, claudeDefaultAfterRotation)
	assertLiveStatus(t, claudeDefaultAfterRotation, http.StatusOK)
	if claudeDefaultAfterRotation.responseBody != claudeDefault.responseBody {
		t.Fatalf(
			"静态凭据轮换改变默认账号: before=%s after=%s",
			claudeDefault.responseBody,
			claudeDefaultAfterRotation.responseBody,
		)
	}

	modelsURL := detailURL + "/models"
	models := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		modelsURL,
		nil,
	)
	logLiveExchange(t, models)
	assertLiveStatus(t, models, http.StatusOK)
	assertLiveModelPolicy(t, models, "gpt-5.6-sol", "inherit", true)

	modelPolicyPayload := []byte(
		`{"model_id":"gpt-5.6-sol","manual_policy":"force_disable"}`,
	)
	modelPolicy := performLiveRequest(
		t,
		server.Client(),
		http.MethodPatch,
		modelsURL,
		modelPolicyPayload,
	)
	logLiveExchange(t, modelPolicy)
	assertLiveStatus(t, modelPolicy, http.StatusOK)
	assertLiveModelPolicy(
		t,
		modelPolicy,
		"gpt-5.6-sol",
		"force_disable",
		false,
	)

	modelRefresh := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		modelsURL+"/refresh",
		nil,
	)
	logLiveExchange(t, modelRefresh)
	assertLiveStatus(t, modelRefresh, http.StatusOK)
	assertLiveModelPolicy(
		t,
		modelRefresh,
		"gpt-5.6-sol",
		"force_disable",
		false,
	)

	disablePayload := []byte(`{"enabled":false}`)
	disabled := performLiveRequest(
		t,
		server.Client(),
		http.MethodPatch,
		detailURL,
		disablePayload,
	)
	logLiveExchange(t, disabled)
	assertLiveStatus(t, disabled, http.StatusOK)
	var disabledDocument struct {
		Data struct {
			Enabled   bool   `json:"enabled"`
			UpdatedAt string `json:"updated_at"`
		} `json:"data"`
	}
	decodeLiveBody(t, disabled.responseBody, &disabledDocument)
	if disabledDocument.Data.Enabled ||
		disabledDocument.Data.UpdatedAt != "2026-07-27T19:05:00Z" {
		t.Fatalf("live disable response = %#v", disabledDocument.Data)
	}
	codexDefaultAfterDisable := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		codexDefaultURL,
		nil,
	)
	logLiveExchange(t, codexDefaultAfterDisable)
	assertLiveStatus(t, codexDefaultAfterDisable, http.StatusNotFound)
	if !strings.Contains(
		codexDefaultAfterDisable.responseBody,
		`"code":"default_account_not_found"`,
	) {
		t.Fatalf("停用后默认账号响应错误: %s", codexDefaultAfterDisable.responseBody)
	}
	disabledSelection := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		selectionURL,
		marshalRequestJSON(t, map[string]string{
			"provider_id": "codex",
			"account_ref": codexRef,
		}),
	)
	logLiveExchange(t, disabledSelection)
	assertLiveStatus(t, disabledSelection, http.StatusConflict)
	if !strings.Contains(
		disabledSelection.responseBody,
		`"code":"account_selection_disabled"`,
	) {
		t.Fatalf("停用账号选择响应错误: %s", disabledSelection.responseBody)
	}

	rotatedSecret := "synthetic-codex-live-rotated-key"
	rotationPayload := marshalRequestJSON(t, map[string]any{
		"auth": map[string]any{
			"kind":     "api_key",
			"api_key":  rotatedSecret,
			"base_url": "https://api.openai.com/v1",
		},
	})
	rotated := performLiveRequest(
		t,
		server.Client(),
		http.MethodPut,
		detailURL+"/credential",
		rotationPayload,
	)
	logLiveExchange(t, rotated)
	assertLiveStatus(t, rotated, http.StatusOK)
	var rotatedDocument struct {
		Data struct {
			AccountRef   string `json:"account_ref"`
			CLIAccountID int64  `json:"cli_account_id"`
			Enabled      bool   `json:"enabled"`
			UpdatedAt    string `json:"updated_at"`
		} `json:"data"`
	}
	decodeLiveBody(t, rotated.responseBody, &rotatedDocument)
	if rotatedDocument.Data.AccountRef != codexRef ||
		rotatedDocument.Data.CLIAccountID != 1 ||
		rotatedDocument.Data.Enabled ||
		rotatedDocument.Data.UpdatedAt != "2026-07-27T19:20:00Z" {
		t.Fatalf("live rotation response = %#v", rotatedDocument.Data)
	}
	rotatedModels := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		modelsURL,
		nil,
	)
	logLiveExchange(t, rotatedModels)
	assertLiveStatus(t, rotatedModels, http.StatusOK)
	assertLiveModelPolicy(
		t,
		rotatedModels,
		"gpt-5.6-sol",
		"force_disable",
		false,
	)
	rotatedExport := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		detailURL+"/export",
		nil,
	)
	assertLiveStatus(t, rotatedExport, http.StatusOK)
	assertLiveAccountExport(
		t,
		rotatedExport.responseBody,
		"openai",
		rotatedSecret,
		"https://api.openai.com/v1",
	)
	redactedRotatedExport := rotatedExport
	redactedRotatedExport.responseBody = redactSub2ApiExport(
		rotatedExport.responseBody,
	)
	logLiveExchange(t, redactedRotatedExport)

	deleted := performLiveRequest(
		t,
		server.Client(),
		http.MethodDelete,
		detailURL,
		nil,
	)
	logLiveExchange(t, deleted)
	assertLiveStatus(t, deleted, http.StatusNoContent)
	if deleted.responseBody != "" {
		t.Fatalf("live DELETE body = %q", deleted.responseBody)
	}
	deletedDetail := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		detailURL,
		nil,
	)
	logLiveExchange(t, deletedDetail)
	assertLiveStatus(t, deletedDetail, http.StatusNotFound)

	for _, exchange := range []liveExchange{
		codexCreate,
		claudeCreate,
		list,
		codexDefault,
		codexDefaultRead,
		claudeDefault,
		explicitRefSelection,
		explicitAliasSelection,
		defaultSelection,
		detail,
		models,
		modelPolicy,
		modelRefresh,
		claudeRotated,
		claudeDefaultAfterRotation,
		rotated,
		rotatedModels,
		redactedRotatedExport,
		importedCodex,
		importedClaude,
		targetList,
		disabled,
		codexDefaultAfterDisable,
		disabledSelection,
		deleted,
		deletedDetail,
	} {
		if strings.Contains(exchange.requestBody, codexSecret) ||
			strings.Contains(exchange.requestBody, claudeSecret) ||
			strings.Contains(exchange.requestBody, rotatedSecret) ||
			strings.Contains(exchange.requestBody, claudeAuthToken) ||
			strings.Contains(exchange.responseBody, codexSecret) ||
			strings.Contains(exchange.responseBody, claudeSecret) ||
			strings.Contains(exchange.responseBody, rotatedSecret) ||
			strings.Contains(exchange.responseBody, claudeAuthToken) {
			t.Fatalf("%s smoke evidence leaked API Key", exchange.method)
		}
	}
}

// assertLiveProviderDefault 校验真实 HTTP 默认账号响应的三字段最小合同。
func assertLiveProviderDefault(
	t *testing.T,
	exchange liveExchange,
	providerID string,
	accountRef string,
	updatedAt string,
) {
	t.Helper()

	var document struct {
		Data struct {
			ProviderID string `json:"provider_id"`
			AccountRef string `json:"account_ref"`
			UpdatedAt  string `json:"updated_at"`
		} `json:"data"`
	}
	decodeLiveBody(t, exchange.responseBody, &document)
	if document.Data.ProviderID != providerID ||
		document.Data.AccountRef != accountRef ||
		document.Data.UpdatedAt != updatedAt {
		t.Fatalf("live provider default response = %#v", document.Data)
	}
}

// assertLiveLaunchSelection 校验真实 HTTP 启动选择只返回非敏感账号身份和来源。
func assertLiveLaunchSelection(
	t *testing.T,
	exchange liveExchange,
	providerID string,
	accountRef string,
	cliAccountID int64,
	source string,
) {
	t.Helper()

	var document struct {
		Data struct {
			ProviderID   string `json:"provider_id"`
			AccountRef   string `json:"account_ref"`
			CLIAccountID int64  `json:"cli_account_id"`
			Source       string `json:"selection_source"`
		} `json:"data"`
	}
	decodeLiveBody(t, exchange.responseBody, &document)
	if document.Data.ProviderID != providerID ||
		document.Data.AccountRef != accountRef ||
		document.Data.CLIAccountID != cliAccountID ||
		document.Data.Source != source {
		t.Fatalf("live launch selection response = %#v", document.Data)
	}
}

// newAccountsLiveServer 创建使用真实 TCP、临时 SQLite 和离线模型目录的账号服务。
func newAccountsLiveServer(
	t *testing.T,
	registeredAt time.Time,
) *httptest.Server {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(
		context.Background(),
		sqliteaccount.OpenOptions{
			AIHomeDir: t.TempDir(),
			Catalog:   catalog,
		},
	)
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	modelDiscovery, err := accountmodels.NewDiscovery(catalog)
	if err != nil {
		t.Fatalf("accountmodels.NewDiscovery() error = %v", err)
	}
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
		modelDiscovery,
		func() time.Time { return registeredAt },
	)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	management, err := accountapp.NewManagement(
		store,
		store,
		func() time.Time { return registeredAt.Add(5 * time.Minute) },
	)
	if err != nil {
		t.Fatalf("NewManagement() error = %v", err)
	}
	providerDefaults, err := accountapp.NewProviderDefaults(
		catalog,
		store,
		func() time.Time { return registeredAt.Add(25 * time.Minute) },
	)
	if err != nil {
		t.Fatalf("NewProviderDefaults() error = %v", err)
	}
	launchAccountSelector, err := accountapp.NewLaunchAccountSelector(catalog, store)
	if err != nil {
		t.Fatalf("NewLaunchAccountSelector() error = %v", err)
	}
	exportReader, err := accountapp.NewExportReader(store, store, store)
	if err != nil {
		t.Fatalf("NewExportReader() error = %v", err)
	}
	exporter, err := sub2api.NewExporter(
		exportReader,
		func() time.Time { return registeredAt.Add(15 * time.Minute) },
	)
	if err != nil {
		t.Fatalf("sub2api.NewExporter() error = %v", err)
	}
	cliProxyAPIExporter, err := cliproxyapi.NewExporter(exportReader)
	if err != nil {
		t.Fatalf("cliproxyapi.NewExporter() error = %v", err)
	}
	deleter, err := accountapp.NewDeleter(store, liveDeletionCleanup{})
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}
	modelManagement, err := accountapp.NewModelManagement(
		store,
		store,
		modelDiscovery,
		func() time.Time { return registeredAt.Add(10 * time.Minute) },
	)
	if err != nil {
		t.Fatalf("NewModelManagement() error = %v", err)
	}
	credentialRotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		store,
		modelDiscovery,
		func() time.Time { return registeredAt.Add(20 * time.Minute) },
		liveDeletionCleanup{},
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotator() error = %v", err)
	}
	authorizer, err := accountsapi.NewBearerAuthorizer(
		func() string { return testManagementKey },
	)
	if err != nil {
		t.Fatalf("NewBearerAuthorizer() error = %v", err)
	}
	credentialFactory := accountsapi.NewBuiltinAPIKeyCredentialFactory()
	handler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:          management,
		Models:              modelManagement,
		Usage:               newAccountServiceStub(t),
		Deletion:            deleter,
		Defaults:            providerDefaults,
		Selections:          launchAccountSelector,
		CredentialRotation:  credentialRotator,
		Sub2APIExporter:     exporter,
		CLIProxyAPIExporter: cliProxyAPIExporter,
		Registrar:           registrar,
		APIKeys:             credentialFactory,
		StaticCredentials:   credentialFactory,
		NativeAccounts:      nativeaccount.NewDecoder(),
		Sub2APIAccounts:     sub2api.NewDecoder(),
		Authorizer:          authorizer,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

// importLiveSub2APIAccount 验证标准导出进入另一 SQLite 后仍能再次完整导出。
func importLiveSub2APIAccount(
	t *testing.T,
	target *httptest.Server,
	sourceExport liveExchange,
	expectedPlatform string,
	expectedSecret string,
	expectedBaseURL string,
) liveExchange {
	t.Helper()

	imported := performLiveRequest(
		t,
		target.Client(),
		http.MethodPost,
		target.URL+accountsapi.Sub2APIImportPath,
		[]byte(sourceExport.responseBody),
	)
	assertLiveStatus(t, imported, http.StatusCreated)
	if strings.Contains(imported.responseBody, expectedSecret) {
		t.Fatal("sub2api 导入响应泄漏凭据")
	}
	var importedDocument struct {
		Data struct {
			AccountRef string `json:"account_ref"`
			ProviderID string `json:"provider_id"`
		} `json:"data"`
	}
	decodeLiveBody(t, imported.responseBody, &importedDocument)
	if importedDocument.Data.AccountRef == "" ||
		importedDocument.Data.ProviderID == "" {
		t.Fatalf("sub2api 导入响应缺少账号身份: %#v", importedDocument.Data)
	}
	reexported := performLiveRequest(
		t,
		target.Client(),
		http.MethodGet,
		target.URL+accountsapi.CollectionPath+"/"+
			importedDocument.Data.AccountRef+"/export",
		nil,
	)
	assertLiveStatus(t, reexported, http.StatusOK)
	assertLiveAccountExport(
		t,
		reexported.responseBody,
		expectedPlatform,
		expectedSecret,
		expectedBaseURL,
	)

	safeImported := imported
	safeImported.requestBody = redactSub2ApiExport(imported.requestBody)
	logLiveExchange(t, safeImported)
	safeReexported := reexported
	safeReexported.responseBody = redactSub2ApiExport(reexported.responseBody)
	logLiveExchange(t, safeReexported)
	return safeImported
}

// liveDeletionCleanup 是真实 TCP smoke 使用的无状态幂等清理端口。
type liveDeletionCleanup struct{}

// ForgetAccount 在 smoke 中不保存任何派生运行态。
func (liveDeletionCleanup) ForgetAccount(accountcore.AccountRef) {}

// assertLiveModelPolicy 校验真实 HTTP 模型关系和人工覆盖结果。
func assertLiveModelPolicy(
	t *testing.T,
	exchange liveExchange,
	modelID string,
	policy string,
	effective bool,
) {
	t.Helper()

	var document struct {
		Data []struct {
			ModelID      string `json:"model_id"`
			ManualPolicy string `json:"manual_policy"`
			Effective    bool   `json:"effective"`
		} `json:"data"`
	}
	decodeLiveBody(t, exchange.responseBody, &document)
	if len(document.Data) != 1 ||
		document.Data[0].ModelID != modelID ||
		document.Data[0].ManualPolicy != policy ||
		document.Data[0].Effective != effective {
		t.Fatalf("live model response = %#v", document.Data)
	}
}

// liveExchange 保存真实 HTTP smoke 的请求和响应证据。
type liveExchange struct {
	method          string
	url             string
	requestBody     string
	status          int
	responseHeaders http.Header
	responseBody    string
}

// performLiveRequest 使用真实 HTTP Client 调用本地 Listener。
func performLiveRequest(
	t *testing.T,
	client *http.Client,
	method string,
	url string,
	body []byte,
) liveExchange {
	t.Helper()

	request, err := http.NewRequestWithContext(
		context.Background(),
		method,
		url,
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext() error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+testManagementKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s error = %v", method, url, err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("io.ReadAll() error = %v", err)
	}
	return liveExchange{
		method:          method,
		url:             url,
		requestBody:     redactAPIKeyFromJSON(body),
		status:          response.StatusCode,
		responseHeaders: response.Header.Clone(),
		responseBody:    strings.TrimSpace(string(responseBody)),
	}
}

// redactAPIKeyFromJSON 隐藏 smoke 日志中的合成 API Key，同时保留可复核 payload。
func redactAPIKeyFromJSON(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		return "(invalid json omitted)"
	}
	auth, found := document["auth"].(map[string]any)
	if found {
		if _, containsAPIKey := auth["api_key"]; containsAPIKey {
			auth["api_key"] = "<redacted>"
		}
		if _, containsAuthToken := auth["auth_token"]; containsAuthToken {
			auth["auth_token"] = "<redacted>"
		}
	}
	var redacted bytes.Buffer
	encoder := json.NewEncoder(&redacted)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(document); err != nil {
		return "(json omitted)"
	}
	return strings.TrimSpace(redacted.String())
}

// redactSub2ApiExport 隐藏标准导出响应中的全部凭据值。
func redactSub2ApiExport(body string) string {
	var document struct {
		Type       string `json:"type"`
		Version    int    `json:"version"`
		ExportedAt string `json:"exported_at"`
		Proxies    []any  `json:"proxies"`
		Accounts   []struct {
			Name        string `json:"name"`
			Platform    string `json:"platform"`
			Type        string `json:"type"`
			Concurrency int    `json:"concurrency"`
			Priority    int    `json:"priority"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal([]byte(body), &document); err != nil {
		return "(export json omitted)"
	}
	safe := map[string]any{
		"type":        document.Type,
		"version":     document.Version,
		"exported_at": document.ExportedAt,
		"proxies":     document.Proxies,
		"accounts":    make([]map[string]any, 0, len(document.Accounts)),
	}
	accounts := safe["accounts"].([]map[string]any)
	for _, account := range document.Accounts {
		accounts = append(accounts, map[string]any{
			"name":        account.Name,
			"platform":    account.Platform,
			"type":        account.Type,
			"credentials": "<redacted>",
			"concurrency": account.Concurrency,
			"priority":    account.Priority,
		})
	}
	safe["accounts"] = accounts
	encoded, err := json.Marshal(safe)
	if err != nil {
		return "(export json omitted)"
	}
	return string(encoded)
}

// assertLiveAccountExport 校验真实 TCP 导出包含标准版本、合成凭据且没有本地字段。
func assertLiveAccountExport(
	t *testing.T,
	body string,
	expectedPlatform string,
	expectedSecret string,
	expectedBaseURL string,
) {
	t.Helper()

	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &root); err != nil {
		t.Fatalf("export json.Unmarshal() error = %v", err)
	}
	var version int
	if err := json.Unmarshal(root["version"], &version); err != nil || version != 1 {
		t.Fatalf("真实导出 version=%d error=%v", version, err)
	}
	var accounts []struct {
		Name        string `json:"name"`
		Platform    string `json:"platform"`
		Type        string `json:"type"`
		Credentials struct {
			APIKey  string `json:"api_key"`
			BaseURL string `json:"base_url"`
		} `json:"credentials"`
	}
	if err := json.Unmarshal(root["accounts"], &accounts); err != nil {
		t.Fatalf("export accounts decode error = %v", err)
	}
	platform := ""
	credentialType := ""
	if len(accounts) > 0 {
		platform = accounts[0].Platform
		credentialType = accounts[0].Type
	}
	if len(accounts) != 1 ||
		accounts[0].Platform != expectedPlatform ||
		accounts[0].Type != "apikey" ||
		accounts[0].Credentials.APIKey != expectedSecret ||
		accounts[0].Credentials.BaseURL != expectedBaseURL {
		t.Fatalf(
			"真实导出合同错误: count=%d platform=%q type=%q",
			len(accounts),
			platform,
			credentialType,
		)
	}
	for _, forbidden := range []string{
		`"account_ref"`,
		`"cli_account_id"`,
		`"models"`,
		`"usage"`,
		`"runtime"`,
		`"cooldown"`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("真实导出包含禁止字段 %s", forbidden)
		}
	}
}

// logLiveExchange 输出用户可以直接核对的地址、payload 和 response。
func logLiveExchange(t *testing.T, exchange liveExchange) {
	t.Helper()

	t.Logf(
		"%s %s\npayload:\n%s\nstatus: %d\nresponse:\n%s",
		exchange.method,
		exchange.url,
		emptyJSONIfNeeded(exchange.requestBody),
		exchange.status,
		exchange.responseBody,
	)
}

// emptyJSONIfNeeded 让无请求体的 GET smoke 输出明确的空 payload。
func emptyJSONIfNeeded(value string) string {
	if value == "" {
		return "(none)"
	}
	return value
}

// assertLiveStatus 校验真实 HTTP 状态码。
func assertLiveStatus(t *testing.T, exchange liveExchange, expected int) {
	t.Helper()

	if exchange.status != expected {
		t.Fatalf(
			"%s %s status=%d want=%d response=%s",
			exchange.method,
			exchange.url,
			exchange.status,
			expected,
			exchange.responseBody,
		)
	}
}

// decodeLiveBody 解码真实 HTTP response JSON。
func decodeLiveBody(t *testing.T, body string, target any) {
	t.Helper()

	if err := json.Unmarshal([]byte(body), target); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, body)
	}
}
