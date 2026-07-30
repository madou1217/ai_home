package usage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// TestStrategyReadsDirectWhamUsageWithoutStdioWorker 验证直连端点、Header 和秒级窗口归一化。
func TestStrategyReadsDirectWhamUsageWithoutStdioWorker(t *testing.T) {
	t.Parallel()

	auth := newCodexUsageOAuth(t)
	accountRef := deriveCodexUsageRef(t, auth)
	capturedAt := time.Date(2026, time.July, 31, 3, 0, 0, 0, time.UTC)
	client := &codexUsageClient{
		response: `{
			"rate_limit": {
				"primary_window": {
					"used_percent": 20,
					"limit_window_seconds": 18000,
					"reset_after_seconds": 3600
				},
				"secondary_window": {
					"used_percent": 100,
					"limit_window_seconds": 604800,
					"reset_at": 1785466800
				}
			}
		}`,
	}
	strategy, err := New(client)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
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
	if len(entries) != 2 ||
		entries[0].Bucket() != "primary" ||
		entries[1].Bucket() != "secondary" ||
		entries[1].Availability() != usagecore.AvailabilityExhausted {
		t.Fatalf("entries = %#v", entries)
	}
	remaining, known := entries[0].RemainingBasisPoints()
	if !known ||
		remaining != 8_000 ||
		entries[0].WindowSeconds() != 18_000 ||
		!entries[0].ResetAt().Equal(capturedAt.Add(time.Hour)) {
		t.Fatalf("primary = %#v", entries[0])
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.request == nil ||
		client.request.URL.String() != usageEndpoint ||
		client.request.Method != http.MethodGet ||
		client.request.Header.Get("Authorization") != "Bearer "+auth.AccessToken() ||
		client.request.Header.Get("ChatGPT-Account-ID") != auth.UpstreamAccountID() ||
		client.request.Header.Get("Originator") != codexClientIdentity {
		t.Fatalf("request = %#v", client.request)
	}
}

// TestStrategyPrefersMultiLimitViewAndPreservesCredits 验证多 limit 视图不会与兼容单视图重复。
func TestStrategyPrefersMultiLimitViewAndPreservesCredits(t *testing.T) {
	t.Parallel()

	auth := newCodexUsageOAuth(t)
	accountRef := deriveCodexUsageRef(t, auth)
	client := &codexUsageClient{
		response: `{
			"rateLimits": {
				"primary": {"usedPercent": 10}
			},
			"rateLimitsByLimitId": {
				"codex": {
					"limitName": "Codex",
					"primary": {
						"usedPercent": 25,
						"windowDurationMins": 300,
						"resetsAt": 1785466800
					},
					"credits": {
						"hasCredits": false,
						"unlimited": false,
						"balance": null
					},
					"rateLimitReachedType": "workspace_member_credits_depleted"
				}
			}
		}`,
	}
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
	entries := snapshot.Entries()
	if len(entries) != 3 ||
		entries[0].Bucket() != "credits" ||
		entries[1].Bucket() != "primary" ||
		entries[2].Bucket() != "rate_limit_reached" {
		t.Fatalf("multi-limit entries = %#v", entries)
	}
	for _, entry := range entries {
		if entry.LimitID() != "codex" || entry.LimitName() != "Codex" {
			t.Fatalf("limit metadata lost: %#v", entry)
		}
	}
}

// TestStrategyPreservesDirectLimitReached 验证 wham 明确阻塞在缺少数值窗口时仍是权威耗尽。
func TestStrategyPreservesDirectLimitReached(t *testing.T) {
	t.Parallel()

	auth := newCodexUsageOAuth(t)
	accountRef := deriveCodexUsageRef(t, auth)
	strategy, _ := New(&codexUsageClient{
		response: `{"rate_limit":{"limit_reached":true}}`,
	})
	snapshot, err := strategy.FetchUsage(
		context.Background(),
		accountRef,
		auth,
		time.Date(2026, time.July, 31, 3, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("FetchUsage() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 ||
		entries[0].Bucket() != "rate_limit_reached" ||
		entries[0].Availability() != usagecore.AvailabilityExhausted {
		t.Fatalf("entries = %#v", entries)
	}
	if _, known := entries[0].RemainingBasisPoints(); known {
		t.Fatal("limit_reached 不应伪造剩余比例")
	}
}

// TestStrategyPreservesUnknownOfficialUsage 验证缺少百分比不会被伪造成零使用量。
func TestStrategyPreservesUnknownOfficialUsage(t *testing.T) {
	t.Parallel()

	auth := newCodexUsageOAuth(t)
	accountRef := deriveCodexUsageRef(t, auth)
	strategy, _ := New(&codexUsageClient{
		response: `{"rateLimits":{"primary":{}}}`,
	})
	snapshot, err := strategy.FetchUsage(
		context.Background(),
		accountRef,
		auth,
		time.Date(2026, time.July, 31, 3, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("FetchUsage() error = %v", err)
	}
	entry := snapshot.Entries()[0]
	if entry.Availability() != usagecore.AvailabilityUnknown {
		t.Fatalf("primary availability = %q", entry.Availability())
	}
	if _, known := entry.RemainingBasisPoints(); known {
		t.Fatal("缺少 usedPercent 时不应伪造剩余比例")
	}
}

// TestStrategyRejectsInvalidOfficialAndDurationFields 验证异常字段不能静默降级。
func TestStrategyRejectsInvalidOfficialAndDurationFields(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		response string
	}{
		{
			name: "official minutes",
			response: `{
				"rateLimits": {
					"primary": {
						"usedPercent": 10,
						"windowDurationMins": 9223372036854775807
					}
				}
			}`,
		},
		{
			name: "legacy minutes",
			response: `{
				"rate_limits": {
					"primary": {
						"used_percent": 10,
						"window_minutes": 9223372036854775807
					}
				}
			}`,
		},
		{
			name: "direct reset after seconds",
			response: `{
				"rate_limit": {
					"primary_window": {
						"used_percent": 10,
						"reset_after_seconds": 9223372036854775807
					}
				}
			}`,
		},
		{
			name: "incomplete credits",
			response: `{
				"rateLimits": {
					"credits": {}
				}
			}`,
		},
		{
			name: "mismatched limit id",
			response: `{
				"rateLimitsByLimitId": {
					"codex": {
						"limitId": "other",
						"primary": {"usedPercent": 10}
					}
				}
			}`,
		},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			auth := newCodexUsageOAuth(t)
			accountRef := deriveCodexUsageRef(t, auth)
			strategy, _ := New(&codexUsageClient{
				response: testCase.response,
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
		})
	}
}

// TestStrategyRejectsNilHTTPResponse 验证异常传输不能触发空指针。
func TestStrategyRejectsNilHTTPResponse(t *testing.T) {
	t.Parallel()

	auth := newCodexUsageOAuth(t)
	accountRef := deriveCodexUsageRef(t, auth)
	strategy, _ := New(nilCodexUsageClient{})
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

// TestStrategyRejectsAPIKeyWithoutCallingUpstream 验证无可信额度接口的 API Key 显式 unsupported。
func TestStrategyRejectsAPIKeyWithoutCallingUpstream(t *testing.T) {
	t.Parallel()

	auth, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey: "synthetic-codex-usage-api-key",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	accountRef := deriveCodexUsageRef(t, auth)
	client := &codexUsageClient{response: `{}`}
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

// codexUsageClient 返回合成 JSON 并保留请求副本。
type codexUsageClient struct {
	mu       sync.Mutex
	response string
	request  *http.Request
}

func (client *codexUsageClient) Do(
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

// nilCodexUsageClient 模拟违反 net/http 返回约定的异常传输。
type nilCodexUsageClient struct{}

// Do 返回空响应，验证 Strategy 在适配器边界失败关闭。
func (nilCodexUsageClient) Do(*http.Request) (*http.Response, error) {
	return nil, nil
}

// newCodexUsageOAuth 创建不包含真实凭据的工作区 OAuth。
func newCodexUsageOAuth(t *testing.T) *codexauth.OAuthAuth {
	t.Helper()

	auth, err := codexauth.NewOAuthAuth(codexauth.OAuthInput{
		AccessToken:  buildUsageJWT(t, map[string]any{"exp": 2_000_000_000}),
		RefreshToken: "synthetic-codex-refresh",
		IDToken: buildUsageJWT(t, map[string]any{
			"sub": "usage-user",
			"https://api.openai.com/auth": map[string]any{
				"chatgpt_account_id": "usage-workspace",
			},
		}),
		RefreshedAtMS: 1_800_000_000_000,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

// buildUsageJWT 构造只供领域解析的无签名合成 JWT。
func buildUsageJWT(t *testing.T, claims map[string]any) string {
	t.Helper()

	header, err := json.Marshal(map[string]string{"alg": "none"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal(claims) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// deriveCodexUsageRef 从领域凭据生成测试账号引用。
func deriveCodexUsageRef(
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
