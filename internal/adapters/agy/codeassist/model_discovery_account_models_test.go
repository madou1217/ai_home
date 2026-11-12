package codeassist

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/providers"
)

// accountModelsUpstreamClient 模拟 agy 上游：只返回 tiered 基座，不返回档位别名。
type accountModelsUpstreamClient struct{}

func (accountModelsUpstreamClient) Do(request *http.Request) (*http.Response, error) {
	var body string
	switch {
	case strings.HasSuffix(request.URL.Path, ":loadCodeAssist"):
		body = `{"cloudaicompanionProject":"account-models-project"}`
	case strings.HasSuffix(request.URL.Path, ":fetchAvailableModels"):
		body = `{"models":{"gemini-3.8-flash-tiered":{}}}`
	default:
		return nil, fmt.Errorf("unexpected AGY request %s", request.URL.Path)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}, nil
}

// TestAccountModelsIncludeExpandedGeminiTiers 是 account_models 的回归守卫：
// 上游 fetchAvailableModels 只给 gemini-3.8-flash-tiered 基座时，agy 目录发现
// 必须补齐 high/medium/low，账号刷新写入 account_models 的集合里才仍有这三个
// 可路由 ID。旧实现只保留基座，WebUI 和网关都看不到档位别名。
func TestAccountModelsIncludeExpandedGeminiTiers(t *testing.T) {
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "account-models@example.com",
		AccessToken:   "account-models-access-token",
		RefreshToken:  "account-models-refresh-token",
		ExpiresAtMS:   1_893_456_000_000,
		RefreshedAtMS: 1_893_452_400_000,
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	source, err := NewModelCatalogSource(accountModelsUpstreamClient{})
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	discovery, err := accountapp.NewModelDiscovery(
		catalog,
		[]accountapp.ProviderModelDiscoverer{source},
	)
	if err != nil {
		t.Fatalf("NewModelDiscovery() error = %v", err)
	}
	// ModelDiscovery.DiscoverModels 的输出就是 RefreshAccountModels 原样写入
	// account_models 的模型集合。
	models, err := discovery.DiscoverModels(context.Background(), auth)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	want := []string{
		"gemini-3.8-flash-high",
		"gemini-3.8-flash-low",
		"gemini-3.8-flash-medium",
		"gemini-3.8-flash-tiered",
	}
	if len(models) != len(want) {
		t.Fatalf("account models = %v, want %v", models, want)
	}
	for index, model := range models {
		if model.String() != want[index] {
			t.Fatalf("account models[%d] = %q, want %q (models %v)", index, model, want[index], models)
		}
	}
}
