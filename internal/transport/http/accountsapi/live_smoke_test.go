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
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestAccountsAPILiveSmoke 通过真实 TCP Listener 验证 HTTP 到临时 aih.db 的完整链路。
func TestAccountsAPILiveSmoke(t *testing.T) {
	t.Parallel()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: t.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	registeredAt := time.Date(2026, time.July, 27, 19, 0, 0, 0, time.UTC)
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
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
	authorizer, err := accountsapi.NewBearerAuthorizer(
		func() string { return testManagementKey },
	)
	if err != nil {
		t.Fatalf("NewBearerAuthorizer() error = %v", err)
	}
	handler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management: management,
		Registrar:  registrar,
		APIKeys:    accountsapi.NewBuiltinAPIKeyCredentialFactory(),
		Authorizer: authorizer,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

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
	}
	if codexRef == "" {
		t.Fatal("live account list missing Codex")
	}

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

	for _, exchange := range []liveExchange{
		codexCreate,
		claudeCreate,
		list,
		detail,
		disabled,
	} {
		if strings.Contains(exchange.requestBody, codexSecret) ||
			strings.Contains(exchange.requestBody, claudeSecret) ||
			strings.Contains(exchange.responseBody, codexSecret) ||
			strings.Contains(exchange.responseBody, claudeSecret) {
			t.Fatalf("%s smoke evidence leaked API Key", exchange.method)
		}
	}
}

// liveExchange 保存真实 HTTP smoke 的请求和响应证据。
type liveExchange struct {
	method       string
	url          string
	requestBody  string
	status       int
	responseBody string
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
		method:       method,
		url:          url,
		requestBody:  redactAPIKeyFromJSON(body),
		status:       response.StatusCode,
		responseBody: strings.TrimSpace(string(responseBody)),
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
	}
	var redacted bytes.Buffer
	encoder := json.NewEncoder(&redacted)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(document); err != nil {
		return "(json omitted)"
	}
	return strings.TrimSpace(redacted.String())
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
