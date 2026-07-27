package aihserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const testManagementKey = "synthetic-go-server-management-key-2026"

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
		len(readiness.Capabilities) != 1 ||
		readiness.Capabilities[0] != "account_management_v1" {
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
	if len(listDocument.Data) != 1 ||
		listDocument.Data[0].ProviderID != "codex" ||
		listDocument.Data[0].CLIAccountID != 1 {
		t.Fatalf("账号列表响应错误: %#v", listDocument.Data)
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

// TestNewRejectsInvalidManagementKeyBeforeCreatingDatabase 验证错误密钥不会产生数据库副作用。
func TestNewRejectsInvalidManagementKeyBeforeCreatingDatabase(t *testing.T) {
	t.Parallel()

	aiHomeDir := t.TempDir()
	_, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:     aiHomeDir,
		ManagementKey: func() string { return "too-short" },
	})
	if err == nil {
		t.Fatal("弱 Management Key 未被拒绝")
	}
	databasePath, pathErr := sqliteaccount.DatabasePath(aiHomeDir)
	if pathErr != nil {
		t.Fatalf("DatabasePath() error = %v", pathErr)
	}
	if _, statErr := os.Stat(databasePath); !os.IsNotExist(statErr) {
		t.Fatalf("无效配置创建了数据库: stat error=%v", statErr)
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

	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:     t.TempDir(),
		ManagementKey: func() string { return testManagementKey },
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

	request, err := http.NewRequestWithContext(
		context.Background(),
		method,
		url,
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext() error = %v", err)
	}
	if managementKey != "" {
		request.Header.Set("Authorization", "Bearer "+managementKey)
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
