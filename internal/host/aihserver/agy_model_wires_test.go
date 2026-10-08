package aihserver

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
)

// 新 Host 必须从磁盘恢复转发表并通过正式 HTTP 链路记账，无需热路径再查询目录。
func TestHostRestoresAgyWireModelAndAccountsForPublicID(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	home := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: home, Catalog: catalog})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email: "wire-model@example.com", AccessToken: "access-secret", RefreshToken: "refresh-secret",
		ExpiresAtMS: now.Add(time.Hour).UnixMilli(), RefreshedAtMS: now.UnixMilli(),
		TokenType: "Bearer", AuthMethod: agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatal(err)
	}
	registrar, err := accountapp.NewRegistrar(catalog, store, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	account, err := registrar.Register(ctx, auth, nil)
	if err != nil {
		t.Fatal(err)
	}
	const publicID = "gemini-3.1-pro-high"
	models, err := accountapp.NormalizeDiscoveredModels([]string{publicID})
	if err != nil {
		t.Fatalf("规范化账号模型失败: %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(ctx, account.Ref(), models, now); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	ref, err := accounts.DeriveAccountRef(auth)
	if err != nil {
		t.Fatal(err)
	}
	if err := newAgyModelWires(home).Replace(ref, map[string]string{publicID: "gemini-pro-agent"}); err != nil {
		t.Fatal(err)
	}
	upstream := &agyWireHostClient{t: t}
	const clientKey = "aih-agy-wire-client-key-for-testing"
	const managementKey = "aih-agy-wire-management-key-for-testing"
	server, err := New(ctx, Options{
		AIHomeDir: home, ManagementKey: func() string { return managementKey },
		ClientKey:        func() string { return clientKey },
		ModelDiscoverers: accountmodels.NewDiscoverers(), InferenceHTTPClient: upstream,
		UsageHTTPClient: upstream, DelegateCredentialRefresh: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := server.Close(); err != nil {
			t.Error(err)
		}
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{
		"model":"gemini-3.1-pro-high","max_tokens":32,"messages":[{"role":"user","content":"say ok"}]
	}`))
	request.Header.Set("Authorization", "Bearer "+clientKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Account-Ref", account.Ref().String())
	response := httptest.NewRecorder()
	server.httpServer.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || upstream.calls != 2 ||
		!strings.Contains(response.Body.String(), `"model":"gemini-3.1-pro-high"`) {
		t.Fatalf("status=%d calls=%d response=%s", response.Code, upstream.calls, response.Body)
	}
	usageRequest := httptest.NewRequest(http.MethodGet, "/v1/management/account-usage-events", nil)
	usageRequest.Header.Set("Authorization", "Bearer "+managementKey)
	usageResponse := httptest.NewRecorder()
	server.httpServer.Handler.ServeHTTP(usageResponse, usageRequest)
	var usage struct {
		Data []struct {
			Model string `json:"model"`
			Total uint64 `json:"total_tokens"`
		} `json:"data"`
	}
	if err := json.Unmarshal(usageResponse.Body.Bytes(), &usage); err != nil ||
		usageResponse.Code != http.StatusOK || len(usage.Data) != 1 ||
		usage.Data[0].Model != publicID || usage.Data[0].Total != 7 {
		t.Fatalf("usage=%s error=%v", usageResponse.Body, err)
	}
}

type agyWireHostClient struct {
	t     *testing.T
	calls int
}

func (client *agyWireHostClient) Do(request *http.Request) (*http.Response, error) {
	client.calls++
	if strings.HasSuffix(request.URL.Path, ":loadCodeAssist") {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"cloudaicompanionProject":"project-123"}`))}, nil
	}
	if strings.HasSuffix(request.URL.Path, ":streamGenerateContent") {
		var document struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(request.Body).Decode(&document); err != nil || document.Model != "gemini-pro-agent" {
			client.t.Fatalf("upstream model=%q error=%v", document.Model, err)
		}
		return &http.Response{
			StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"text/event-stream"}},
			Body: io.NopCloser(strings.NewReader("data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"OK\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":4,\"candidatesTokenCount\":3}}}\n\n")),
		}, nil
	}
	client.t.Fatalf("unexpected upstream request %s", request.URL)
	return nil, nil
}
