package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestRunServesAccountsAndShutsDownCleanly 验证命令装配、真实监听和信号关闭链路。
func TestRunServesAccountsAndShutsDownCleanly(t *testing.T) {
	t.Parallel()

	aiHomeDir := t.TempDir()
	managementKey := "synthetic-run-management-key-2026"
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	listening := make(chan net.Addr, 1)
	runtime := newConfigTestRuntime(
		map[string]string{
			"AIH_HOME":                  aiHomeDir,
			"AIH_SERVER_MANAGEMENT_KEY": managementKey,
		},
		t.TempDir(),
	)
	runtime.stdout = &stdout
	runtime.stderr = &stderr
	runtime.models = accountmodels.NewDiscoverers()
	runtime.listen = func(
		ctx context.Context,
		network string,
		_ string,
	) (net.Listener, error) {
		var listenConfig net.ListenConfig
		listener, err := listenConfig.Listen(ctx, network, "127.0.0.1:0")
		if err == nil {
			listening <- listener.Addr()
		}
		return listener, err
	}

	runContext, cancel := context.WithCancel(context.Background())
	runErrors := make(chan error, 1)
	go func() {
		runErrors <- run(
			runContext,
			[]string{"--host", "127.0.0.1", "--port", "0"},
			runtime,
		)
	}()
	t.Cleanup(cancel)

	var address net.Addr
	select {
	case address = <-listening:
	case <-time.After(3 * time.Second):
		t.Fatal("aih-server 未开始监听")
	}
	baseURL := "http://" + address.String()
	client := &http.Client{Timeout: 3 * time.Second}

	secret := "synthetic-command-codex-api-key"
	payload := []byte(
		`{"provider_id":"codex","auth":{"kind":"api_key",` +
			`"api_key":"` + secret + `"}}`,
	)
	created := commandRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.CollectionPath,
		managementKey,
		payload,
	)
	if created.status != http.StatusCreated ||
		strings.Contains(created.body, secret) {
		t.Fatalf("创建响应错误: %#v", created)
	}

	listed := commandRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.CollectionPath+"?limit=10",
		managementKey,
		nil,
	)
	if listed.status != http.StatusOK {
		t.Fatalf("列表响应错误: %#v", listed)
	}
	var listDocument struct {
		Data []struct {
			ProviderID string `json:"provider_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(listed.body), &listDocument); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(listDocument.Data) != 1 ||
		listDocument.Data[0].ProviderID != "codex" {
		t.Fatalf("账号列表错误: %#v", listDocument.Data)
	}

	cancel()
	select {
	case err := <-runErrors:
		if err != nil {
			t.Fatalf("run() error = %v stderr=%s", err, stderr.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("aih-server 未在取消后退出")
	}
	if strings.Contains(stdout.String(), managementKey) ||
		strings.Contains(stderr.String(), managementKey) ||
		strings.Contains(stdout.String(), secret) ||
		strings.Contains(stderr.String(), secret) {
		t.Fatal("命令输出泄漏凭据")
	}
	if _, err := os.Stat(filepath.Join(aiHomeDir, "aih.db")); err != nil {
		t.Fatalf("aih.db 未创建: %v", err)
	}
}

// commandExchange 保存命令 smoke 的响应事实。
type commandExchange struct {
	status int
	body   string
}

// commandRequest 调用命令启动的真实 HTTP Listener。
func commandRequest(
	t *testing.T,
	client *http.Client,
	method string,
	url string,
	managementKey string,
	body []byte,
) commandExchange {
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
	request.Header.Set("Authorization", "Bearer "+managementKey)
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
	return commandExchange{
		status: response.StatusCode,
		body:   strings.TrimSpace(string(responseBody)),
	}
}
