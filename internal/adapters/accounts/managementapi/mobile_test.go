package managementapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestMobileBindingContract 守住 set/clear-mobile 的路径与响应字段。
func TestMobileBindingContract(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Fatalf("method = %s", request.Method)
		}
		seen = append(seen, request.URL.Path)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte("{\"ok\":true,\"provider\":\"codex\",\"accountRef\":\"acct_0123456789abcdef0123\",\"desktopAccountRef\":\"acct_0123456789abcdef0123\",\"changed\":true}"))
	}))
	defer server.Close()
	client, err := New(server.Client(), Config{
		BaseURL:       server.URL,
		ManagementKey: "0123456789abcdef0123456789abcdef",
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	binding, err := client.SetMobile(context.Background(), "codex", "acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	if !binding.Changed || binding.DesktopAccountRef != "acct_0123456789abcdef0123" {
		t.Fatalf("binding = %#v", binding)
	}
	if _, err := client.ClearMobile(context.Background(), "codex", "acct_0123456789abcdef0123"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if len(seen) != 2 ||
		seen[0] != "/v1/management/webui/accounts/codex/acct_0123456789abcdef0123/set-mobile" ||
		seen[1] != "/v1/management/webui/accounts/codex/acct_0123456789abcdef0123/clear-mobile" {
		t.Fatalf("paths = %v", seen)
	}
}

// TestMobileBindingRejectsOtherProviders 非 codex 账号不能绑定 Codex App。
func TestMobileBindingRejectsOtherProviders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusBadRequest)
		_, _ = response.Write([]byte("{\"ok\":false,\"error\":\"mobile_account_unsupported\"}"))
	}))
	defer server.Close()
	client, err := New(server.Client(), Config{
		BaseURL:       server.URL,
		ManagementKey: "0123456789abcdef0123456789abcdef",
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	if _, err := client.SetMobile(context.Background(), "claude", "acct_0123456789abcdef0123"); err == nil {
		t.Fatal("非 codex 应失败")
	}
}
