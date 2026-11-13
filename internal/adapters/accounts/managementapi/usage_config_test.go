package managementapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestUsageConfigRoundTrip 守住 config:usage 的管理契约：GET 读 ok/config，
// POST 必须整份提交 config（服务端按整份覆盖，不做字段合并）。
func TestUsageConfigRoundTrip(t *testing.T) {
	var posted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != usageConfigPath {
			t.Fatalf("path = %q, want %q", request.URL.Path, usageConfigPath)
		}
		if request.Header.Get("Authorization") != "Bearer 0123456789abcdef0123456789abcdef" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		switch request.Method {
		case http.MethodGet:
			_ = json.NewEncoder(response).Encode(map[string]any{
				"ok": true,
				"config": map[string]any{
					"active_refresh_interval":     "1m",
					"background_refresh_interval": "1h",
					"threshold_pct":               99,
					"auto_switch":                 true,
					"auto_switch_remaining_pct":   5,
				},
			})
		case http.MethodPost:
			if err := json.NewDecoder(request.Body).Decode(&posted); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"ok": true})
		default:
			t.Fatalf("method = %s", request.Method)
		}
	}))
	defer server.Close()

	client, err := New(server.Client(), Config{
		BaseURL:       server.URL,
		ManagementKey: "0123456789abcdef0123456789abcdef",
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	config, err := client.GetUsageConfig(context.Background())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !config.AutoSwitch || config.ThresholdPct != 99 {
		t.Fatalf("config = %#v", config)
	}
	if config.AutoSwitchRemainingPct == nil || *config.AutoSwitchRemainingPct != 5 {
		t.Fatalf("remaining = %#v", config.AutoSwitchRemainingPct)
	}
	config.AutoSwitchRemainingPct = nil
	config.AutoSwitch = false
	if err := client.SetUsageConfig(context.Background(), config); err != nil {
		t.Fatalf("set: %v", err)
	}
	payload, ok := posted["config"].(map[string]any)
	if !ok {
		t.Fatalf("posted = %#v", posted)
	}
	if payload["auto_switch"] != false || payload["threshold_pct"] != float64(99) {
		t.Fatalf("posted config = %#v", payload)
	}
	if _, exists := payload["auto_switch_remaining_pct"]; !exists {
		t.Fatalf("remaining 必须显式写 null，否则整份覆盖会保留旧阈值")
	}
}
