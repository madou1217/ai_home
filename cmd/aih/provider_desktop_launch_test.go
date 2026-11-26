package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func desktopLaunchRuntime(t *testing.T, server *httptest.Server) (commandRuntime, *bytes.Buffer) {
	t.Helper()
	stdout := &bytes.Buffer{}
	return commandRuntime{
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
		stdout:        stdout,
		stderr:        &bytes.Buffer{},
		managementAPI: server.Client(),
	}, stdout
}

// 没有 CLI 的桌面端 Provider：aih workbuddy 1 应请求本机 Server 打开桌面端。
func TestDesktopOnlyProviderLaunchOpensDesktopApp(t *testing.T) {
	var openAction, openKind string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/management/accounts":
			_, _ = response.Write([]byte(`{"data":[{"account_ref":"acct_0123456789abcdef0123","provider_id":"workbuddy","cli_account_id":1,"enabled":true,"has_credential":false,"auth_kind":"","auth_mode":"","has_profile":false,"has_identity":false,"display_name":"","email":"","subscription_kind":"","subscription_raw":"","profile_updated_at":"","created_at":"2026-11-13T00:00:00Z","updated_at":"2026-11-13T00:00:00Z"}],"page":{"limit":200,"has_more":false}}`))
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/open-app"):
			var body map[string]string
			_ = json.NewDecoder(request.Body).Decode(&body)
			openAction, openKind = body["action"], body["kind"]
			_, _ = response.Write([]byte(`{"ok":true,"status":"launched"}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()

	runtime, stdout := desktopLaunchRuntime(t, server)
	if err := runDesktopOnlyProviderLaunch(context.Background(), "workbuddy", []string{"1"}, runtime); err != nil {
		t.Fatalf("launch: %v", err)
	}
	if openKind != "desktop" || openAction != "open" {
		t.Fatalf("应请求打开桌面端：kind=%q action=%q", openKind, openAction)
	}
	if !strings.Contains(stdout.String(), "已启动 workbuddy 桌面端") {
		t.Fatalf("缺少启动提示：%q", stdout.String())
	}
}

func TestDesktopOnlyProviderLaunchRejectsFlags(t *testing.T) {
	err := runDesktopOnlyProviderLaunch(context.Background(), "workbuddy", []string{"--model", "x"}, commandRuntime{})
	if err == nil {
		t.Fatal("应拒绝桌面端不支持的启动旗标")
	}
}

func TestIsDesktopAccountToken(t *testing.T) {
	for _, token := range []string{"1", "12", "acct_0123456789abcdef0123"} {
		if !isDesktopAccountToken(token) {
			t.Fatalf("%q 应识别为账号", token)
		}
	}
	for _, token := range []string{"", "models", "relay", "--model"} {
		if isDesktopAccountToken(token) {
			t.Fatalf("%q 不应识别为账号", token)
		}
	}
}
