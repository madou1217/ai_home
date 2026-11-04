package modelcatalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/gemini"
)

func vertexCredential(t *testing.T, baseURL string) accountapp.Credential {
	t.Helper()
	auth, err := gemini.NewVertexAuth(gemini.VertexInput{
		ProjectID:   "vertex-placeholder-project",
		Location:    "global",
		APIKey:      "aih_client_test",
		BaseURL:     baseURL,
		Placeholder: true,
	})
	if err != nil {
		t.Fatalf("NewVertexAuth() error = %v", err)
	}
	return auth
}

func TestDiscoverModelsReadsOpenAIStyleList(t *testing.T) {
	t.Parallel()
	var request *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, req *http.Request) {
		request = req
		if req.URL.Path != "/v1/models" {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = response.Write([]byte(`{"data":[{"id":"Auto"},{"id":"claude-opus-4-6-thinking"},{"id":"Auto"}]}`))
	}))
	defer server.Close()
	source, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), vertexCredential(t, server.URL))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if strings.Join(models, ",") != "Auto,claude-opus-4-6-thinking" {
		t.Fatalf("models = %v", models)
	}
	if request.Header.Get("Authorization") != "Bearer aih_client_test" {
		t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
	}
}

func TestDiscoverModelsFallsBackToGeminiStyleList(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/v1/models" {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = response.Write([]byte(`{"models":[{"name":"models/gemini-2.5-pro"},{"name":"models/gemini-2.5-flash"}]}`))
	}))
	defer server.Close()
	source, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), vertexCredential(t, server.URL))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if strings.Join(models, ",") != "gemini-2.5-flash,gemini-2.5-pro" {
		t.Fatalf("models = %v", models)
	}
}

func TestDiscoverModelsRejectsMissingBaseURL(t *testing.T) {
	t.Parallel()
	source, err := New(http.DefaultClient)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := source.DiscoverModels(context.Background(), vertexCredential(t, "")); err != ErrUnsupportedCredential {
		t.Fatalf("error = %v", err)
	}
}
