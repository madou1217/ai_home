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

func TestStripDesktopFlag(t *testing.T) {
	result, want := stripDesktopFlag([]string{"1", "--desktop", "--", "--desktop"})
	if !want || len(result) != 3 || result[0] != "1" || result[1] != "--" || result[2] != "--desktop" {
		t.Fatalf("stripDesktopFlag 结果错误：want=%v result=%v", want, result)
	}
	result, want = stripDesktopFlag([]string{"--model", "x"})
	if want || len(result) != 2 {
		t.Fatalf("无 --desktop 时不应改写：want=%v result=%v", want, result)
	}
}

// 同账号重复启动：Server 返回 already_running 时不重复拉起。
func TestDesktopLaunchAlreadyRunning(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/management/accounts":
			_, _ = response.Write([]byte(`{"data":[{"account_ref":"acct_0123456789abcdef0123","provider_id":"codebuddy","cli_account_id":1,"enabled":true,"has_credential":false,"auth_kind":"","auth_mode":"","has_profile":false,"has_identity":false,"display_name":"","email":"","subscription_kind":"","subscription_raw":"","profile_updated_at":"","created_at":"2026-11-13T00:00:00Z","updated_at":"2026-11-13T00:00:00Z"}],"page":{"limit":200,"has_more":false}}`))
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/open-app"):
			_, _ = response.Write([]byte(`{"ok":true,"status":"already_running","pids":[4321]}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	runtime, stdout := desktopLaunchRuntime(t, server)
	if err := runDesktopOnlyProviderLaunch(context.Background(), "codebuddy", []string{"1"}, runtime); err != nil {
		t.Fatalf("launch: %v", err)
	}
	if !strings.Contains(stdout.String(), "已在运行") {
		t.Fatalf("应提示单例已在运行：%q", stdout.String())
	}
}

// 428 install_required：不当作异常退出，提示先安装桌面端。
func TestDesktopLaunchInstallRequired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/management/accounts":
			_, _ = response.Write([]byte(`{"data":[{"account_ref":"acct_0123456789abcdef0123","provider_id":"codebuddy","cli_account_id":1,"enabled":true,"has_credential":false,"auth_kind":"","auth_mode":"","has_profile":false,"has_identity":false,"display_name":"","email":"","subscription_kind":"","subscription_raw":"","profile_updated_at":"","created_at":"2026-11-13T00:00:00Z","updated_at":"2026-11-13T00:00:00Z"}],"page":{"limit":200,"has_more":false}}`))
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/open-app"):
			response.WriteHeader(http.StatusPreconditionRequired)
			_, _ = response.Write([]byte(`{"ok":false,"error":"install_required","installRequired":true}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	runtime, stdout := desktopLaunchRuntime(t, server)
	if err := runDesktopOnlyProviderLaunch(context.Background(), "codebuddy", []string{"1"}, runtime); err != nil {
		t.Fatalf("install_required 不应返回错误: %v", err)
	}
	if !strings.Contains(stdout.String(), "未找到 codebuddy 桌面端") {
		t.Fatalf("应提示安装桌面端：%q", stdout.String())
	}
}

// --desktop 必须出现在有桌面端的 Provider 帮助里；纯桌面端不需要该旗标。
func TestProviderUsageDocumentsDesktopFlag(t *testing.T) {
	for _, provider := range []string{"codebuddy", "codex", "claude"} {
		var output bytes.Buffer
		writeProviderUsage(&output, provider)
		if !strings.Contains(output.String(), "--desktop") {
			t.Fatalf("%s 帮助缺少 --desktop：%s", provider, output.String())
		}
	}
	var workbuddy bytes.Buffer
	writeProviderUsage(&workbuddy, "workbuddy")
	if strings.Contains(workbuddy.String(), "--desktop") {
		t.Fatalf("纯桌面端不应宣传 --desktop：%s", workbuddy.String())
	}
	if !strings.Contains(workbuddy.String(), "打开桌面端") {
		t.Fatalf("workbuddy 帮助缺少桌面端说明：%s", workbuddy.String())
	}
}

func TestProviderHelpSupported(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn"} {
		if !providerHelpSupported(provider) {
			t.Fatalf("%s 应有专用帮助", provider)
		}
	}
	for _, provider := range []string{"gemini", "agy", "qoder", "cline", "account", "nope", ""} {
		if providerHelpSupported(provider) {
			t.Fatalf("%s 不应有专用帮助", provider)
		}
	}
}

// 桌面端无法执行的动词必须在入口显式拒绝，而不是静默返回 0。
func TestDesktopLaunchRejectsVerbs(t *testing.T) {
	for _, verb := range []string{"relay", "resume", "fork"} {
		err := runDesktopOnlyProviderLaunch(context.Background(), "workbuddy", []string{verb}, commandRuntime{})
		if err == nil || !strings.Contains(err.Error(), verb) {
			t.Fatalf("%s 应被拒绝：%v", verb, err)
		}
	}
}
