package messages

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
)

func TestModelCatalogCandidatesFollowNodeOrder(t *testing.T) {
	t.Parallel()
	endpoints := modelCatalogCandidates("https://api.deepseek.com/anthropic")
	expected := []string{
		"https://api.deepseek.com/anthropic/models",
		"https://api.deepseek.com/anthropic/v1/models",
		"https://api.deepseek.com/v1/models",
		"https://api.deepseek.com/models",
	}
	if strings.Join(endpoints, ",") != strings.Join(expected, ",") {
		t.Fatalf("endpoints = %v", endpoints)
	}
	// 已是 origin 时只保留 base 两个候选。
	if got := modelCatalogCandidates("https://proxy.example.com/v1"); len(got) != 3 {
		t.Fatalf("origin endpoints = %v", got)
	}
}

func TestFetchCatalogAtAcceptsOpenAIShapeOnce(t *testing.T) {
	t.Parallel()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/anthropic/v1/models" {
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"ok":false}`))
			return
		}
		if request.Header.Get("x-api-key") != "sk-test" {
			t.Errorf("x-api-key = %q", request.Header.Get("x-api-key"))
		}
		if request.Header.Get("anthropic-version") != anthropicVersion {
			t.Errorf("anthropic-version = %q", request.Header.Get("anthropic-version"))
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"object":"list","data":[{"id":"deepseek-flash"},{"id":"deepseek-v4-pro"},{"id":"deepseek-flash"}]}`))
	}))
	defer server.Close()
	models, err := fetchCatalogAt(
		context.Background(),
		server.Client(),
		modelCatalogAuth{baseURL: server.URL + "/anthropic", headerName: "x-api-key", headerValue: "sk-test"},
		server.URL+"/anthropic/v1/models",
	)
	if err != nil {
		t.Fatalf("fetchCatalogAt() error = %v", err)
	}
	if strings.Join(models, ",") != "deepseek-flash,deepseek-v4-pro" {
		t.Fatalf("models = %v", models)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestFetchModelCatalogFallsBackToOrigin(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/models", "/models":
			_, _ = response.Write([]byte(`{"object":"list","data":[{"id":"deepseek-flash"}]}`))
		default:
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"ok":false}`))
		}
	}))
	defer server.Close()
	catalog, err := fetchModelCatalog(
		context.Background(),
		server.Client(),
		modelCatalogAuth{baseURL: server.URL + "/anthropic", headerName: "x-api-key", headerValue: "sk-test"},
	)
	if err != nil {
		t.Fatalf("fetchModelCatalog() error = %v", err)
	}
	if strings.Join(catalog.models, ",") != "deepseek-flash" {
		t.Fatalf("models = %v", catalog.models)
	}
}

func TestFetchModelCatalogReportsEveryCandidate(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusUnauthorized)
		_, _ = response.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer server.Close()
	_, err := fetchModelCatalog(
		context.Background(),
		server.Client(),
		modelCatalogAuth{baseURL: server.URL + "/anthropic", headerName: "x-api-key", headerValue: "sk-test"},
	)
	if err == nil {
		t.Fatal("expected an error")
	}
	message := err.Error()
	for _, endpoint := range modelCatalogCandidates(server.URL + "/anthropic") {
		if !strings.Contains(message, endpoint) {
			t.Fatalf("error does not mention %s: %s", endpoint, message)
		}
	}
	if !strings.Contains(message, "status=401") {
		t.Fatalf("error does not carry the status: %s", message)
	}
	if strings.Contains(message, "media_type=missing") {
		t.Fatalf("error still reports a missing media type: %s", message)
	}
}

func TestDiscoverModelsFallsBackForProxyPrefix(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/models", "/models":
			_, _ = response.Write([]byte(`{"object":"list","data":[{"id":"deepseek-flash"}]}`))
		default:
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"ok":false}`))
		}
	}))
	defer server.Close()
	auth, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		BaseURL: server.URL + "/anthropic",
		APIKey:  "sk-test",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	source, err := NewModelCatalogSource(server.Client())
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), auth)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 || models[0] != "deepseek-flash" {
		t.Fatalf("models = %v", models)
	}
}
