package aihserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	clinemodelcatalog "github.com/madou1217/ai_home/internal/adapters/cline/modelcatalog"
)

func testProviderCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

// 覆盖守卫：目录源注册表与刷新队列必须一一覆盖 Provider Catalog。
//
// 漏登记的两种形态都是静默的：
//   - 有 Catalog、没有目录源 → 该 Provider 的账号永远没有 account_models；
//   - 有目录源、没有刷新队列 → 周期重扫/首次恢复不会入队，目录永远为空。
//
// 之前正是靠手工维护两份名单，cline 出现过「账号在池里、目录为空」。
func TestModelProviderSourcesCoverEveryCatalogProvider(t *testing.T) {
	catalog := testProviderCatalog(t)
	// 目录源构造只持有依赖，不发请求；给真实客户端即可（本用例不出网）。
	sources, err := buildModelProviderSources(modelProviderContext{
		client:        &http.Client{},
		codexVersions: clientversion.Static("test-version"),
	})
	if err != nil {
		t.Fatalf("buildModelProviderSources() error = %v", err)
	}
	// NewModelDiscovery 会校验每条源的 Provider 规范且不重复，等于顺带守住「注册表里
	// 不能出现 Catalog 之外的 Provider」。
	discovery, err := accountapp.NewModelDiscovery(catalog, sources)
	if err != nil {
		t.Fatalf("NewModelDiscovery() error = %v", err)
	}
	registered := discovery.ProviderIDs()
	if len(registered) == 0 {
		t.Fatal("目录源注册表为空")
	}
	registeredSet := make(map[string]bool, len(registered))
	for _, providerID := range registered {
		registeredSet[providerID] = true
	}
	queues := modelRefreshProviderConcurrency(registered)
	var missingSource []string
	var missingQueue []string
	for _, definition := range catalog.List() {
		if !registeredSet[definition.ID] {
			missingSource = append(missingSource, definition.ID)
		}
		if queues[definition.ID] != modelRefreshConcurrency {
			missingQueue = append(missingQueue, definition.ID)
		}
	}
	sort.Strings(missingSource)
	sort.Strings(missingQueue)
	if len(missingSource) > 0 {
		t.Fatalf("这些 Provider 没有模型目录源（账号目录会永远为空）: %v", missingSource)
	}
	if len(missingQueue) > 0 {
		t.Fatalf("这些 Provider 没有模型刷新队列（周期重扫不会入队）: %v", missingQueue)
	}
}

// cline 的目录是静态清单：不联网、不依赖客户端。
//
// 装配上下文故意不给 HTTP 客户端与版本源——静态源若偷偷出网，这里会直接失败。
func TestClineModelSourceIsStatic(t *testing.T) {
	sources, err := buildClineModelProvider(modelProviderContext{})
	if err != nil {
		t.Fatalf("buildClineModelProvider() error = %v", err)
	}
	if len(sources) != 1 {
		t.Fatalf("cline 目录源数 = %d, want 1", len(sources))
	}
	source := sources[0]
	if source.ProviderID() != "cline" {
		t.Fatalf("ProviderID() = %q, want cline", source.ProviderID())
	}
	identity, err := accountcore.NewNativeSubjectIdentity("cline", "user_test")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{}}`))
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), credential)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != len(clinemodelcatalog.KnownModels) {
		t.Fatalf("模型数 = %d, want %d", len(models), len(clinemodelcatalog.KnownModels))
	}
	for index, want := range clinemodelcatalog.KnownModels {
		if models[index] != want {
			t.Fatalf("models[%d] = %q, want %q", index, models[index], want)
		}
	}
}

// testServerTransport 把所有出站请求重写到 httptest 服务，保留路径与请求头。
// agy 的 token/code-assist 端点是编译期常量，测试不能改 base URL，只能在这一层接管。
type testServerTransport struct {
	target *url.URL
}

func (transport testServerTransport) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.URL.Scheme = transport.target.Scheme
	clone.URL.Host = transport.target.Host
	clone.Host = transport.target.Host
	return http.DefaultTransport.RoundTrip(clone)
}

// memoryCredentialStore 提供 resolver 需要的版本化读写，按 CAS 语义替换快照。
type memoryCredentialStore struct {
	mu       sync.Mutex
	snapshot accountapp.CredentialSnapshot
}

func (store *memoryCredentialStore) GetCredentialSnapshot(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.snapshot.AccountRef() != accountRef {
		return accountapp.CredentialSnapshot{}, accountapp.ErrCredentialNotFound
	}
	return store.snapshot, nil
}

func (store *memoryCredentialStore) ReplaceCredential(
	_ context.Context,
	replacement accountapp.CredentialReplacement,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.snapshot.UpdatedAt().Equal(replacement.ExpectedUpdatedAt()) {
		return accountapp.ErrCredentialConflict
	}
	next, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		replacement.Credential().ProviderID(),
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return err
	}
	store.snapshot = next
	return nil
}

// neverRefreshStrategy 让 resolver 能读取其他 Provider，同时验证 agy 没有策略时的兜底。
type neverRefreshStrategy struct{}

func (neverRefreshStrategy) ProviderID() string { return "gemini" }

func (neverRefreshStrategy) ExpiresAt(
	accountapp.Credential,
) (time.Time, bool) {
	return time.Time{}, false
}

func (neverRefreshStrategy) Refresh(
	context.Context,
	accountapp.Credential,
	time.Time,
) (accountapp.Credential, error) {
	return nil, errors.New("不应调用刷新")
}

func expiredAgyCredential(
	t *testing.T,
	now time.Time,
	accessToken string,
	refreshToken string,
) *agy.OAuthAuth {
	t.Helper()
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "user@example.com",
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		ExpiresAtMS:   now.Add(-time.Minute).UnixMilli(),
		RefreshedAtMS: now.Add(-time.Hour).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

// TestModelDiscoveryRefreshesExpiredAgyCredential 复现真机 401：模型发现拿到过期
// access token 直接打 loadCodeAssist。修复后必须先走 resolver 刷新，再用新 token 发现。
func TestModelDiscoveryRefreshesExpiredAgyCredential(t *testing.T) {
	const (
		expiredToken = "expired-access"
		freshToken   = "fresh-access"
		refreshToken = "refresh-1"
	)
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	codeAssistAuth := make([]string, 0, 2)
	tokenRefreshes := 0

	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/token":
			if err := request.ParseForm(); err != nil {
				t.Errorf("token 请求解析失败: %v", err)
				http.Error(writer, "bad form", http.StatusBadRequest)
				return
			}
			if got := request.Form.Get("refresh_token"); got != refreshToken {
				t.Errorf("refresh_token = %q, want %q", got, refreshToken)
			}
			mu.Lock()
			tokenRefreshes++
			mu.Unlock()
			_, _ = writer.Write([]byte(
				`{"access_token":"` + freshToken + `","expires_in":3600,"token_type":"Bearer"}`,
			))
		case "/v1internal:loadCodeAssist",
			"/v1internal:fetchAvailableModels":
			authorization := request.Header.Get("Authorization")
			mu.Lock()
			codeAssistAuth = append(codeAssistAuth, authorization)
			mu.Unlock()
			if authorization != "Bearer "+freshToken {
				t.Errorf("code-assist Authorization = %q, want 新 token", authorization)
			}
			if strings.HasSuffix(request.URL.Path, "loadCodeAssist") {
				_, _ = writer.Write([]byte(`{"cloudaicompanionProject":"proj-test"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"models":{"gemini-3-pro":{}}}`))
		default:
			t.Errorf("未预期的上游路径: %s", request.URL.Path)
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("解析测试服务地址失败: %v", err)
	}
	client := &http.Client{Transport: testServerTransport{target: target}}
	auth := expiredAgyCredential(t, now, expiredToken, refreshToken)
	accountRef, err := accountcore.DeriveAccountRef(auth)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	initial, err := accountapp.NewCredentialSnapshot(
		accountRef,
		agy.ProviderID,
		auth,
		now.Add(-time.Hour),
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	store := &memoryCredentialStore{snapshot: initial}
	provider, err := agyoauth.New(client)
	if err != nil {
		t.Fatalf("agyoauth.New() error = %v", err)
	}
	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:      store,
		Strategies: []accountcredentials.RefreshStrategy{provider},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}

	refreshed, err := (credentialSnapshots{resolver: resolver, store: store}).
		RefreshCredential(context.Background(), initial)
	if err != nil {
		t.Fatalf("RefreshCredential() error = %v", err)
	}
	refreshedAuth, valid := refreshed.Credential().(*agy.OAuthAuth)
	if !valid || refreshedAuth.AccessToken() != freshToken {
		t.Fatalf("刷新后 access token 未更新")
	}

	source, err := agycodeassist.NewModelCatalogSource(client)
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), refreshed.Credential())
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 || models[0] != "gemini-3-pro" {
		t.Fatalf("models = %v, want [gemini-3-pro]", models)
	}
	mu.Lock()
	defer mu.Unlock()
	if tokenRefreshes != 1 {
		t.Fatalf("token 刷新次数 = %d, want 1", tokenRefreshes)
	}
	if len(codeAssistAuth) != 2 {
		t.Fatalf("code-assist 请求数 = %d, want 2", len(codeAssistAuth))
	}
}

// TestModelCredentialRefreshWithoutStrategyKeepsSnapshot 守住无刷新策略的 Provider
// （例如 opencode 静态凭据）：模型发现不能因为缺少策略就拒绝探测。
func TestModelCredentialRefreshWithoutStrategyKeepsSnapshot(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	const expiredToken = "expired-access"
	auth := expiredAgyCredential(t, now, expiredToken, "refresh-1")
	accountRef, err := accountcore.DeriveAccountRef(auth)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	initial, err := accountapp.NewCredentialSnapshot(
		accountRef,
		agy.ProviderID,
		auth,
		now.Add(-time.Hour),
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	store := &memoryCredentialStore{snapshot: initial}
	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:      store,
		Strategies: []accountcredentials.RefreshStrategy{neverRefreshStrategy{}},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	refreshed, err := (credentialSnapshots{resolver: resolver, store: store}).
		RefreshCredential(context.Background(), initial)
	if err != nil {
		t.Fatalf("RefreshCredential() error = %v", err)
	}
	refreshedAuth, valid := refreshed.Credential().(*agy.OAuthAuth)
	if !valid || refreshedAuth.AccessToken() != expiredToken {
		t.Fatalf("无策略时应原样返回快照")
	}
}
