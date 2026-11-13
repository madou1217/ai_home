package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const accountListFixture = "{\"data\":[" +
	"{\"account_ref\":\"acct_0123456789abcdef0123\",\"provider_id\":\"codebuddycn\",\"cli_account_id\":2,\"enabled\":true,\"has_credential\":false,\"auth_kind\":\"\",\"auth_mode\":\"\",\"has_profile\":false,\"display_name\":\"\",\"email\":\"\",\"subscription_kind\":\"\",\"subscription_raw\":\"\",\"profile_updated_at\":\"\",\"created_at\":\"2026-11-13T00:00:00Z\",\"updated_at\":\"2026-11-13T00:00:00Z\"}," +
	"{\"account_ref\":\"acct_11111111111111111111\",\"provider_id\":\"codebuddycn\",\"cli_account_id\":1,\"enabled\":true,\"has_credential\":false,\"auth_kind\":\"\",\"auth_mode\":\"\",\"has_profile\":false,\"display_name\":\"\",\"email\":\"\",\"subscription_kind\":\"\",\"subscription_raw\":\"\",\"profile_updated_at\":\"\",\"created_at\":\"2026-11-13T00:00:00Z\",\"updated_at\":\"2026-11-13T00:00:00Z\"}," +
	"{\"account_ref\":\"acct_22222222222222222222\",\"provider_id\":\"codebuddy\",\"cli_account_id\":1,\"enabled\":true,\"has_credential\":false,\"auth_kind\":\"\",\"auth_mode\":\"\",\"has_profile\":false,\"display_name\":\"\",\"email\":\"\",\"subscription_kind\":\"\",\"subscription_raw\":\"\",\"profile_updated_at\":\"\",\"created_at\":\"2026-11-13T00:00:00Z\",\"updated_at\":\"2026-11-13T00:00:00Z\"}" +
	"],\"page\":{\"limit\":200,\"has_more\":false}}"

// TestRunGlobalAccountListScopeAndOrder 一次拉全量账号，按 manifest 顺序分组、组内按别名排序。
func TestRunGlobalAccountListScopeAndOrder(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.URL.Path == "/v1/management/accounts":
			_, _ = response.Write([]byte(accountListFixture))
		default:
			// 额度接口在测试里不需要：GetUsage 失败时行仍输出（Remaining Unknown）。
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte("{\"error\":{\"code\":\"not_found\"}}"))
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
	if err := runGlobalAccountList(context.Background(), []string{"--scope", "codebuddycn"}, runtime); err != nil {
		t.Fatalf("list: %v", err)
	}
	text := stdout.String()
	if !strings.Contains(text, "AI Home Accounts Overview") {
		t.Fatalf("缺少标题: %q", text)
	}
	if strings.Contains(text, "▶ codebuddy\n") {
		t.Fatalf("--scope 过滤失效: %q", text)
	}
	first := strings.Index(text, "Account ID: 1")
	second := strings.Index(text, "Account ID: 2")
	if first < 0 || second < 0 || first > second {
		t.Fatalf("组内未按别名排序: %q", text)
	}
}
