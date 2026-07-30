package responses

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

// realModelsRoundTripFunc 让模型目录测试在内存中观察 HTTP 请求。
type realModelsRoundTripFunc func(*http.Request) (*http.Response, error)

// RoundTrip 实现 http.RoundTripper。
func (roundTrip realModelsRoundTripFunc) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	return roundTrip(request)
}

// TestBuildRealCodexModelsRequestProjectsOAuthContract 验证 OAuth 目录请求与官方合同一致。
func TestBuildRealCodexModelsRequestProjectsOAuthContract(t *testing.T) {
	request, err := buildRealCodexModelsRequest(
		context.Background(),
		authProjection{
			baseURL:   chatGPTCodexBaseURL,
			token:     "oauth-secret",
			accountID: "workspace-1",
			fedRAMP:   true,
			kind:      codexauth.AuthKindOAuth,
		},
	)
	if err != nil {
		t.Fatalf("buildRealCodexModelsRequest() error = %v", err)
	}
	if request.Method != http.MethodGet ||
		request.URL.String() !=
			"https://chatgpt.com/backend-api/codex/models?client_version=0.145.0" ||
		request.Header.Get("Authorization") != "Bearer oauth-secret" ||
		request.Header.Get("ChatGPT-Account-ID") != "workspace-1" ||
		request.Header.Get("X-OpenAI-Fedramp") != "true" ||
		request.Header.Get("Originator") != codexOriginator ||
		request.Header.Get("User-Agent") != codexUserAgent ||
		request.Header.Get("Version") != codexProtocolVersion ||
		request.Header.Get("Accept") != "application/json" {
		t.Fatalf(
			"模型目录请求合同不一致: method=%s url=%s headers=%v",
			request.Method,
			request.URL.Redacted(),
			request.Header,
		)
	}
}

// TestBuildModelsRequestProjectsAPIKeyContract 验证自定义 API Base URL 只追加一次 models。
func TestBuildModelsRequestProjectsAPIKeyContract(t *testing.T) {
	request, err := buildModelsRequest(
		context.Background(),
		authProjection{
			baseURL: "https://upstream.example/v1",
			token:   "api-key-secret",
			kind:    codexauth.AuthKindAPIKey,
		},
	)
	if err != nil {
		t.Fatalf("buildModelsRequest() error = %v", err)
	}
	if request.Method != http.MethodGet ||
		request.URL.String() != "https://upstream.example/v1/models" ||
		request.Header.Get("Authorization") != "Bearer api-key-secret" ||
		request.Header.Get("ChatGPT-Account-ID") != "" ||
		request.Header.Get("Accept") != "application/json" {
		t.Fatalf(
			"API Key 模型目录请求合同不一致: method=%s url=%s",
			request.Method,
			request.URL.Redacted(),
		)
	}
}

// TestDecodeRealCodexModelCatalogRequiresExactAuthShape 验证两类认证只接受各自目录形状。
func TestDecodeRealCodexModelCatalogRequiresExactAuthShape(t *testing.T) {
	testCases := []struct {
		name     string
		payload  string
		authKind codexauth.AuthKind
		model    string
	}{
		{
			name:     "oauth",
			payload:  `{"models":[{"slug":"gpt-5.6-sol"},{"slug":"gpt-5.6-terra"}]}`,
			authKind: codexauth.AuthKindOAuth,
			model:    "gpt-5.6-sol",
		},
		{
			name:     "api_key",
			payload:  `{"object":"list","data":[{"id":"gpt-5.6-sol"}]}`,
			authKind: codexauth.AuthKindAPIKey,
			model:    "gpt-5.6-sol",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			catalog, err := decodeRealCodexModelCatalog(
				[]byte(testCase.payload),
				testCase.authKind,
			)
			if err != nil {
				t.Fatalf("decodeRealCodexModelCatalog() error = %v", err)
			}
			if catalog.count() == 0 {
				t.Fatal("模型目录不应为空")
			}
			if len(catalog.diagnosticModels()) != catalog.count() {
				t.Fatal("小型模型目录诊断不应截断")
			}
			if err := catalog.require(testCase.model); err != nil {
				t.Fatalf("catalog.require() error = %v", err)
			}
		})
	}
}

// TestClassifyRealCodexModelsMediaTypeIsSafe 验证媒体类型诊断不回显原始响应文本。
func TestClassifyRealCodexModelsMediaTypeIsSafe(t *testing.T) {
	testCases := map[string]string{
		"":                                "missing",
		"invalid media type":              "invalid",
		"text/html; charset=utf-8":        "other",
		"application/json; charset=utf-8": "application/json",
		"application/problem+json":        "application/json",
	}
	for input, expected := range testCases {
		if actual := classifyRealCodexModelsMediaType(input); actual != expected {
			t.Fatalf(
				"classifyRealCodexModelsMediaType(%q) = %q, want %q",
				input,
				actual,
				expected,
			)
		}
	}
}

// TestDecodeRealCodexModelCatalogRejectsAmbiguousOrDuplicateModels 验证异常目录失败关闭。
func TestDecodeRealCodexModelCatalogRejectsAmbiguousOrDuplicateModels(
	t *testing.T,
) {
	payloads := []string{
		`{}`,
		`{"models":[]}`,
		`{"models":[{"slug":"gpt-5.6-sol"}],"data":[]}`,
		`{"models":[{"slug":"gpt-5.6-sol"},{"slug":"gpt-5.6-sol"}]}`,
		`{"models":[{"slug":" bad"}]}`,
		`{"models":[{"slug":"gpt-5.6-sol"}]} trailing`,
	}
	for _, payload := range payloads {
		if _, err := decodeRealCodexModelCatalog(
			[]byte(payload),
			codexauth.AuthKindOAuth,
		); !errors.Is(err, errInvalidRealCodexModels) {
			t.Fatalf(
				"decodeRealCodexModelCatalog(%q) error = %v",
				payload,
				err,
			)
		}
	}
}

// TestFetchRealCodexModelCatalogChecksBeforeInference 验证目录检查使用独立 GET 请求。
func TestFetchRealCodexModelCatalogChecksBeforeInference(t *testing.T) {
	client := &http.Client{
		Transport: realModelsRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodGet ||
				request.URL.Path != "/backend-api/codex/models" {
				t.Fatalf(
					"模型目录预检请求不一致: %s %s",
					request.Method,
					request.URL.Redacted(),
				)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header: http.Header{
					"Content-Type": []string{"application/json"},
				},
				Body: io.NopCloser(strings.NewReader(
					`{"models":[{"slug":"gpt-5.6-sol"}]}`,
				)),
			}, nil
		}),
	}
	catalog, err := fetchRealCodexModelCatalog(
		context.Background(),
		client,
		newTestOAuth(t, "workspace-catalog", false),
	)
	if err != nil {
		t.Fatalf("fetchRealCodexModelCatalog() error = %v", err)
	}
	if err := catalog.require("gpt-5.6-sol"); err != nil {
		t.Fatalf("catalog.require(gpt-5.6-sol) error = %v", err)
	}
	if err := catalog.require("gpt-5.6-luna"); !errors.Is(
		err,
		errRealCodexModelUnavailable,
	) {
		t.Fatalf("catalog.require(gpt-5.6-luna) error = %v", err)
	}
}
