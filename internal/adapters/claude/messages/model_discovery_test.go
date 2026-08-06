package messages_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
)

// 合成凭据只用于本用例，格式与官方一致但不属于任何真实账号。
const (
	discoverySyntheticAccessToken  = "sk-ant-oat01-synthetic-discovery-access"
	discoverySyntheticRefreshToken = "sk-ant-ort01-synthetic-discovery-refresh"
	discoverySyntheticAccountUUID  = "123e4567-e89b-12d3-a456-426614174333"
	discoverySyntheticAPIKey       = "sk-ant-api03-synthetic-discovery-key"
)

// TestDiscoverModelsReadsFullPagedCatalog 验证账号导入拿到的是完整分页目录，
// 并且订阅 OAuth 按官方合同发送 Bearer 与 OAuth beta 头。
func TestDiscoverModelsReadsFullPagedCatalog(t *testing.T) {
	t.Parallel()

	client := &recordingCatalogClient{
		responses: []catalogResponse{
			{
				status: http.StatusOK,
				body: `{"data":[{"id":"claude-opus-5"},{"id":"claude-sonnet-5"}],` +
					`"has_more":true,"first_id":"claude-opus-5","last_id":"claude-sonnet-5"}`,
			},
			{
				status: http.StatusOK,
				body: `{"data":[{"id":"claude-haiku-5"}],"has_more":false,` +
					`"first_id":"claude-haiku-5","last_id":"claude-haiku-5"}`,
			},
		},
	}
	source, err := claudemessages.NewModelCatalogSource(client)
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}

	models, err := source.DiscoverModels(
		context.Background(),
		syntheticClaudeOAuth(t),
	)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	expected := []string{"claude-haiku-5", "claude-opus-5", "claude-sonnet-5"}
	if len(models) != len(expected) {
		t.Fatalf("models = %v", models)
	}
	for index, model := range expected {
		if models[index] != model {
			t.Fatalf("models = %v", models)
		}
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests = %d", len(client.requests))
	}
	first := client.requests[0]
	if first.Method != http.MethodGet ||
		first.URL.Host != "api.anthropic.com" ||
		first.URL.Path != "/v1/models" ||
		first.URL.Query().Get("limit") != "100" ||
		first.URL.Query().Has("after_id") {
		t.Fatalf("first_request = %s %s", first.Method, first.URL)
	}
	if first.Header.Get("Authorization") != "Bearer "+discoverySyntheticAccessToken ||
		first.Header.Get("anthropic-version") == "" ||
		first.Header.Get("anthropic-beta") == "" ||
		first.Header.Get("x-api-key") != "" {
		t.Fatal("订阅 OAuth 目录请求未按官方认证合同构造")
	}
	// 第二页必须沿用上一页游标，不允许重复拉取首页。
	if client.requests[1].URL.Query().Get("after_id") != "claude-sonnet-5" {
		t.Fatalf("second_request = %s", client.requests[1].URL)
	}
}

// TestDiscoverModelsProjectsAPIKeyAuth 验证 API Key 账号走 x-api-key，
// 且不携带只属于 OAuth 的 beta 头。
func TestDiscoverModelsProjectsAPIKeyAuth(t *testing.T) {
	t.Parallel()

	client := &recordingCatalogClient{
		responses: []catalogResponse{{
			status: http.StatusOK,
			body: `{"data":[{"id":"claude-opus-5"}],"has_more":false,` +
				`"first_id":"claude-opus-5","last_id":"claude-opus-5"}`,
		}},
	}
	source, err := claudemessages.NewModelCatalogSource(client)
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}
	credential, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey:  discoverySyntheticAPIKey,
		BaseURL: "https://api.anthropic.com",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}

	if _, err := source.DiscoverModels(context.Background(), credential); err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	request := client.requests[0]
	if request.Header.Get("x-api-key") != discoverySyntheticAPIKey ||
		request.Header.Get("Authorization") != "" ||
		request.Header.Get("anthropic-beta") != "" {
		t.Fatal("API Key 目录请求未按官方认证合同构造")
	}
}

// TestDiscoverModelsReportsUpstreamStatus 验证目录失败必须暴露 HTTP 状态码，
// 否则账号导入失败时无法区分鉴权、限流与上游故障；错误链不得带上游正文。
func TestDiscoverModelsReportsUpstreamStatus(t *testing.T) {
	t.Parallel()

	secret := "authentication_error: 请求正文不得进入错误链"
	for _, status := range []int{
		http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusTooManyRequests,
		http.StatusBadGateway,
	} {
		client := &recordingCatalogClient{
			responses: []catalogResponse{{status: status, body: secret}},
		}
		source, err := claudemessages.NewModelCatalogSource(client)
		if err != nil {
			t.Fatalf("NewModelCatalogSource() error = %v", err)
		}

		_, err = source.DiscoverModels(
			context.Background(),
			syntheticClaudeOAuth(t),
		)
		if !errors.Is(err, claudemessages.ErrModelCatalogUnavailable) {
			t.Fatalf("status %d error = %v", status, err)
		}
		if !strings.Contains(err.Error(), "status="+strconv.Itoa(status)) {
			t.Fatalf("status %d 未出现在错误文本: %v", status, err)
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("status %d 错误链泄露了上游正文", status)
		}
	}
}

// TestDiscoverModelsRejectsNonJSONCatalog 验证非 JSON 响应按无效目录处理，
// 只暴露分类后的媒体类型。
func TestDiscoverModelsRejectsNonJSONCatalog(t *testing.T) {
	t.Parallel()

	client := &recordingCatalogClient{
		responses: []catalogResponse{{
			status:      http.StatusOK,
			contentType: "text/html; charset=utf-8",
			body:        "<html>captive portal</html>",
		}},
	}
	source, err := claudemessages.NewModelCatalogSource(client)
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}

	_, err = source.DiscoverModels(context.Background(), syntheticClaudeOAuth(t))
	if !errors.Is(err, claudemessages.ErrInvalidModelCatalog) ||
		!strings.Contains(err.Error(), "media_type=other") ||
		strings.Contains(err.Error(), "captive portal") {
		t.Fatalf("error = %v", err)
	}
}

// syntheticClaudeOAuth 构造合成订阅 OAuth 凭据，不读取任何真实登录态。
func syntheticClaudeOAuth(t *testing.T) *claudeauth.OAuthAuth {
	t.Helper()

	credential, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  discoverySyntheticAccessToken,
		RefreshToken: discoverySyntheticRefreshToken,
		ExpiresAtMS:  4102444800000,
		Scopes:       []string{"user:inference", "user:profile"},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: discoverySyntheticAccountUUID,
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return credential
}

// catalogResponse 描述一次目录响应，默认按 JSON 媒体类型返回。
type catalogResponse struct {
	status      int
	contentType string
	body        string
}

// recordingCatalogClient 按序回放目录响应并保留实际请求供合同断言。
type recordingCatalogClient struct {
	responses []catalogResponse
	requests  []*http.Request
}

// Do 记录请求并返回下一条预置响应。
func (client *recordingCatalogClient) Do(
	request *http.Request,
) (*http.Response, error) {
	client.requests = append(client.requests, request)
	if len(client.responses) == 0 {
		return nil, errors.New("目录响应已耗尽")
	}
	response := client.responses[0]
	client.responses = client.responses[1:]
	contentType := response.contentType
	if contentType == "" {
		contentType = "application/json"
	}
	return &http.Response{
		StatusCode: response.status,
		Header:     http.Header{"Content-Type": []string{contentType}},
		Body:       io.NopCloser(strings.NewReader(response.body)),
	}, nil
}
