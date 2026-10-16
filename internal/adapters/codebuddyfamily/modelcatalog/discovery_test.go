package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
)

// familyCredential 构造一条家族原生凭据（带 access token）。
func familyCredential(
	t *testing.T,
	providerID string,
	token string,
) accountapp.Credential {
	t.Helper()

	identity, err := accountcore.NewNativeSubjectIdentity(providerID, "uid-1")
	if err != nil {
		t.Fatalf("构造原生身份失败: %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"credentials": map[string]any{
			"auth":    map[string]any{"accessToken": token},
			"account": map[string]any{"uid": "uid-1"},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造原生凭据失败: %v", err)
	}
	return credential
}

// newTestSource 指向测试替身站点，并返回请求取证器。
func newTestSource(
	t *testing.T,
	providerID string,
	handler http.HandlerFunc,
) (*ModelCatalogSource, *[]*http.Request) {
	t.Helper()

	recorded := make([]*http.Request, 0, 1)
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		cloned := request.Clone(context.Background())
		recorded = append(recorded, cloned)
		handler(response, request)
	}))
	t.Cleanup(server.Close)
	return &ModelCatalogSource{
		client:     server.Client(),
		providerID: providerID,
		baseURL:    server.URL,
	}, &recorded
}

func TestModelCatalogSourcesCoverFamilyProviders(t *testing.T) {
	t.Parallel()

	if _, err := NewModelCatalogSources(nil); !errors.Is(
		err,
		ErrInvalidDependencies,
	) {
		t.Fatalf("NewModelCatalogSources(nil) error = %v", err)
	}
	sources, err := NewModelCatalogSources(http.DefaultClient)
	if err != nil {
		t.Fatalf("NewModelCatalogSources() error = %v", err)
	}
	if len(sources) != len(codebuddyfamilyrelay.FamilyProviders) {
		t.Fatalf("sources = %d want %d", len(sources), len(codebuddyfamilyrelay.FamilyProviders))
	}
	for index, providerID := range codebuddyfamilyrelay.FamilyProviders {
		if sources[index].ProviderID() != providerID {
			t.Fatalf("sources[%d].ProviderID() = %q want %q", index, sources[index].ProviderID(), providerID)
		}
		baseURL, found := codebuddyfamilyrelay.InferenceBaseURL(providerID)
		if !found {
			t.Fatalf("%s 缺少站点根", providerID)
		}
		source, ok := sources[index].(*ModelCatalogSource)
		if !ok || source.baseURL != baseURL {
			t.Fatalf("%s 的目录源站点根 = %#v want %q", providerID, sources[index], baseURL)
		}
	}
}

func TestDiscoverModelsReadsCLIAgentCatalog(t *testing.T) {
	t.Parallel()

	payload := `{"code":0,"msg":"OK","data":{` +
		`"agents":[` +
		`{"name":"chat","models":["ignored-chat-model"]},` +
		`{"name":"cli","commands":[],"models":["default-model","glm-5.3-flash","default-model"," custom-local:my-model ","  ","hy4-preview"]}` +
		`],` +
		`"models":[{"id":"site-wide-model"}]}}`
	source, recorded := newTestSource(t, "workbuddy", func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(payload))
	})
	models, err := source.DiscoverModels(
		context.Background(),
		familyCredential(t, "workbuddy", "tok-1"),
	)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	want := []string{"default-model", "glm-5.3-flash", "hy4-preview"}
	if len(models) != len(want) {
		t.Fatalf("models = %#v want %#v", models, want)
	}
	for index, modelID := range want {
		if models[index] != modelID {
			t.Fatalf("models = %#v want %#v", models, want)
		}
	}
	if len(*recorded) != 1 {
		t.Fatalf("请求数 = %d want 1", len(*recorded))
	}
	request := (*recorded)[0]
	if request.URL.Path != ConfigPath {
		t.Fatalf("请求路径 = %q want %q", request.URL.Path, ConfigPath)
	}
	if got := request.Header.Get("Authorization"); got != "Bearer tok-1" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := request.Header.Get("User-Agent"); got != codebuddyfamilyrelay.UserAgent {
		t.Fatalf("User-Agent = %q want %q", got, codebuddyfamilyrelay.UserAgent)
	}
	if got := request.Header.Get("X-Requested-With"); got != "XMLHttpRequest" {
		t.Fatalf("X-Requested-With = %q", got)
	}
	if got, want := request.Header.Get("Origin"), source.baseURL; got != want {
		t.Fatalf("Origin = %q want %q", got, want)
	}
	if got, want := request.Header.Get("Referer"), source.baseURL+"/"; got != want {
		t.Fatalf("Referer = %q want %q", got, want)
	}
}

func TestDiscoverModelsFallsBackToSiteCatalog(t *testing.T) {
	t.Parallel()

	payload := `{"data":{` +
		`"agents":[{"name":"cli","models":[]}],` +
		`"models":[{"id":"glm-5.3-flash"},{"id":"custom-local:local-only"},{"id":"hy4-preview"}]}}`
	source, _ := newTestSource(t, "workbuddycn", func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = response.Write([]byte(payload))
	})
	models, err := source.DiscoverModels(
		context.Background(),
		familyCredential(t, "workbuddycn", "tok-2"),
	)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 2 || models[0] != "glm-5.3-flash" || models[1] != "hy4-preview" {
		t.Fatalf("models = %#v", models)
	}
}

func TestDiscoverModelsAcceptsPlainStringCatalogEntries(t *testing.T) {
	t.Parallel()

	payload := `{"data":{"models":["default-model","hy4-preview"]}}`
	source, _ := newTestSource(t, "workbuddy", func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = response.Write([]byte(payload))
	})
	models, err := source.DiscoverModels(
		context.Background(),
		familyCredential(t, "workbuddy", "tok-3"),
	)
	if err != nil || len(models) != 2 || models[0] != "default-model" {
		t.Fatalf("models = %#v (err=%v)", models, err)
	}
}

func TestDiscoverModelsRejectsWrongCredential(t *testing.T) {
	t.Parallel()

	source, recorded := newTestSource(t, "workbuddy", func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = response.Write([]byte(`{"data":{"models":[{"id":"m"}]}}`))
	})
	// 归属不符：不触网，直接报错。
	if _, err := source.DiscoverModels(
		context.Background(),
		familyCredential(t, "workbuddycn", "tok"),
	); !errors.Is(err, ErrProviderMismatch) {
		t.Fatalf("DiscoverModels(foreign provider) error = %v", err)
	}
	// 无 access token 的原生凭据：确定性属性，不猜别的字段。
	identity, err := accountcore.NewNativeSubjectIdentity("workbuddy", "uid-1")
	if err != nil {
		t.Fatalf("构造原生身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(
		identity,
		[]byte(`{"credentials":{"auth":{}}}`),
	)
	if err != nil {
		t.Fatalf("构造原生凭据失败: %v", err)
	}
	if _, err := source.DiscoverModels(
		context.Background(),
		credential,
	); !errors.Is(err, codebuddyfamilyrelay.ErrUnsupportedCredential) {
		t.Fatalf("DiscoverModels(no token) error = %v", err)
	}
	if len(*recorded) != 0 {
		t.Fatalf("失败路径不应触网: %d 次", len(*recorded))
	}
}

func TestDiscoverModelsReportsFailures(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		status     int
		payload    string
		wantErr    error
		wantSubstr string
	}{
		{name: "http 500", status: http.StatusInternalServerError, payload: `{}`, wantSubstr: "500"},
		{name: "malformed json", status: http.StatusOK, payload: `not json`, wantErr: ErrEmptyCatalog},
		{name: "data missing", status: http.StatusOK, payload: `{"code":0}`, wantErr: ErrEmptyCatalog},
		{name: "empty catalog", status: http.StatusOK, payload: `{"data":{"agents":[],"models":[]}}`, wantErr: ErrEmptyCatalog},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			source, _ := newTestSource(t, "workbuddy", func(
				response http.ResponseWriter,
				_ *http.Request,
			) {
				response.WriteHeader(testCase.status)
				_, _ = response.Write([]byte(testCase.payload))
			})
			_, err := source.DiscoverModels(
				context.Background(),
				familyCredential(t, "workbuddy", "tok"),
			)
			if err == nil {
				t.Fatal("DiscoverModels() 应报错")
			}
			if testCase.wantErr != nil && !errors.Is(err, testCase.wantErr) {
				t.Fatalf("error = %v want %v", err, testCase.wantErr)
			}
			if testCase.wantSubstr != "" && !strings.Contains(err.Error(), testCase.wantSubstr) {
				t.Fatalf("error = %v want 包含 %q", err, testCase.wantSubstr)
			}
		})
	}
}

func TestParseConfigModelsIgnoresForeignShapes(t *testing.T) {
	t.Parallel()

	for _, payload := range []string{
		``,
		`[]`,
		`{"data":[]}`,
		`{"data":{"agents":"nope","models":"nope"}}`,
		`{"data":{"agents":[{"name":"cli"}],"models":[{"noId":true}]}}`,
	} {
		if models := ParseConfigModels([]byte(payload)); len(models) != 0 {
			t.Fatalf("ParseConfigModels(%q) = %#v，期望拿不到清单", payload, models)
		}
	}
	// agents 结构损坏时仍可回退站点目录（与 Node 的宽容口径一致）。
	payload := `{"data":{"agents":"broken","models":[{"id":"glm-5.3-flash"}]}}`
	models := ParseConfigModels([]byte(payload))
	if len(models) != 1 || models[0] != "glm-5.3-flash" {
		t.Fatalf("ParseConfigModels(fallback) = %#v", models)
	}
}
