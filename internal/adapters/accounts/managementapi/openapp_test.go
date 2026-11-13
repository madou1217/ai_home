package managementapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestOpenAppContract 守住 open-app 路径、请求体与结果字段。
func TestOpenAppContract(t *testing.T) {
	var bodies []map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Fatalf("method = %s", request.Method)
		}
		if request.URL.Path != "/v1/management/webui/accounts/codebuddycn/acct_0123456789abcdef0123/open-app" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		var body map[string]string
		_ = json.NewDecoder(request.Body).Decode(&body)
		bodies = append(bodies, body)
		response.Header().Set("Content-Type", "application/json")
		if body["action"] == "close" {
			_, _ = response.Write([]byte("{\"ok\":true,\"status\":\"closed\"}"))
			return
		}
		_, _ = response.Write([]byte("{\"ok\":true,\"status\":\"launched\",\"launchMode\":\"desktop\",\"pids\":[1,2]}"))
	}))
	defer server.Close()
	client, err := New(server.Client(), Config{
		BaseURL:       server.URL,
		ManagementKey: "0123456789abcdef0123456789abcdef",
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	ctx := context.Background()
	if _, err := client.OpenApp(ctx, "codebuddycn", "acct_0123456789abcdef0123", "desktop", "close"); err != nil {
		t.Fatalf("close: %v", err)
	}
	result, err := client.OpenApp(ctx, "codebuddycn", "acct_0123456789abcdef0123", "desktop", "open")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !result.OK || result.Status != "launched" || len(result.PIDs) != 2 {
		t.Fatalf("result = %#v", result)
	}
	if len(bodies) != 2 || bodies[0]["kind"] != "desktop" || bodies[1]["action"] != "open" {
		t.Fatalf("bodies = %#v", bodies)
	}
}
