package responses

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

// modelCatalogHTTPClientFunc 让账号模型权限测试直接控制目录传输。
type modelCatalogHTTPClientFunc func(*http.Request) (*http.Response, error)

// Do 实现最小 HTTPClient 端口。
func (client modelCatalogHTTPClientFunc) Do(
	request *http.Request,
) (*http.Response, error) {
	return client(request)
}

// TestAccountModelAvailabilityKeepsSiblingModelRoutable 验证缺少 Sol 不会阻止同账号使用 Terra。
func TestAccountModelAvailabilityKeepsSiblingModelRoutable(t *testing.T) {
	t.Parallel()

	credential := newTestOAuth(t, "workspace-model-sibling", false)
	var calls atomic.Int64
	client := modelCatalogHTTPClientFunc(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		if request.Method != http.MethodGet ||
			request.URL.Path != "/backend-api/codex/models" ||
			request.URL.Query().Get("client_version") != codexProtocolVersion ||
			request.Header.Get("ChatGPT-Account-ID") != "workspace-model-sibling" {
			return nil, errors.New("模型目录请求合同不一致")
		}
		return modelCatalogHTTPResponse(
			http.StatusOK,
			`{"models":[{"slug":"gpt-5.6-terra"}]}`,
		), nil
	})
	source := newModelAvailabilityTestSource(
		t,
		client,
		func() time.Time { return time.Date(2026, 7, 30, 9, 0, 0, 0, time.UTC) },
		modelAvailabilityConfig{ttl: time.Minute, maxEntries: 2, maxConcurrent: 2},
	)

	solAvailable, err := source.CheckAvailability(
		context.Background(),
		modelAvailabilityRoute(t, credential, "gpt-5.6-sol"),
		credential,
	)
	if err != nil || solAvailable {
		t.Fatalf("Sol availability=%t error=%v", solAvailable, err)
	}
	terraAvailable, err := source.CheckAvailability(
		context.Background(),
		modelAvailabilityRoute(t, credential, "gpt-5.6-terra"),
		credential,
	)
	if err != nil || !terraAvailable || calls.Load() != 1 {
		t.Fatalf(
			"Terra availability=%t calls=%d error=%v",
			terraAvailable,
			calls.Load(),
			err,
		)
	}
	t.Logf(
		"account_model_catalog requests=%d sol_available=%t terra_available=%t cooldown_writes=0",
		calls.Load(),
		solAvailable,
		terraAvailable,
	)
}

// TestAccountModelAvailabilityUsesTTLAndLRUEviction 验证目录缓存同时受时间和容量约束。
func TestAccountModelAvailabilityUsesTTLAndLRUEviction(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC)
	var calls atomic.Int64
	source := newModelAvailabilityTestSource(
		t,
		modelCatalogHTTPClientFunc(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return modelCatalogHTTPResponse(
				http.StatusOK,
				`{"object":"list","data":[{"id":"gpt-5.6-sol"}]}`,
			), nil
		}),
		func() time.Time { return now },
		modelAvailabilityConfig{ttl: time.Minute, maxEntries: 2, maxConcurrent: 2},
	)
	credentials := []accountapp.Credential{
		newModelAvailabilityAPIKey(t, 1),
		newModelAvailabilityAPIKey(t, 2),
		newModelAvailabilityAPIKey(t, 3),
	}

	checkModelAvailability(t, source, credentials[0], "gpt-5.6-sol", true)
	checkModelAvailability(t, source, credentials[1], "gpt-5.6-sol", true)
	checkModelAvailability(t, source, credentials[0], "gpt-5.6-sol", true)
	checkModelAvailability(t, source, credentials[2], "gpt-5.6-sol", true)
	checkModelAvailability(t, source, credentials[1], "gpt-5.6-sol", true)
	if calls.Load() != 4 {
		t.Fatalf("LRU catalog requests=%d, want 4", calls.Load())
	}
	now = now.Add(time.Minute)
	checkModelAvailability(t, source, credentials[1], "gpt-5.6-sol", true)
	if calls.Load() != 5 {
		t.Fatalf("expired catalog requests=%d, want 5", calls.Load())
	}
}

// TestAccountModelAvailabilityCoalescesConcurrentAccountLoads 验证同账号并发只发一次目录请求。
func TestAccountModelAvailabilityCoalescesConcurrentAccountLoads(t *testing.T) {
	t.Parallel()

	credential := newTestOAuth(t, "workspace-model-singleflight", false)
	route := modelAvailabilityRoute(t, credential, "gpt-5.6-sol")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var calls atomic.Int64
	source := newModelAvailabilityTestSource(
		t,
		modelCatalogHTTPClientFunc(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			started <- struct{}{}
			<-release
			return modelCatalogHTTPResponse(
				http.StatusOK,
				`{"models":[{"slug":"gpt-5.6-sol"}]}`,
			), nil
		}),
		func() time.Time { return time.Date(2026, 7, 30, 11, 0, 0, 0, time.UTC) },
		modelAvailabilityConfig{ttl: time.Minute, maxEntries: 2, maxConcurrent: 2},
	)

	const callers = 32
	errorsFound := make(chan error, callers)
	var waitGroup sync.WaitGroup
	waitGroup.Add(callers)
	for range callers {
		go func() {
			defer waitGroup.Done()
			available, err := source.CheckAvailability(
				context.Background(),
				route,
				credential,
			)
			if err != nil || !available {
				errorsFound <- fmt.Errorf(
					"availability=%t error=%w",
					available,
					err,
				)
			}
		}()
	}
	<-started
	close(release)
	waitGroup.Wait()
	close(errorsFound)
	for err := range errorsFound {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("concurrent catalog requests=%d, want 1", calls.Load())
	}
}

// TestAccountModelAvailabilityBoundsCrossAccountConcurrency 验证不同账号目录请求服从全局并发上限。
func TestAccountModelAvailabilityBoundsCrossAccountConcurrency(t *testing.T) {
	t.Parallel()

	started := make(chan struct{}, 3)
	release := make(chan struct{}, 3)
	var active atomic.Int64
	var peak atomic.Int64
	client := modelCatalogHTTPClientFunc(func(*http.Request) (*http.Response, error) {
		current := active.Add(1)
		updateAtomicMaximum(&peak, current)
		started <- struct{}{}
		<-release
		active.Add(-1)
		return modelCatalogHTTPResponse(
			http.StatusOK,
			`{"object":"list","data":[{"id":"gpt-5.6-sol"}]}`,
		), nil
	})
	source := newModelAvailabilityTestSource(
		t,
		client,
		func() time.Time { return time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC) },
		modelAvailabilityConfig{ttl: time.Minute, maxEntries: 3, maxConcurrent: 2},
	)
	credentials := []accountapp.Credential{
		newModelAvailabilityAPIKey(t, 11),
		newModelAvailabilityAPIKey(t, 12),
		newModelAvailabilityAPIKey(t, 13),
	}
	routes := make([]runtimecore.ModelRoute, 0, len(credentials))
	for _, credential := range credentials {
		routes = append(
			routes,
			modelAvailabilityRoute(t, credential, "gpt-5.6-sol"),
		)
	}

	errorsFound := make(chan error, len(credentials))
	var waitGroup sync.WaitGroup
	for index, credential := range credentials {
		credential := credential
		route := routes[index]
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			available, err := source.CheckAvailability(
				context.Background(),
				route,
				credential,
			)
			if err != nil || !available {
				errorsFound <- fmt.Errorf(
					"availability=%t error=%w",
					available,
					err,
				)
			}
		}()
	}
	<-started
	<-started
	select {
	case <-started:
		t.Fatal("第三个目录请求越过并发上限")
	case <-time.After(50 * time.Millisecond):
	}
	release <- struct{}{}
	<-started
	release <- struct{}{}
	release <- struct{}{}
	waitGroup.Wait()
	close(errorsFound)
	for err := range errorsFound {
		t.Fatal(err)
	}
	if peak.Load() != 2 {
		t.Fatalf("peak catalog concurrency=%d, want 2", peak.Load())
	}
}

// TestAccountModelAvailabilityDoesNotCacheFailures 验证临时目录错误不会变成错误权限缓存。
func TestAccountModelAvailabilityDoesNotCacheFailures(t *testing.T) {
	t.Parallel()

	credential := newTestOAuth(t, "workspace-model-retry", false)
	var calls atomic.Int64
	source := newModelAvailabilityTestSource(
		t,
		modelCatalogHTTPClientFunc(func(*http.Request) (*http.Response, error) {
			if calls.Add(1) == 1 {
				return modelCatalogHTTPResponse(
					http.StatusServiceUnavailable,
					`{"error":{"type":"overloaded_error"}}`,
				), nil
			}
			return modelCatalogHTTPResponse(
				http.StatusOK,
				`{"models":[{"slug":"gpt-5.6-sol"}]}`,
			), nil
		}),
		func() time.Time { return time.Date(2026, 7, 30, 13, 0, 0, 0, time.UTC) },
		modelAvailabilityConfig{ttl: time.Minute, maxEntries: 2, maxConcurrent: 2},
	)
	route := modelAvailabilityRoute(t, credential, "gpt-5.6-sol")

	available, err := source.CheckAvailability(
		context.Background(),
		route,
		credential,
	)
	if available || !errors.Is(err, ErrModelCatalogUnavailable) {
		t.Fatalf("first availability=%t error=%v", available, err)
	}
	available, err = source.CheckAvailability(
		context.Background(),
		route,
		credential,
	)
	if err != nil || !available || calls.Load() != 2 {
		t.Fatalf(
			"retry availability=%t calls=%d error=%v",
			available,
			calls.Load(),
			err,
		)
	}
}

// TestAccountModelAvailabilityRejectsCrossAccountCredential 验证身份不一致时不会访问模型目录。
func TestAccountModelAvailabilityRejectsCrossAccountCredential(t *testing.T) {
	t.Parallel()

	first := newTestOAuth(t, "workspace-model-first", false)
	second := newTestOAuth(t, "workspace-model-second", false)
	var calls atomic.Int64
	source := newModelAvailabilityTestSource(
		t,
		modelCatalogHTTPClientFunc(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return modelCatalogHTTPResponse(
				http.StatusOK,
				`{"models":[{"slug":"gpt-5.6-sol"}]}`,
			), nil
		}),
		func() time.Time { return time.Date(2026, 7, 30, 14, 0, 0, 0, time.UTC) },
		modelAvailabilityConfig{ttl: time.Minute, maxEntries: 2, maxConcurrent: 2},
	)

	available, err := source.CheckAvailability(
		context.Background(),
		modelAvailabilityRoute(t, first, "gpt-5.6-sol"),
		second,
	)
	if available || !errors.Is(err, ErrInvalidInvocation) || calls.Load() != 0 {
		t.Fatalf(
			"cross-account availability=%t calls=%d error=%v",
			available,
			calls.Load(),
			err,
		)
	}
}

// newModelAvailabilityTestSource 创建使用确定性边界参数的权限源。
func newModelAvailabilityTestSource(
	t *testing.T,
	client HTTPClient,
	clock Clock,
	config modelAvailabilityConfig,
) *AccountModelAvailability {
	t.Helper()

	source, err := newAccountModelAvailability(client, clock, config)
	if err != nil {
		t.Fatalf("newAccountModelAvailability() error = %v", err)
	}
	return source
}

// newModelAvailabilityAPIKey 创建身份彼此隔离的合成 API Key 凭据。
func newModelAvailabilityAPIKey(
	t *testing.T,
	index int,
) *codexauth.APIKeyAuth {
	t.Helper()

	credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey:  fmt.Sprintf("synthetic-model-key-%d", index),
		BaseURL: "https://upstream.example/v1",
	})
	if err != nil {
		t.Fatalf("codexauth.NewAPIKeyAuth() error = %v", err)
	}
	return credential
}

// modelAvailabilityRoute 创建与凭据稳定身份绑定的真实模型路由。
func modelAvailabilityRoute(
	t *testing.T,
	credential accountapp.Credential,
	model string,
) runtimecore.ModelRoute {
	t.Helper()

	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("accountcore.DeriveAccountRef() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(accountRef, model)
	if err != nil {
		t.Fatalf("runtimecore.NewModelRoute() error = %v", err)
	}
	return route
}

// checkModelAvailability 执行一次顺序权限检查并断言结果。
func checkModelAvailability(
	t *testing.T,
	source *AccountModelAvailability,
	credential accountapp.Credential,
	model string,
	expected bool,
) {
	t.Helper()

	available, err := source.CheckAvailability(
		context.Background(),
		modelAvailabilityRoute(t, credential, model),
		credential,
	)
	if err != nil || available != expected {
		t.Fatalf(
			"CheckAvailability(%s)=%t want=%t error=%v",
			model,
			available,
			expected,
			err,
		)
	}
}

// modelCatalogHTTPResponse 创建包含独立正文的目录响应。
func modelCatalogHTTPResponse(status int, payload string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header: http.Header{
			"Content-Type": []string{"application/json; charset=utf-8"},
		},
		Body: io.NopCloser(strings.NewReader(payload)),
	}
}

// updateAtomicMaximum 使用 CAS 记录并发峰值。
func updateAtomicMaximum(maximum *atomic.Int64, candidate int64) {
	for {
		current := maximum.Load()
		if candidate <= current || maximum.CompareAndSwap(current, candidate) {
			return
		}
	}
}
