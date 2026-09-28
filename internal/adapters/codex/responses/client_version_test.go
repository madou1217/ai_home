package responses

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/clientversion"
)

// TestModelCatalogSourceReportsResolvedClientVersion 锁定修复：OAuth 模型目录按
// client_version 过滤模型，版本必须来自版本解析器而不是写死的旧值。
func TestModelCatalogSourceReportsResolvedClientVersion(t *testing.T) {
	t.Parallel()

	var seen *http.Request
	client := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		seen = request
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"models":[{"slug":"gpt-6-astra"}]}`)),
		}, nil
	})
	source, err := NewModelCatalogSourceWithClientVersion(
		&http.Client{Transport: client},
		clientversion.Static("0.170.0"),
	)
	if err != nil {
		t.Fatalf("NewModelCatalogSourceWithClientVersion() error = %v", err)
	}
	credential := newTestOAuth(t, "workspace-1", false)
	models, err := source.DiscoverModels(context.Background(), credential)
	if err != nil || len(models) != 1 {
		t.Fatalf("DiscoverModels() = %v, %v", models, err)
	}
	if seen.URL.Query().Get("client_version") != "0.170.0" ||
		seen.Header.Get("Version") != "0.170.0" ||
		seen.Header.Get("User-Agent") != "codex_cli_rs/0.170.0" {
		t.Fatalf("request url=%s version=%q ua=%q", seen.URL, seen.Header.Get("Version"), seen.Header.Get("User-Agent"))
	}
}

// roundTripFunc 把函数适配为 http.RoundTripper。
type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
