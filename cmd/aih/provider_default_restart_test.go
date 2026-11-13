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

// TestSetDefaultWithRestart 设置默认账号后按旗标触发 close→open。
func TestSetDefaultWithRestart(t *testing.T) {
	var mu sync.Mutex
	actions := make([]string, 0, 3)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/management/accounts":
			_, _ = response.Write([]byte(`{"data":[{"account_ref":"acct_0123456789abcdef0123","provider_id":"codebuddycn","cli_account_id":2,"enabled":true,"has_credential":false,"auth_kind":"","auth_mode":"","has_profile":false,"display_name":"","email":"","subscription_kind":"","subscription_raw":"","profile_updated_at":"","created_at":"2026-11-13T00:00:00Z","updated_at":"2026-11-13T00:00:00Z"}],"page":{"limit":200,"has_more":false}}`))
		case request.Method == http.MethodPut && request.URL.Path == "/v1/management/account-defaults/codebuddycn":
			mu.Lock()
			actions = append(actions, "set-default")
			mu.Unlock()
			_, _ = response.Write([]byte(`{"data":{"provider_id":"codebuddycn","account_ref":"acct_0123456789abcdef0123","updated_at":"2026-11-13T00:00:00Z"}}`))
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/open-app"):
			var body map[string]string
			_ = json.NewDecoder(request.Body).Decode(&body)
			mu.Lock()
			actions = append(actions, body["action"])
			mu.Unlock()
			_, _ = response.Write([]byte(`{"ok":true,"status":"launched"}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	var stdout bytes.Buffer
	runtime := commandRuntime{
		lookupEnv: func(name string) (string, bool) {
			switch name {
			case "AIH_HOME_DIR":
				return t.TempDir(), true
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
	if err := runProviderDefaultCommand(
		context.Background(),
		"codebuddycn",
		[]string{"set-default", "2", "--restart-client"},
		runtime,
	); err != nil {
		t.Fatalf("set-default: %v", err)
	}
	if !strings.Contains(stdout.String(), "已设置 codebuddycn 默认账号") {
		t.Fatalf("stdout = %q", stdout.String())
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"set-default", "close", "open"}
	if len(actions) != len(want) {
		t.Fatalf("actions = %v", actions)
	}
	for index := range want {
		if actions[index] != want[index] {
			t.Fatalf("actions = %v", actions)
		}
	}
}
