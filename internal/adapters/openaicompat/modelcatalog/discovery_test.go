package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// fakeCredential 造一条带指定 ProviderID 的原生凭据。
func fakeCredential(t *testing.T, providerID string) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity(providerID, "user-1")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"access_token": "token-1"})
	if err != nil {
		t.Fatalf("序列化凭据失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	return credential
}

func staticToken(accountapp.Credential) (string, error) { return "token-1", nil }

// TestDiscoverModelsParsesStandardPayload 守标准 OpenAI 清单解析。
func TestDiscoverModelsParsesStandardPayload(t *testing.T) {
	var gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"data":[{"id":"k3"},{"id":"k3-256k"},{"id":"k3"}]}`))
	}))
	defer server.Close()

	source, err := New(server.Client(), Options{
		ProviderID: "kimi",
		Endpoint:   server.URL + ModelsPath,
		Token:      staticToken,
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), fakeCredential(t, "kimi"))
	if err != nil {
		t.Fatalf("发现失败: %v", err)
	}
	if gotPath != ModelsPath {
		t.Fatalf("路径错误：%q", gotPath)
	}
	if gotAuth != "Bearer token-1" {
		t.Fatalf("鉴权头错误：%q", gotAuth)
	}
	// 重复项必须去重（上游清单里可能重复）。
	if len(models) != 2 || models[0] != "k3" || models[1] != "k3-256k" {
		t.Fatalf("清单错误：%v", models)
	}
}

// TestDiscoverModelsSendsExtraHeaders 守额外头（kimi 的设备指纹）。
func TestDiscoverModelsSendsExtraHeaders(t *testing.T) {
	var gotHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("X-Msh-Device-Id")
		_, _ = w.Write([]byte(`{"data":[{"id":"k3"}]}`))
	}))
	defer server.Close()

	source, err := New(server.Client(), Options{
		ProviderID: "kimi",
		Endpoint:   server.URL + ModelsPath,
		Token:      staticToken,
		ExtraHeaders: func(accountapp.Credential) map[string]string {
			return map[string]string{"X-Msh-Device-Id": "device-1"}
		},
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	if _, err := source.DiscoverModels(context.Background(), fakeCredential(t, "kimi")); err != nil {
		t.Fatalf("发现失败: %v", err)
	}
	if gotHeader != "device-1" {
		t.Fatalf("额外头未发送：%q", gotHeader)
	}
}

// TestDiscoverModelsRejectsProviderMismatch 守凭据归属校验。
func TestDiscoverModelsRejectsProviderMismatch(t *testing.T) {
	source, _ := New(http.DefaultClient, Options{
		ProviderID: "kimi",
		Endpoint:   "https://example.invalid/models",
		Token:      staticToken,
	})
	_, err := source.DiscoverModels(context.Background(), fakeCredential(t, "zcode"))
	if !errors.Is(err, ErrProviderMismatch) {
		t.Fatalf("必须拒绝凭据归属不符，实际 %v", err)
	}
}

// TestDiscoverModelsReportsEmptyCatalog 守「空清单是错误而非空目录」。
//
// 这个区分很重要：返回错误让刷新保持旧目录（last-known-good），
// 返回空清单会把已有目录清掉。
func TestDiscoverModelsReportsEmptyCatalog(t *testing.T) {
	cases := map[string]string{
		"空 data": `{"data":[]}`,
		"结构不认":   `{"models":["a"]}`,
		"非 JSON": `not json`,
		"id 全为空": `{"data":[{"id":""},{"id":"  "}]}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(payload))
			}))
			defer server.Close()
			source, _ := New(server.Client(), Options{
				ProviderID: "kimi",
				Endpoint:   server.URL + ModelsPath,
				Token:      staticToken,
			})
			_, err := source.DiscoverModels(context.Background(), fakeCredential(t, "kimi"))
			if !errors.Is(err, ErrEmptyCatalog) {
				t.Fatalf("必须报 ErrEmptyCatalog，实际 %v", err)
			}
		})
	}
}

// TestDiscoverModelsReportsHTTPFailure 守上游失败。
func TestDiscoverModelsReportsHTTPFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	source, _ := New(server.Client(), Options{
		ProviderID: "kimi",
		Endpoint:   server.URL + ModelsPath,
		Token:      staticToken,
	})
	if _, err := source.DiscoverModels(context.Background(), fakeCredential(t, "kimi")); err == nil {
		t.Fatal("HTTP 失败必须报错")
	}
}

// TestDiscoverModelsPropagatesTokenFailure 守凭据取法失败即失败（不猜）。
func TestDiscoverModelsPropagatesTokenFailure(t *testing.T) {
	source, _ := New(http.DefaultClient, Options{
		ProviderID: "kimi",
		Endpoint:   "https://example.invalid/models",
		Token: func(accountapp.Credential) (string, error) {
			return "", errors.New("no token")
		},
	})
	if _, err := source.DiscoverModels(context.Background(), fakeCredential(t, "kimi")); err == nil {
		t.Fatal("取不到令牌必须报错，不得发无鉴权请求")
	}
}

// TestNewRejectsIncompleteOptions 守默认失败关闭。
func TestNewRejectsIncompleteOptions(t *testing.T) {
	cases := map[string]Options{
		"缺 client":   {ProviderID: "kimi", Endpoint: "https://x.invalid/models", Token: staticToken},
		"缺 provider": {Endpoint: "https://x.invalid/models", Token: staticToken},
		"缺 endpoint": {ProviderID: "kimi", Token: staticToken},
		"缺 token":    {ProviderID: "kimi", Endpoint: "https://x.invalid/models"},
	}
	for name, options := range cases {
		t.Run(name, func(t *testing.T) {
			// 缺 client 那一档必须传**未装箱的** nil：把 nil 装进 HTTPClient 接口后
			// 接口本身非 nil，New 里的 == nil 判定不会命中。
			if name == "缺 client" {
				if _, err := New(nil, options); !errors.Is(err, ErrInvalidDependencies) {
					t.Fatalf("必须报 ErrInvalidDependencies，实际 %v", err)
				}
				return
			}
			if _, err := New(http.DefaultClient, options); !errors.Is(err, ErrInvalidDependencies) {
				t.Fatalf("必须报 ErrInvalidDependencies，实际 %v", err)
			}
		})
	}
}
