package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// TestRunProviderRestartClosesThenOpens 走完整命令路径：解析账号 → close → open。
func TestRunProviderRestartClosesThenOpens(t *testing.T) {
	var mu sync.Mutex
	actions := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/management/accounts":
			_, _ = response.Write([]byte(`{"data":[{"account_ref":"acct_0123456789abcdef0123","provider_id":"codebuddycn","cli_account_id":2,"enabled":true,"has_credential":false,"auth_kind":"","auth_mode":"","has_profile":false,"display_name":"","email":"","subscription_kind":"","subscription_raw":"","profile_updated_at":"","created_at":"2026-11-13T00:00:00Z","updated_at":"2026-11-13T00:00:00Z"}],"page":{"limit":200,"has_more":false}}`))
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/open-app"):
			var body map[string]string
			_ = json.NewDecoder(request.Body).Decode(&body)
			mu.Lock()
			actions = append(actions, body["action"])
			mu.Unlock()
			if body["action"] == "close" {
				_, _ = response.Write([]byte(`{"ok":true,"status":"closed"}`))
				return
			}
			_, _ = response.Write([]byte(`{"ok":true,"status":"launched","launchMode":"desktop"}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	aiHome := t.TempDir()
	var stdout bytes.Buffer
	runtime := commandRuntime{
		lookupEnv: func(name string) (string, bool) {
			switch name {
			case "AIH_HOME_DIR":
				return aiHome, true
			case "AIH_SERVER_BASE_URL":
				return server.URL, true
			case "AIH_SERVER_MANAGEMENT_KEY":
				return "0123456789abcdef0123456789abcdef", true
			}
			return "", false
		},
		userHomeDir:   func() (string, error) { return t.TempDir(), nil },
		stdout:        &stdout,
		stderr:        &bytes.Buffer{},
		managementAPI: server.Client(),
	}
	if err := runProviderRestart(context.Background(), "codebuddycn", "2", runtime); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if !strings.Contains(stdout.String(), "Restarted local codebuddycn desktop client") {
		t.Fatalf("stdout = %q", stdout.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(actions) != 2 || actions[0] != "close" || actions[1] != "open" {
		t.Fatalf("actions = %v", actions)
	}
}

// TestRunProviderRestartRejectsInvalidID 零/负数在调用管理面之前就拒绝。
func TestRunProviderRestartRejectsInvalidID(t *testing.T) {
	runtime := commandRuntime{stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}}
	if err := runProviderRestart(context.Background(), "codebuddycn", "0", runtime); err == nil {
		t.Fatal("0 应该被拒绝")
	}
}
