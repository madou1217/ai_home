package aihserver_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestServerReadinessFollowsEnabledAccounts 验证公开探针与管理启停共享当前索引事实。
func TestServerReadinessFollowsEnabledAccounts(t *testing.T) {
	t.Parallel()

	baseURL, client := startTestServer(t)
	assertReadiness := func(wantReady bool, wantCodexCount int) {
		t.Helper()
		response := performRequest(t, client, http.MethodGet, baseURL+"/readyz", "", nil)
		assertStatus(t, response, http.StatusOK)
		var document struct {
			Ready    *bool          `json:"ready"`
			Accounts map[string]int `json:"accounts"`
		}
		decodeJSON(t, response.body, &document)
		if document.Ready == nil || *document.Ready != wantReady {
			t.Fatalf("readyz must explicitly report ready=%t: %s", wantReady, response.body)
		}
		if len(document.Accounts) != len(providers.BuiltinManifest().Providers) || document.Accounts["codex"] != wantCodexCount {
			t.Fatalf("readyz account counts = %#v, want codex=%d and all provider keys", document.Accounts, wantCodexCount)
		}
	}

	assertReadiness(false, 0)
	created := performRequest(t, client, http.MethodPost, baseURL+accountsapi.CollectionPath, testManagementKey,
		[]byte(`{"provider_id":"codex","auth":{"kind":"api_key","api_key":"synthetic-readyz-account"}}`))
	assertStatus(t, created, http.StatusCreated)
	var account struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	decodeJSON(t, created.body, &account)
	assertReadiness(true, 1)

	for _, enabled := range []bool{false, true} {
		payload, err := json.Marshal(map[string]bool{"enabled": enabled})
		if err != nil {
			t.Fatal(err)
		}
		updated := performRequest(t, client, http.MethodPatch, baseURL+accountsapi.CollectionPath+"/"+account.Data.AccountRef, testManagementKey, payload)
		assertStatus(t, updated, http.StatusOK)
		count := 0
		if enabled {
			count = 1
		}
		assertReadiness(enabled, count)
	}

	health := performRequest(t, client, http.MethodGet, baseURL+"/healthz", "", nil)
	assertStatus(t, health, http.StatusOK)
	var healthDocument map[string]any
	decodeJSON(t, health.body, &healthDocument)
	if len(healthDocument) != 2 || healthDocument["ok"] != true || healthDocument["service"] != "aih-server" {
		t.Fatalf("healthz contract changed: %s", health.body)
	}
}
