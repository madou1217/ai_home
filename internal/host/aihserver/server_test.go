package aihserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/clauderelayleaseapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

const testManagementKey = "synthetic-go-server-management-key-2026"
const testClientKey = "synthetic-go-server-client-key-2026"

// TestServerMountsSystemAndAccountRoutes 验证 Host 到 aih.db 的真实 TCP 完整链路。
func TestServerMountsSystemAndAccountRoutes(t *testing.T) {
	t.Parallel()

	baseURL, client := startTestServer(t)

	health := performRequest(t, client, http.MethodGet, baseURL+"/healthz", "", nil)
	assertStatus(t, health, http.StatusOK)
	assertJSONField(t, health.body, "service", "aih-server")

	ready := performRequest(t, client, http.MethodGet, baseURL+"/readyz", "", nil)
	assertStatus(t, ready, http.StatusOK)
	var readiness struct {
		Ready        bool     `json:"ready"`
		Capabilities []string `json:"capabilities"`
	}
	decodeJSON(t, ready.body, &readiness)
	if !readiness.Ready ||
		len(readiness.Capabilities) != 6 ||
		readiness.Capabilities[0] != "account_management_v1" ||
		readiness.Capabilities[1] != "account_auth_jobs_v1" ||
		readiness.Capabilities[2] != "local_model_catalog_v1" ||
		readiness.Capabilities[3] != "canonical_inference_v1" ||
		readiness.Capabilities[4] != "claude_relay_leases_v1" ||
		readiness.Capabilities[5] != "claude_native_relay_v1" {
		t.Fatalf("readyz response = %#v", readiness)
	}

	unauthorized := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.CollectionPath,
		"",
		nil,
	)
	assertStatus(t, unauthorized, http.StatusUnauthorized)

	startedOAuth := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountauthapi.CollectionPath,
		testManagementKey,
		[]byte(`{"provider_id":"codex"}`),
	)
	assertStatus(t, startedOAuth, http.StatusCreated)
	var startedOAuthDocument struct {
		Data struct {
			JobID            string `json:"job_id"`
			ProviderID       string `json:"provider_id"`
			Status           string `json:"status"`
			AuthorizationURL string `json:"authorization_url"`
		} `json:"data"`
	}
	decodeJSON(t, startedOAuth.body, &startedOAuthDocument)
	if len(startedOAuthDocument.Data.JobID) != 32 ||
		startedOAuthDocument.Data.ProviderID != "codex" ||
		startedOAuthDocument.Data.Status != "pending" ||
		!strings.HasPrefix(
			startedOAuthDocument.Data.AuthorizationURL,
			"https://auth.openai.com/oauth/authorize?",
		) {
		t.Fatalf("OAuth Job 创建响应错误: %#v", startedOAuthDocument.Data)
	}
	cancelledOAuth := performRequest(
		t,
		client,
		http.MethodDelete,
		baseURL+accountauthapi.CollectionPath+"/"+startedOAuthDocument.Data.JobID,
		testManagementKey,
		nil,
	)
	assertStatus(t, cancelledOAuth, http.StatusOK)
	if strings.Contains(cancelledOAuth.body, "authorization_url") ||
		strings.Contains(cancelledOAuth.body, "state") {
		t.Fatal("OAuth Job 终态响应泄漏授权 URL 或 state")
	}

	secret := "synthetic-mounted-codex-api-key"
	createBody := []byte(
		`{"provider_id":"codex","auth":{"kind":"api_key",` +
			`"api_key":"` + secret + `"}}`,
	)
	created := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.CollectionPath,
		testManagementKey,
		createBody,
	)
	assertStatus(t, created, http.StatusCreated)
	if strings.Contains(created.body, secret) {
		t.Fatal("Go Server 创建响应泄漏 API Key")
	}
	unauthorizedModels := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+modelsapi.Path,
		testManagementKey,
		nil,
	)
	assertStatus(t, unauthorizedModels, http.StatusUnauthorized)
	models := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+modelsapi.Path,
		testClientKey,
		nil,
	)
	assertStatus(t, models, http.StatusOK)
	if !strings.Contains(models.body, `"id":"gpt-5.6-sol"`) {
		t.Fatalf("本地模型目录缺少已注册账号模型: %s", models.body)
	}
	t.Logf(
		"GET %s\npayload:\n(none)\nstatus: %d\nresponse:\n%s",
		baseURL+modelsapi.Path,
		models.status,
		models.body,
	)

	nativeAccessToken := "sk-ant-oat01-mounted-native-access"
	nativeRefreshToken := "sk-ant-ort01-mounted-native-refresh"
	nativePayload := claudeNativeImportBody(
		t,
		nativeAccessToken,
		nativeRefreshToken,
	)
	nativeCreated := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.NativeImportPath,
		testManagementKey,
		nativePayload,
	)
	assertStatus(t, nativeCreated, http.StatusCreated)
	if strings.Contains(nativeCreated.body, nativeAccessToken) ||
		strings.Contains(nativeCreated.body, nativeRefreshToken) {
		t.Fatal("Go Server 原生导入响应泄漏 OAuth Token")
	}
	var nativeDocument struct {
		Data struct {
			AccountRef       string `json:"account_ref"`
			ProviderID       string `json:"provider_id"`
			CLIAccountID     int64  `json:"cli_account_id"`
			AuthKind         string `json:"auth_kind"`
			AuthMode         string `json:"auth_mode"`
			HasProfile       bool   `json:"has_profile"`
			Email            string `json:"email"`
			SubscriptionKind string `json:"subscription_kind"`
		} `json:"data"`
	}
	decodeJSON(t, nativeCreated.body, &nativeDocument)
	if nativeDocument.Data.ProviderID != "claude" ||
		nativeDocument.Data.AccountRef == "" ||
		nativeDocument.Data.CLIAccountID != 1 ||
		nativeDocument.Data.AuthKind != "oauth" ||
		nativeDocument.Data.AuthMode != "refreshable" ||
		!nativeDocument.Data.HasProfile ||
		nativeDocument.Data.Email != "mounted-native@example.invalid" ||
		nativeDocument.Data.SubscriptionKind != "pro" {
		t.Fatalf("Go Server 原生导入响应错误: %#v", nativeDocument.Data)
	}
	leasePayload := []byte(
		`{"account_ref":"` + nativeDocument.Data.AccountRef + `"}`,
	)
	issuedLease := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+clauderelayleaseapi.Path,
		testManagementKey,
		leasePayload,
	)
	assertStatus(t, issuedLease, http.StatusCreated)
	var leaseDocument struct {
		Data struct {
			Token      string `json:"token"`
			AccountRef string `json:"account_ref"`
			ExpiresAt  string `json:"expires_at"`
		} `json:"data"`
	}
	decodeJSON(t, issuedLease.body, &leaseDocument)
	if leaseDocument.Data.Token == "" ||
		leaseDocument.Data.AccountRef != nativeDocument.Data.AccountRef ||
		leaseDocument.Data.ExpiresAt == "" ||
		strings.Contains(issuedLease.body, nativeAccessToken) ||
		strings.Contains(issuedLease.body, nativeRefreshToken) {
		t.Fatalf("Go Server Relay 租约响应错误: %#v", leaseDocument.Data)
	}
	unauthorizedRelay := performRequestWithHeaders(
		t,
		client,
		http.MethodPost,
		baseURL+claudenativerelay.Path,
		map[string]string{
			claudenativerelay.RelayTokenHeader: "invalid-relay-token-2026",
		},
		[]byte(`{"model":"claude-opus-5"}`),
	)
	assertStatus(t, unauthorizedRelay, http.StatusUnauthorized)
	assertJSONErrorCode(t, unauthorizedRelay.body, "unauthorized")
	duplicateNative := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.NativeImportPath,
		testManagementKey,
		nativePayload,
	)
	assertStatus(t, duplicateNative, http.StatusConflict)
	assertJSONErrorCode(t, duplicateNative.body, "account_conflict")
	if strings.Contains(duplicateNative.body, nativeAccessToken) ||
		strings.Contains(duplicateNative.body, nativeRefreshToken) {
		t.Fatal("重复导入错误响应泄漏 OAuth Token")
	}

	listed := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.CollectionPath+"?limit=10",
		testManagementKey,
		nil,
	)
	assertStatus(t, listed, http.StatusOK)
	var listDocument struct {
		Data []struct {
			ProviderID   string `json:"provider_id"`
			CLIAccountID int64  `json:"cli_account_id"`
		} `json:"data"`
	}
	decodeJSON(t, listed.body, &listDocument)
	if len(listDocument.Data) != 2 {
		t.Fatalf("账号列表响应错误: %#v", listDocument.Data)
	}
	providersFound := make(map[string]int64, len(listDocument.Data))
	for _, account := range listDocument.Data {
		providersFound[account.ProviderID] = account.CLIAccountID
	}
	if providersFound["codex"] != 1 || providersFound["claude"] != 1 {
		t.Fatalf("账号 Provider 别名错误: %#v", providersFound)
	}

	unknown := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+"/unknown",
		"",
		nil,
	)
	assertStatus(t, unknown, http.StatusNotFound)
	assertJSONErrorCode(t, unknown.body, "route_not_found")

	wrongMethod := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+"/healthz",
		"",
		[]byte(`{}`),
	)
	assertStatus(t, wrongMethod, http.StatusMethodNotAllowed)
	if wrongMethod.header.Get("Allow") != "GET, HEAD" {
		t.Fatalf("healthz Allow = %q", wrongMethod.header.Get("Allow"))
	}
}

// claudeNativeImportBody 创建 Host 完整链路使用的 Claude 官方 artifact。
func claudeNativeImportBody(
	t *testing.T,
	accessToken string,
	refreshToken string,
) []byte {
	t.Helper()

	document, err := json.Marshal(map[string]any{
		"provider_id": "claude",
		"artifacts": map[string]any{
			"credentials_json": map[string]any{
				"claudeAiOauth": map[string]any{
					"accessToken":      accessToken,
					"refreshToken":     refreshToken,
					"expiresAt":        int64(4_102_444_800_000),
					"scopes":           []string{"user:inference"},
					"subscriptionType": "pro",
					"rateLimitTier":    nil,
				},
			},
			"global_config_json": map[string]any{
				"oauthAccount": map[string]any{
					"accountUuid":  "123e4567-e89b-12d3-a456-426614174333",
					"emailAddress": "mounted-native@example.invalid",
					"displayName":  "Mounted Native",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return document
}

// TestNewRejectsInvalidServerKeysBeforeCreatingDatabase 验证错误或重叠密钥不会产生数据库副作用。
func TestNewRejectsInvalidServerKeysBeforeCreatingDatabase(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		managementKey string
		clientKey     string
		wantErr       error
	}{
		{
			name:          "weak management",
			managementKey: "too-short",
			clientKey:     testClientKey,
			wantErr:       aihserver.ErrInvalidManagementKey,
		},
		{
			name:          "weak client",
			managementKey: testManagementKey,
			clientKey:     "too-short",
			wantErr:       aihserver.ErrInvalidClientKey,
		},
		{
			name:          "same key",
			managementKey: testManagementKey,
			clientKey:     testManagementKey,
			wantErr:       aihserver.ErrServerKeyCollision,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			aiHomeDir := t.TempDir()
			_, err := aihserver.New(context.Background(), aihserver.Options{
				AIHomeDir: aiHomeDir,
				ManagementKey: func() string {
					return test.managementKey
				},
				ClientKey: func() string {
					return test.clientKey
				},
			})
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("aihserver.New() error = %v, want %v", err, test.wantErr)
			}
			databasePath, pathErr := sqliteaccount.DatabasePath(aiHomeDir)
			if pathErr != nil {
				t.Fatalf("DatabasePath() error = %v", pathErr)
			}
			if _, statErr := os.Stat(databasePath); !os.IsNotExist(statErr) {
				t.Fatalf("无效配置创建了数据库: stat error=%v", statErr)
			}
		})
	}
}

// httpExchange 保存测试需要的响应事实。
type httpExchange struct {
	status int
	header http.Header
	body   string
}

// startTestServer 创建真实 Listener，并注册有界关闭清理。
func startTestServer(t *testing.T) (string, *http.Client) {
	t.Helper()

	return startTestServerWithInferenceClient(t, nil)
}

// startTestServerWithInferenceClient 创建可注入合成上游的真实 Listener。
func startTestServerWithInferenceClient(
	t *testing.T,
	inferenceClient aihserver.InferenceHTTPClient,
) (string, *http.Client) {
	t.Helper()

	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:           t.TempDir(),
		ManagementKey:       func() string { return testManagementKey },
		ClientKey:           func() string { return testClientKey },
		ModelDiscoverers:    accountmodels.NewDiscoverers(),
		InferenceHTTPClient: inferenceClient,
	})
	if err != nil {
		t.Fatalf("aihserver.New() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		t.Fatalf("net.Listen() error = %v", err)
	}
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("Server.Shutdown() error = %v", err)
		}
		if err := <-serveErrors; err != nil {
			t.Errorf("Server.Serve() error = %v", err)
		}
		if err := server.Close(); err != nil {
			t.Errorf("Server.Close() error = %v", err)
		}
	})
	return "http://" + listener.Addr().String(), &http.Client{
		Timeout: 3 * time.Second,
	}
}

// performRequest 执行真实 TCP 请求并读取完整响应。
func performRequest(
	t *testing.T,
	client *http.Client,
	method string,
	url string,
	managementKey string,
	body []byte,
) httpExchange {
	t.Helper()

	headers := make(map[string]string)
	if managementKey != "" {
		headers["Authorization"] = "Bearer " + managementKey
	}
	return performRequestWithHeaders(t, client, method, url, headers, body)
}

// performRequestWithHeaders 执行需要显式区分客户端权限域的真实 TCP 请求。
func performRequestWithHeaders(
	t *testing.T,
	client *http.Client,
	method string,
	url string,
	headers map[string]string,
	body []byte,
) httpExchange {
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
	for name, value := range headers {
		request.Header.Set(name, value)
	}
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
	return httpExchange{
		status: response.StatusCode,
		header: response.Header.Clone(),
		body:   strings.TrimSpace(string(responseBody)),
	}
}

// assertStatus 校验 HTTP 状态和通用安全响应头。
func assertStatus(t *testing.T, exchange httpExchange, expected int) {
	t.Helper()

	if exchange.status != expected {
		t.Fatalf(
			"status=%d want=%d body=%s",
			exchange.status,
			expected,
			exchange.body,
		)
	}
	if exchange.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", exchange.header.Get("Cache-Control"))
	}
}

// assertJSONField 校验系统响应中的字符串字段。
func assertJSONField(t *testing.T, body string, field string, expected string) {
	t.Helper()

	var document map[string]any
	decodeJSON(t, body, &document)
	if document[field] != expected {
		t.Fatalf("%s = %#v, want %q", field, document[field], expected)
	}
}

// assertJSONErrorCode 校验统一错误 envelope。
func assertJSONErrorCode(t *testing.T, body string, expected string) {
	t.Helper()

	var document struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeJSON(t, body, &document)
	if document.Error.Code != expected {
		t.Fatalf("error code = %q, want %q", document.Error.Code, expected)
	}
}

// decodeJSON 解码测试响应。
func decodeJSON(t *testing.T, body string, target any) {
	t.Helper()

	if err := json.Unmarshal([]byte(body), target); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, body)
	}
}
