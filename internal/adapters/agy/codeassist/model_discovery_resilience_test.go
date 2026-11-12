package codeassist

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

type discoveryFailingProjectClient struct {
	mu        sync.Mutex
	requestID string
}

func (client *discoveryFailingProjectClient) Do(request *http.Request) (*http.Response, error) {
	body := ""
	status := http.StatusOK
	switch {
	case strings.HasSuffix(request.URL.Path, ":loadCodeAssist"):
		status = http.StatusInternalServerError
		body = `{"error":{"message":"onboarding unavailable"}}`
	case strings.HasSuffix(request.URL.Path, ":fetchAvailableModels"):
		raw, _ := io.ReadAll(request.Body)
		var payload map[string]string
		_ = json.Unmarshal(raw, &payload)
		client.mu.Lock()
		client.requestID = payload["requestId"]
		client.mu.Unlock()
		body = `{"models":{"gemini-3.8-flash-tiered":{}}}`
	default:
		status = http.StatusNotFound
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}, nil
}

func discoveryTestAuth(t *testing.T) *agy.OAuthAuth {
	t.Helper()
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "discovery@example.test",
		AccessToken:   "discovery-access",
		RefreshToken:  "discovery-refresh",
		ExpiresAtMS:   1_893_456_000_000,
		RefreshedAtMS: 1_893_452_400_000,
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

// Node 在 loadCodeAssist 失败时仍会继续取目录；Go 不能因为 project 抖动整账号失败。
func TestDiscoverModelsToleratesProjectFailure(t *testing.T) {
	client := &discoveryFailingProjectClient{}
	source, err := NewModelCatalogSource(client)
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), discoveryTestAuth(t))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) == 0 {
		t.Fatal("DiscoverModels() returned no models")
	}
	found := false
	for _, model := range models {
		if model == "gemini-3.8-flash-tiered" {
			found = true
		}
	}
	if !found {
		t.Fatalf("models = %v, want tiered base", models)
	}
	client.mu.Lock()
	requestID := client.requestID
	client.mu.Unlock()
	if !regexp.MustCompile(`^agent/models/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(requestID) {
		t.Fatalf("requestId = %q, want random UUID", requestID)
	}
}
