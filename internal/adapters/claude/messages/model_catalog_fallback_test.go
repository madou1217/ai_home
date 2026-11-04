package messages

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
)

func TestOpenAIModelEndpointsTriesBaseThenOrigin(t *testing.T) {
	t.Parallel()
	endpoints := openAIModelEndpoints("https://api.deepseek.com/anthropic")
	expected := []string{
		"https://api.deepseek.com/anthropic/v1/models",
		"https://api.deepseek.com/anthropic/models",
		"https://api.deepseek.com/v1/models",
		"https://api.deepseek.com/models",
	}
	if strings.Join(endpoints, ",") != strings.Join(expected, ",") {
		t.Fatalf("endpoints = %v", endpoints)
	}
	// 已是 origin 时不重复追加根路径。
	if got := openAIModelEndpoints("https://proxy.example.com"); len(got) != 2 {
		t.Fatalf("origin endpoints = %v", got)
	}
}

func TestOpenAICompatibleFallbackReadsDataList(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/models" {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		if request.Header.Get("x-api-key") != "sk-test" {
			t.Errorf("x-api-key = %q", request.Header.Get("x-api-key"))
		}
		_, _ = response.Write([]byte(`{"object":"list","data":[{"id":"deepseek-flash"},{"id":"deepseek-v4-pro"},{"id":"deepseek-flash"}]}`))
	}))
	defer server.Close()
	models, err := fetchOpenAICompatibleCatalog(
		context.Background(),
		server.Client(),
		modelCatalogAuth{baseURL: server.URL + "/anthropic", headerName: "x-api-key", headerValue: "sk-test"},
	)
	if err != nil {
		t.Fatalf("fetchOpenAICompatibleCatalog() error = %v", err)
	}
	if strings.Join(models, ",") != "deepseek-flash,deepseek-v4-pro" {
		t.Fatalf("models = %v", models)
	}
}

func TestOpenAICompatibleFallbackRejectsEmptyList(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"object":"list","data":[]}`))
	}))
	defer server.Close()
	if _, err := fetchOpenAICompatibleCatalog(
		context.Background(),
		server.Client(),
		modelCatalogAuth{baseURL: server.URL, headerName: "x-api-key", headerValue: "sk-test"},
	); err == nil {
		t.Fatal("expected an error for an empty list")
	}
}

func TestDiscoverModelsFallsBackForProxyPrefix(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/anthropic/v1/models":
			response.WriteHeader(http.StatusNotFound)
		case "/v1/models", "/models":
			_, _ = response.Write([]byte(`{"object":"list","data":[{"id":"deepseek-flash"}]}`))
		default:
			response.WriteHeader(http.StatusNotFound)
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

var _ accountapp.Credential = (*claudeauth.APIKeyAuth)(nil)
