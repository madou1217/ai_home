package modelcatalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func apiKeyCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeOpenCodeIdentity([]accountcore.NativeOpenCodeGrant{{Upstream: "opencode-go", Type: "api", Secret: "sk-test"}})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{"opencode-go":{"type":"api","key":"sk-test"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func oauthCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeOpenCodeIdentity([]accountcore.NativeOpenCodeGrant{{Upstream: "opencode", Type: "oauth", Subject: "user-1"}})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{"opencode":{"type":"oauth","access":"st-oauth","refresh":"rt"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func codexShapedCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeOpenCodeIdentity([]accountcore.NativeOpenCodeGrant{{Upstream: "opencode-go", Type: "api", Secret: "dummy"}})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{"codex":{"type":"api","key":"dummy"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func testSource(t *testing.T, handler func(path string, request *http.Request) (int, string)) *Source {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		status, payload := handler(request.URL.Path, request)
		response.WriteHeader(status)
		_, _ = response.Write([]byte(payload))
	}))
	t.Cleanup(server.Close)
	source, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	source.legs = []catalogLeg{
		{baseURL: server.URL + "/zen/go/v1", prefix: goModelPrefix},
		{baseURL: server.URL + "/zen/v1", prefix: zenModelPrefix},
	}
	return source
}

func TestDiscoverModelsUnionsBothLegs(t *testing.T) {
	t.Parallel()
	source := testSource(t, func(path string, request *http.Request) (int, string) {
		if request.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		if path == "/zen/go/v1/models" {
			return http.StatusOK, `{"data":[{"id":"deepseek-v4"},{"id":"opencode-go/qwen3.7"}]}`
		}
		return http.StatusOK, `{"data":[{"id":"deepseek-v4"},{"id":"free-model"}]}`
	})
	models, err := source.DiscoverModels(context.Background(), apiKeyCredential(t))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	expected := "opencode-go/deepseek-v4,opencode-go/qwen3.7,opencode/deepseek-v4,opencode/free-model"
	if strings.Join(models, ",") != expected {
		t.Fatalf("models = %v", models)
	}
}

func TestDiscoverModelsAcceptsOAuthAccessToken(t *testing.T) {
	t.Parallel()
	var seen []string
	source := testSource(t, func(path string, request *http.Request) (int, string) {
		seen = append(seen, request.Header.Get("Authorization"))
		if path == "/zen/go/v1/models" {
			return http.StatusUnauthorized, `{}`
		}
		return http.StatusOK, `{"data":[{"id":"free-model"}]}`
	})
	models, err := source.DiscoverModels(context.Background(), oauthCredential(t))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 || models[0] != "opencode/free-model" {
		t.Fatalf("models = %v", models)
	}
	for _, authorization := range seen {
		if authorization != "Bearer st-oauth" {
			t.Fatalf("authorization = %q", authorization)
		}
	}
}

func TestDiscoverModelsToleratesOneFailedLeg(t *testing.T) {
	t.Parallel()
	source := testSource(t, func(path string, _ *http.Request) (int, string) {
		if path == "/zen/go/v1/models" {
			return http.StatusServiceUnavailable, "down"
		}
		return http.StatusOK, `{"data":[{"id":"free-model"}]}`
	})
	models, err := source.DiscoverModels(context.Background(), apiKeyCredential(t))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 || models[0] != "opencode/free-model" {
		t.Fatalf("models = %v", models)
	}
}

func TestDiscoverModelsRejectsUnsupportedCredential(t *testing.T) {
	t.Parallel()
	source := testSource(t, func(string, *http.Request) (int, string) {
		return http.StatusOK, `{}`
	})
	if _, err := source.DiscoverModels(context.Background(), codexShapedCredential(t)); err != ErrUnsupportedCredential {
		t.Fatalf("error = %v", err)
	}
}

func TestParseModelsKeepsPrefixStable(t *testing.T) {
	t.Parallel()
	models := parseModels([]byte(`{"data":[{"model":"opencode/qwen3.7"},{"id":" qwen3.7 "}]}`), zenModelPrefix)
	if len(models) != 1 || models[0] != "opencode/qwen3.7" {
		t.Fatalf("models = %v", models)
	}
}

var _ = json.Marshal
