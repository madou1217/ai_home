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
	"github.com/madou1217/ai_home/internal/transport/http/opencoderelay"
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

func TestDiscoverModelsProbesAnonymouslyForOAuthCredentials(t *testing.T) {
	t.Parallel()
	var seen []string
	source := testSource(t, func(path string, request *http.Request) (int, string) {
		seen = append(seen, request.Header.Get("Authorization"))
		if path == "/zen/go/v1/models" {
			return http.StatusOK, `{"data":[{"id":"go-model"}]}`
		}
		return http.StatusOK, `{"data":[{"id":"free-model"}]}`
	})
	models, err := source.DiscoverModels(context.Background(), oauthCredential(t))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if strings.Join(models, ",") != "opencode-go/go-model,opencode/free-model" {
		t.Fatalf("models = %v", models)
	}
	// 登录态 token 不能当目录探测令牌：Zen 收到它只返回账号有权子集（实测 39 vs 匿名 80）。
	for _, authorization := range seen {
		if authorization != "" {
			t.Fatalf("OAuth 凭据不应发送 Authorization，实际 %q", authorization)
		}
	}
}
func TestDiscoverModelsFailsClosedWhenOneLegFails(t *testing.T) {
	t.Parallel()
	source := testSource(t, func(path string, _ *http.Request) (int, string) {
		if path == "/zen/go/v1/models" {
			return http.StatusServiceUnavailable, "down"
		}
		return http.StatusOK, `{"data":[{"id":"free-model"}]}`
	})
	// 单腿失败 = 只看到半份目录。必须失败让刷新重试，不能把并集的一半当结论写进
	// account_models——那会让另一半模型静默从路由里消失（本机实测少了 41 个）。
	models, err := source.DiscoverModels(context.Background(), apiKeyCredential(t))
	if err == nil {
		t.Fatalf("单腿失败应返回错误，实际 models = %v", models)
	}
	if len(models) != 0 {
		t.Fatalf("失败时不应返回部分目录: %v", models)
	}
}

func TestDiscoverModelsProbesAnonymouslyWithoutOpenCodeKey(t *testing.T) {
	t.Parallel()
	var authorizations []string
	source := testSource(t, func(path string, request *http.Request) (int, string) {
		authorizations = append(authorizations, request.Header.Get("Authorization"))
		if path == "/zen/go/v1/models" {
			return http.StatusOK, `{"data":[{"id":"beam-free"}]}`
		}
		return http.StatusOK, `{"data":[{"id":"free-model"}]}`
	})
	models, err := source.DiscoverModels(context.Background(), codexShapedCredential(t))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if strings.Join(models, ",") != "opencode-go/beam-free,opencode/free-model" {
		t.Fatalf("models = %v", models)
	}
	if len(authorizations) != 2 {
		t.Fatalf("requests = %d", len(authorizations))
	}
	for _, authorization := range authorizations {
		if authorization != "" {
			t.Fatalf("authorization = %q, want empty", authorization)
		}
	}
}

func TestNewMapsOfficialLegsToNamespaces(t *testing.T) {
	t.Parallel()
	source, err := New(http.DefaultClient)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if len(source.legs) != 2 {
		t.Fatalf("legs = %d", len(source.legs))
	}
	if source.legs[0].baseURL != opencoderelay.GoBaseURL || source.legs[0].prefix != goModelPrefix {
		t.Fatalf("go leg = %#v", source.legs[0])
	}
	if source.legs[1].baseURL != opencoderelay.ZenBaseURL || source.legs[1].prefix != zenModelPrefix {
		t.Fatalf("zen leg = %#v", source.legs[1])
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
