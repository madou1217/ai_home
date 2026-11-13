package managementapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestDetectHostAccountsContract 守住扫描接口路径与响应字段（WebUI 同形）。
func TestDetectHostAccountsContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Fatalf("method = %s", request.Method)
		}
		if request.URL.Path != accountDetectPath {
			t.Fatalf("path = %q", request.URL.Path)
		}
		_ = json.NewEncoder(response).Encode(map[string]any{
			"ok":       true,
			"scanned":  3,
			"updated":  2,
			"reloaded": true,
			"skipped": []map[string]any{
				{"provider": "codebuddy", "source": "vendor", "reason": "no_credential"},
			},
			"accounts": map[string]int{"codebuddy": 2},
		})
	}))
	defer server.Close()
	client, err := New(server.Client(), Config{
		BaseURL:       server.URL,
		ManagementKey: "0123456789abcdef0123456789abcdef",
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	result, err := client.DetectHostAccounts(context.Background())
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if !result.OK || result.Scanned != 3 || result.Updated != 2 || !result.Reloaded {
		t.Fatalf("result = %#v", result)
	}
	if len(result.Skipped) != 1 || result.Skipped[0].Reason != "no_credential" {
		t.Fatalf("skipped = %#v", result.Skipped)
	}
	if result.Accounts["codebuddy"] != 2 {
		t.Fatalf("accounts = %#v", result.Accounts)
	}
}
