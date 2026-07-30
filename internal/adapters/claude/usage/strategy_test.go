package usage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// TestStrategyParsesAllClaudeUsageDimensions 验证账号级、模型族级和 extra usage 完整归一化。
func TestStrategyParsesAllClaudeUsageDimensions(t *testing.T) {
	t.Parallel()

	auth := newClaudeUsageOAuth(t)
	accountRef := deriveClaudeUsageRef(t, auth)
	client := &claudeUsageClient{response: `{
		"five_hour": {
			"utilization": 12.5,
			"resets_at": "2026-07-31T08:00:00Z"
		},
		"seven_day": {
			"utilization": 40,
			"resets_at": "2026-08-07T03:00:00Z"
		},
		"seven_day_oauth_apps": {
			"utilization": null,
			"resets_at": null
		},
		"seven_day_opus": {
			"utilization": 100,
			"resets_at": "2026-08-07T03:00:00Z"
		},
		"seven_day_sonnet": {
			"utilization": 25,
			"resets_at": "2026-08-07T03:00:00Z"
		},
		"extra_usage": {
			"is_enabled": true,
			"monthly_limit": 100,
			"used_credits": 20,
			"utilization": 20
		}
	}`}
	strategy, err := New(client)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	capturedAt := time.Date(2026, time.July, 31, 3, 0, 0, 0, time.UTC)
	snapshot, err := strategy.FetchUsage(
		context.Background(),
		accountRef,
		auth,
		capturedAt,
	)
	if err != nil {
		t.Fatalf("FetchUsage() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 6 {
		t.Fatalf("entries count = %d, want 6", len(entries))
	}
	byBucket := make(map[string]usagecore.Entry, len(entries))
	for _, entry := range entries {
		byBucket[entry.Bucket()] = entry
	}
	opus := byBucket["seven_day_opus"]
	if opus.Scope() != usagecore.ScopeModelFamily ||
		opus.ScopeKey() != "opus" ||
		opus.Availability() != usagecore.AvailabilityExhausted {
		t.Fatalf("opus = %#v", opus)
	}
	fiveHourRemaining, known := byBucket["five_hour"].RemainingBasisPoints()
	if !known || fiveHourRemaining != 8_750 {
		t.Fatalf(
			"five_hour remaining=(%d,%t)",
			fiveHourRemaining,
			known,
		)
	}
	extraRemaining, known := byBucket["extra_usage"].RemainingBasisPoints()
	if !known ||
		extraRemaining != 8_000 ||
		byBucket["extra_usage"].Kind() != usagecore.KindCredits {
		t.Fatalf("extra_usage = %#v", byBucket["extra_usage"])
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.request == nil ||
		client.request.URL.String() != officialBaseURL+usagePath ||
		client.request.Header.Get("Authorization") != "Bearer "+auth.AccessToken() ||
		client.request.Header.Get("Anthropic-Beta") != oauthBeta {
		t.Fatalf("request = %#v", client.request)
	}
}

// TestStrategySupportsLongLivedBearerAndMatchesModelFamilies 验证 setup-token 端点和模型族映射。
func TestStrategySupportsLongLivedBearerAndMatchesModelFamilies(t *testing.T) {
	t.Parallel()

	auth, err := claudeauth.NewOAuthTokenAuth(claudeauth.OAuthTokenInput{
		AccessToken: "synthetic-claude-oauth-token",
		BaseURL:     "https://claude-proxy.example.invalid/root",
	})
	if err != nil {
		t.Fatalf("NewOAuthTokenAuth() error = %v", err)
	}
	accountRef := deriveClaudeUsageRef(t, auth)
	client := &claudeUsageClient{response: `{
		"extra_usage": {
			"is_enabled": true,
			"monthly_limit": null,
			"used_credits": null,
			"utilization": null
		}
	}`}
	strategy, _ := New(client)
	snapshot, err := strategy.FetchUsage(
		context.Background(),
		accountRef,
		auth,
		time.Date(2026, time.July, 31, 3, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("FetchUsage() error = %v", err)
	}
	if snapshot.Entries()[0].Availability() != usagecore.AvailabilityUnlimited {
		t.Fatalf("extra usage = %#v", snapshot.Entries()[0])
	}
	opus, _ := runtimecore.NewModelID("claude-opus-5")
	sonnet, _ := runtimecore.NewModelID("claude-sonnet-4-6")
	if !strategy.MatchesModelFamily("opus", opus) ||
		strategy.MatchesModelFamily("opus", sonnet) ||
		!strategy.MatchesModelFamily("sonnet", sonnet) {
		t.Fatal("Claude 模型族匹配错误")
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.request.URL.String() !=
		"https://claude-proxy.example.invalid/root"+usagePath {
		t.Fatalf("custom usage URL = %s", client.request.URL)
	}
}

// TestStrategyRejectsIncompleteExtraUsage 验证缺少启用事实不能被伪造成 disabled。
func TestStrategyRejectsIncompleteExtraUsage(t *testing.T) {
	t.Parallel()

	auth := newClaudeUsageOAuth(t)
	accountRef := deriveClaudeUsageRef(t, auth)
	strategy, _ := New(&claudeUsageClient{
		response: `{"extra_usage":{"monthly_limit":100}}`,
	})
	_, err := strategy.FetchUsage(
		context.Background(),
		accountRef,
		auth,
		time.Date(2026, time.July, 31, 3, 0, 0, 0, time.UTC),
	)
	if !errors.Is(err, usageapp.ErrRefreshFailed) ||
		!errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("FetchUsage() error = %v", err)
	}
}

// TestStrategyRejectsNilHTTPResponse 验证异常传输不能触发空指针。
func TestStrategyRejectsNilHTTPResponse(t *testing.T) {
	t.Parallel()

	auth := newClaudeUsageOAuth(t)
	accountRef := deriveClaudeUsageRef(t, auth)
	strategy, _ := New(nilClaudeUsageClient{})
	_, err := strategy.FetchUsage(
		context.Background(),
		accountRef,
		auth,
		time.Date(2026, time.July, 31, 3, 0, 0, 0, time.UTC),
	)
	if !errors.Is(err, usageapp.ErrRefreshFailed) ||
		!errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("FetchUsage() error = %v", err)
	}
}

// TestStrategyRejectsClaudeAPIKeyWithoutCallingUpstream 验证 API Key 明确 unsupported。
func TestStrategyRejectsClaudeAPIKeyWithoutCallingUpstream(t *testing.T) {
	t.Parallel()

	auth, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey: "synthetic-claude-usage-api-key",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	accountRef := deriveClaudeUsageRef(t, auth)
	client := &claudeUsageClient{response: `{}`}
	strategy, _ := New(client)
	_, err = strategy.FetchUsage(
		context.Background(),
		accountRef,
		auth,
		time.Now(),
	)
	if !errors.Is(err, usageapp.ErrUsageUnsupported) {
		t.Fatalf("FetchUsage(API key) error = %v", err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.request != nil {
		t.Fatal("API Key usage unexpectedly called upstream")
	}
}

// claudeUsageClient 返回合成 JSON 并保留请求副本。
type claudeUsageClient struct {
	mu       sync.Mutex
	response string
	request  *http.Request
}

func (client *claudeUsageClient) Do(
	request *http.Request,
) (*http.Response, error) {
	client.mu.Lock()
	client.request = request.Clone(request.Context())
	client.mu.Unlock()
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(client.response)),
	}, nil
}

// nilClaudeUsageClient 模拟违反 net/http 返回约定的异常传输。
type nilClaudeUsageClient struct{}

// Do 返回空响应，验证 Strategy 在适配器边界失败关闭。
func (nilClaudeUsageClient) Do(*http.Request) (*http.Response, error) {
	return nil, nil
}

// newClaudeUsageOAuth 创建不包含真实凭据的可刷新 OAuth。
func newClaudeUsageOAuth(t *testing.T) *claudeauth.OAuthAuth {
	t.Helper()

	auth, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "synthetic-claude-usage-access",
		RefreshToken: "synthetic-claude-usage-refresh",
		ExpiresAtMS:  1_900_000_000_000,
		Scopes:       []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174444",
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

// deriveClaudeUsageRef 从领域凭据生成测试账号引用。
func deriveClaudeUsageRef(
	t *testing.T,
	auth accountcore.IdentitySource,
) accountcore.AccountRef {
	t.Helper()

	accountRef, err := accountcore.DeriveAccountRef(auth)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	return accountRef
}
