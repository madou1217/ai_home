package tokenrefreshdaemon

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

func testFakeJWT(payload string) string {
	encode := base64.RawURLEncoding.EncodeToString
	return encode([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + encode([]byte(payload)) + ".sig"
}

type fakeRefreshStrategy struct {
	providerID string
	expiresAt  func(accountapp.Credential) (time.Time, bool)
	refresh    func(context.Context, accountapp.Credential, time.Time) (accountapp.Credential, error)
}

func (s *fakeRefreshStrategy) ProviderID() string { return s.providerID }

func (s *fakeRefreshStrategy) ExpiresAt(cred accountapp.Credential) (time.Time, bool) {
	if s.expiresAt == nil {
		return time.Time{}, false
	}
	return s.expiresAt(cred)
}

func (s *fakeRefreshStrategy) Refresh(
	ctx context.Context,
	cred accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	return s.refresh(ctx, cred, refreshedAt)
}

func openTestSQLiteAndRuntime(t *testing.T, nowFn func() time.Time) (*sqliteaccount.Store, *inmemory.Runtime, *providers.Catalog, *accountapp.Registrar, string) {
	t.Helper()
	aiHome := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	rt, err := inmemory.New(nowFn)
	if err != nil {
		t.Fatalf("inmemory.New() error = %v", err)
	}
	registrar, err := accountapp.NewRegistrar(catalog, store, nowFn)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	return store, rt, catalog, registrar, aiHome
}

func TestExtractCredentialSignalsAllOAuthShapes(t *testing.T) {
	now := time.UnixMilli(1_750_000_000_000).UTC()

	codexAuth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:   testFakeJWT(`{"sub":"u1","exp":2000000000}`),
		RefreshToken:  "codex-refresh-secret-value",
		IDToken:       testFakeJWT(`{"sub":"u1","email":"c@example.com","https://api.openai.com/auth":{"chatgpt_user_id":"u1"}}`),
		RefreshedAtMS: now.UnixMilli(),
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	cs := inspectCredentialSignals(codexAuth)
	if !cs.hasAccessToken || cs.refreshTokenDigest == "" || cs.refreshTokenDigest == missingRefreshTokenDigest {
		t.Fatalf("unexpected codex signals: %+v", cs)
	}
	if strings.Contains(cs.refreshTokenDigest, "codex-refresh-secret-value") {
		t.Fatalf("digest leaked raw token: %q", cs.refreshTokenDigest)
	}

	claudeAuth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "sk-ant-oat01-access-secret",
		RefreshToken: "sk-ant-ort01-refresh-secret",
		ExpiresAtMS:  now.Add(time.Hour).UnixMilli(),
		Scopes:       []string{"user:inference"},
		Identity:     claude.OAuthIdentity{AccountUUID: "11111111-1111-4111-8111-111111111111"},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	cls := inspectCredentialSignals(claudeAuth)
	if !cls.hasAccessToken || cls.refreshTokenDigest == missingRefreshTokenDigest {
		t.Fatalf("unexpected claude signals: %+v", cls)
	}

	agyRefreshOnly, err := agy.NewNativeOAuthAuth(agy.OAuthInput{
		Email:         "agy-refresh-only@example.test",
		AccessToken:   "",
		RefreshToken:  "agy-refresh-only-token",
		ExpiresAtMS:   0,
		RefreshedAtMS: now.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("agy.NewNativeOAuthAuth() error = %v", err)
	}
	as := inspectCredentialSignals(agyRefreshOnly)
	if as.hasAccessToken {
		t.Fatalf("expected hasAccessToken=false for refresh-only agy cred")
	}
	if as.refreshTokenDigest == "" || as.refreshTokenDigest == missingRefreshTokenDigest {
		t.Fatalf("expected non-missing digest for agy refresh token: %+v", as)
	}

	kiroIdentity, err := accountcore.NewNativeKiroIdentity("https://codewhisperer.us-east-1.amazonaws.com", "kiro-subject-1")
	if err != nil {
		t.Fatalf("NewNativeKiroIdentity(kiro) error = %v", err)
	}
	kiroCred, err := accountcore.NewNativeCredential(kiroIdentity, []byte(`{
		"flavor":"desktop",
		"auth":{"access_token":"kiro-access","refresh_token":"kiro-refresh","expires_at":"2030-01-01T00:00:00Z"}
	}`))
	if err != nil {
		t.Fatalf("NewNativeCredential(kiro) error = %v", err)
	}
	ks := inspectCredentialSignals(kiroCred)
	if !ks.hasAccessToken || ks.refreshTokenDigest == missingRefreshTokenDigest {
		t.Fatalf("unexpected kiro signals: %+v", ks)
	}

	kimiID, err := accountcore.NewNativeSubjectIdentity("kimi", "kimi-user-1")
	if err != nil {
		t.Fatal(err)
	}
	geminiID, err := accountcore.NewNativeEmailIdentity("gemini", "gemini-user-1@example.com")
	if err != nil {
		t.Fatal(err)
	}
	grokID, err := accountcore.NewNativeGrokIdentity([]string{"grok-user-1"})
	if err != nil {
		t.Fatal(err)
	}
	clineID, err := accountcore.NewNativeSubjectIdentity("cline", "cline-user-1")
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		provider string
		id       accountcore.NativeIdentity
		payload  string
		wantAcc  bool
	}{
		{
			provider: "kimi",
			id:       kimiID,
			payload:  `{"credentials":{"access_token":"kimi-acc","refresh_token":"kimi-ref","expires_at":1800000000}}`,
			wantAcc:  true,
		},
		{
			provider: "gemini",
			id:       geminiID,
			payload:  `{"oauthCreds":{"access_token":"gem-acc","refresh_token":"gem-ref","expiry_date":1800000000000}}`,
			wantAcc:  true,
		},
		{
			provider: "grok",
			id:       grokID,
			payload:  `{"profiles":{"default":{"key":"","refresh_token":"grok-ref","expires_at":1800000000000}}}`,
			wantAcc:  false,
		},
		{
			provider: "cline",
			id:       clineID,
			payload:  `{"providers":{"cline":{"accessToken":"workos:cline-acc","refreshToken":"cline-ref"}}}`,
			wantAcc:  true,
		},
	} {
		nc, err := accountcore.NewNativeCredential(tc.id, []byte(tc.payload))
		if err != nil {
			t.Fatalf("NewNativeCredential(%s) error = %v", tc.provider, err)
		}
		sig := inspectCredentialSignals(nc)
		if sig.hasAccessToken != tc.wantAcc {
			t.Fatalf("%s hasAccessToken = %v, want %v", tc.provider, sig.hasAccessToken, tc.wantAcc)
		}
		if sig.refreshTokenDigest == missingRefreshTokenDigest || sig.refreshTokenDigest == "" {
			t.Fatalf("%s unexpected digest: %+v", tc.provider, sig)
		}
	}
}

func TestDaemonProactiveRefreshLifecycleWithSQLiteAndResolver(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := time.UnixMilli(1_750_000_000_000).UTC()
	nowFn := func() time.Time { return now }
	store, runtime, _, registrar, aiHome := openTestSQLiteAndRuntime(t, nowFn)

	// 1) agy 即将过期（10m 后到期，处于 30m 提前窗口内） -> 应刷新
	dueAgyAuth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "due-agy@example.com",
		AccessToken:   "due-agy-access-old",
		RefreshToken:  "due-agy-refresh-old",
		ExpiresAtMS:   now.Add(10 * time.Minute).UnixMilli(),
		RefreshedAtMS: now.Add(-time.Hour).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth(due) error = %v", err)
	}
	dueAgyAcc, err := registrar.Register(ctx, dueAgyAuth, nil)
	if err != nil {
		t.Fatalf("Register(due) error = %v", err)
	}

	// 2) agy 远未过期（2h 后到期，超出 30m 提前窗口） -> 应跳过
	freshAgyAuth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "fresh-agy@example.com",
		AccessToken:   "fresh-agy-access",
		RefreshToken:  "fresh-agy-refresh",
		ExpiresAtMS:   now.Add(2 * time.Hour).UnixMilli(),
		RefreshedAtMS: now.Add(-10 * time.Minute).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth(fresh) error = %v", err)
	}
	if _, err := registrar.Register(ctx, freshAgyAuth, nil); err != nil {
		t.Fatalf("Register(fresh) error = %v", err)
	}

	// 3) claude 停用账号（即使过期） -> 应跳过
	disabledClaudeAuth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "disabled-claude-access",
		RefreshToken: "disabled-claude-refresh",
		ExpiresAtMS:  now.Add(-5 * time.Minute).UnixMilli(),
		Scopes:       []string{"user:inference"},
		Identity:     claude.OAuthIdentity{AccountUUID: "22222222-2222-4222-8222-222222222222"},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	disabledClaudeAcc, err := registrar.Register(ctx, disabledClaudeAuth, nil)
	if err != nil {
		t.Fatalf("Register(disabled claude) error = %v", err)
	}
	if _, err := store.SetEnabled(ctx, disabledClaudeAcc.Ref(), false, now); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}

	// 4) claude API Key 静态账号 -> 应跳过
	staticClaudeAuth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey: "sk-ant-api03-static-key-secret",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	if _, err := registrar.Register(ctx, staticClaudeAuth, nil); err != nil {
		t.Fatalf("Register(static claude) error = %v", err)
	}

	var refreshedRefs []string
	var mu sync.Mutex
	agyStrategy := &fakeRefreshStrategy{
		providerID: agy.ProviderID,
		expiresAt: func(cred accountapp.Credential) (time.Time, bool) {
			auth, ok := cred.(*agy.OAuthAuth)
			if !ok || auth == nil {
				return time.Time{}, false
			}
			return time.UnixMilli(auth.ExpiresAtMS()).UTC(), true
		},
		refresh: func(_ context.Context, cred accountapp.Credential, refreshedAt time.Time) (accountapp.Credential, error) {
			auth := cred.(*agy.OAuthAuth)
			mu.Lock()
			refreshedRefs = append(refreshedRefs, auth.Email())
			mu.Unlock()
			return agy.NewOAuthAuth(agy.OAuthInput{
				Email:         auth.Email(),
				AccessToken:   "due-agy-access-new",
				RefreshToken:  "due-agy-refresh-new",
				ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
				RefreshedAtMS: refreshedAt.UnixMilli(),
				TokenType:     "Bearer",
				AuthMethod:    agy.AuthMethodConsumer,
			})
		},
	}
	claudeStrategy := &fakeRefreshStrategy{
		providerID: claude.ProviderID,
		expiresAt: func(cred accountapp.Credential) (time.Time, bool) {
			auth, ok := cred.(*claude.OAuthAuth)
			if !ok || auth == nil {
				return time.Time{}, false
			}
			return time.UnixMilli(auth.ExpiresAtMS()).UTC(), true
		},
		refresh: func(context.Context, accountapp.Credential, time.Time) (accountapp.Credential, error) {
			t.Fatalf("disabled/static claude accounts must never refresh")
			return nil, nil
		},
	}

	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:      store,
		Strategies: []accountcredentials.RefreshStrategy{agyStrategy, claudeStrategy},
		Clock:      nowFn,
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}

	daemon := New(Options{
		AIHomeDir: aiHome,
		Store:     store,
		Refresher: resolver,
		Runtime:   runtime,
		Now:       nowFn,
	})

	summary, err := daemon.Trigger(ctx, "")
	if err != nil {
		t.Fatalf("Trigger() error = %v", err)
	}
	if !summary.OK || summary.Scanned != 4 || summary.Due != 1 || summary.Refreshed != 1 || summary.Skipped != 3 || summary.Errors != 0 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
	if len(refreshedRefs) != 1 || refreshedRefs[0] != "due-agy@example.com" {
		t.Fatalf("refreshed = %v, want [due-agy@example.com]", refreshedRefs)
	}

	updatedCred, err := store.GetCredential(ctx, dueAgyAcc.Ref())
	if err != nil {
		t.Fatalf("GetCredential() error = %v", err)
	}
	if updatedCred.(*agy.OAuthAuth).AccessToken() != "due-agy-access-new" {
		t.Fatalf("persisted access token not updated: %q", updatedCred.(*agy.OAuthAuth).AccessToken())
	}

	// 按 provider="claude" 精确触发：仅扫描 2 个 claude 账号且全部跳过，agy 不被扫描。
	claudeSummary, err := daemon.Trigger(ctx, "claude")
	if err != nil {
		t.Fatalf("Trigger(claude) error = %v", err)
	}
	if claudeSummary.Provider != "claude" || claudeSummary.Scanned != 2 || claudeSummary.Skipped != 2 || claudeSummary.Refreshed != 0 {
		t.Fatalf("unexpected provider filter summary: %+v", claudeSummary)
	}

	st := daemon.Status()
	if st.TickCount != 2 || st.RefreshedCount != 1 || st.SkippedCount != 5 || st.ErrorCount != 0 {
		t.Fatalf("unexpected daemon status: %+v", st)
	}
	if st.Providers["agy"].Refreshed != 1 || st.Providers["agy"].Skipped != 1 {
		t.Fatalf("unexpected agy provider stats: %+v", st.Providers["agy"])
	}
	if st.Providers["claude"].Skipped != 4 {
		t.Fatalf("unexpected claude provider stats: %+v", st.Providers["claude"])
	}
}

func TestDaemonSuppressionAuthInvalidAndRecoveryAcrossRestarts(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := time.UnixMilli(1_750_000_000_000).UTC()
	var nowMu sync.Mutex
	nowFn := func() time.Time {
		nowMu.Lock()
		defer nowMu.Unlock()
		return now
	}
	advanceTime := func(d time.Duration) {
		nowMu.Lock()
		now = now.Add(d)
		nowMu.Unlock()
	}

	store, runtime, _, registrar, aiHome := openTestSQLiteAndRuntime(t, nowFn)

	// A) 无 access token 的刷新型 agy 账号：遭遇 ErrReauthenticationRequired 时须标 auth_invalid 并写抑制。
	deadRefreshOnly, err := agy.NewNativeOAuthAuth(agy.OAuthInput{
		Email:         "dead-no-access@example.com",
		AccessToken:   "",
		RefreshToken:  "dead-refresh-secret-token-1",
		ExpiresAtMS:   0,
		RefreshedAtMS: nowFn().Add(-time.Hour).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewNativeOAuthAuth() error = %v", err)
	}
	deadAcc, err := registrar.Register(ctx, deadRefreshOnly, nil)
	if err != nil {
		t.Fatalf("Register(dead) error = %v", err)
	}

	// B) 仍有 access token 的临期 agy 账号：遭遇 ErrReauthenticationRequired 时仅写抑制，不提前标 auth_invalid。
	stillAccessCred, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "dead-with-access@example.com",
		AccessToken:   "still-valid-access-token",
		RefreshToken:  "dead-refresh-secret-token-2",
		ExpiresAtMS:   nowFn().Add(5 * time.Minute).UnixMilli(),
		RefreshedAtMS: nowFn().Add(-time.Hour).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth(stillAccess) error = %v", err)
	}
	withAccessAcc, err := registrar.Register(ctx, stillAccessCred, nil)
	if err != nil {
		t.Fatalf("Register(stillAccess) error = %v", err)
	}

	var shouldFail atomic.Bool
	shouldFail.Store(true)
	var refreshCalls atomic.Int32

	agyStrategy := &fakeRefreshStrategy{
		providerID: agy.ProviderID,
		expiresAt: func(cred accountapp.Credential) (time.Time, bool) {
			auth, ok := cred.(*agy.OAuthAuth)
			if !ok || auth == nil {
				return time.Time{}, false
			}
			if auth.ExpiresAtMS() <= 0 {
				return time.Time{}, true
			}
			return time.UnixMilli(auth.ExpiresAtMS()).UTC(), true
		},
		refresh: func(_ context.Context, cred accountapp.Credential, refreshedAt time.Time) (accountapp.Credential, error) {
			refreshCalls.Add(1)
			if shouldFail.Load() {
				return nil, fmt.Errorf("%w: invalid_grant revoked", accountcredentials.ErrReauthenticationRequired)
			}
			auth := cred.(*agy.OAuthAuth)
			return agy.NewOAuthAuth(agy.OAuthInput{
				Email:         auth.Email(),
				AccessToken:   "recovered-access-token",
				RefreshToken:  "recovered-refresh-token",
				ExpiresAtMS:   refreshedAt.Add(2 * time.Hour).UnixMilli(),
				RefreshedAtMS: refreshedAt.UnixMilli(),
				TokenType:     "Bearer",
				AuthMethod:    agy.AuthMethodConsumer,
			})
		},
	}

	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:      store,
		Strategies: []accountcredentials.RefreshStrategy{agyStrategy},
		Clock:      nowFn,
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}

	daemon1 := New(Options{
		AIHomeDir:             aiHome,
		Store:                 store,
		Refresher:             resolver,
		Runtime:               runtime,
		SuppressionRetryDelay: 24 * time.Hour,
		Now:                   nowFn,
	})

	sum1, err := daemon1.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick 1 error = %v", err)
	}
	if sum1.Errors != 2 || sum1.Suppressed != 2 || sum1.Invalidated != 1 {
		t.Fatalf("unexpected Tick 1 summary: %+v", sum1)
	}

	// 验证 deadAcc 在 SQLite 与 inmemory.Runtime 均为 auth_invalid；withAccessAcc 未被错标 auth_invalid。
	deadState, err := store.GetAccountState(ctx, deadAcc.Ref())
	if err != nil {
		t.Fatalf("GetAccountState(dead) error = %v", err)
	}
	if got := deadState.DeriveStatus(nowFn()).Status(); got != "auth_invalid" {
		t.Fatalf("dead account status = %q, want auth_invalid", got)
	}
	route, err := runtimecore.NewModelRoute(deadAcc.Ref(), "gemini-2.5-pro")
	if err != nil {
		t.Fatal(err)
	}
	elig, err := runtime.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatal(err)
	}
	if elig.Eligible() {
		t.Fatalf("expected dead account to be blocked in runtime")
	}

	if _, err := store.GetAccountState(ctx, withAccessAcc.Ref()); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("account with access token must NOT be marked auth_invalid prematurely, err=%v", err)
	}

	// 验证抑制文件已落盘，且不包含原始 refresh token。
	suppPath := filepath.Join(aiHome, "run", suppressionFileName)
	rawSupp, err := os.ReadFile(suppPath)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", suppPath, err)
	}
	if strings.Contains(string(rawSupp), "dead-refresh-secret-token") {
		t.Fatalf("suppression file leaked plaintext refresh token!")
	}

	// 第 2 轮 Tick + 重建新守护实例（模拟重启）：抑制必须在重启后依然生效，不再请求上游。
	callsAfterTick1 := refreshCalls.Load()
	sum2, err := daemon1.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick 2 error = %v", err)
	}
	if sum2.Suppressed != 2 || refreshCalls.Load() != callsAfterTick1 {
		t.Fatalf("expected Tick 2 suppression without hitting strategy, sum=%+v calls=%d/%d", sum2, refreshCalls.Load(), callsAfterTick1)
	}

	daemon2 := New(Options{
		AIHomeDir:             aiHome,
		Store:                 store,
		Refresher:             resolver,
		Runtime:               runtime,
		SuppressionRetryDelay: 24 * time.Hour,
		Now:                   nowFn,
	})
	sumRestart, err := daemon2.Tick(ctx)
	if err != nil {
		t.Fatalf("Restart Tick error = %v", err)
	}
	if sumRestart.Suppressed != 2 || refreshCalls.Load() != callsAfterTick1 {
		t.Fatalf("expected persisted suppression to survive restart, sum=%+v calls=%d", sumRestart, refreshCalls.Load())
	}

	// 推进时钟超出 24h 重试退避，并恢复上游成功：须解除抑制、刷新成功、清空 auth_invalid 并恢复调度资格。
	shouldFail.Store(false)
	advanceTime(25 * time.Hour)

	sumRecovered, err := daemon2.Tick(ctx)
	if err != nil {
		t.Fatalf("Recovered Tick error = %v", err)
	}
	if sumRecovered.Refreshed != 2 || sumRecovered.Errors != 0 {
		t.Fatalf("expected full recovery on Tick after backoff expiry, got %+v", sumRecovered)
	}

	if _, err := store.GetAccountState(ctx, deadAcc.Ref()); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("expected deadAcc runtime state deleted on recovery, got err=%v", err)
	}
	eligAfter, err := runtime.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatal(err)
	}
	if !eligAfter.Eligible() {
		t.Fatalf("expected runtime eligibility restored after successful refresh, got %+v", eligAfter)
	}
	if daemon2.Status().ActiveSuppressed != 0 {
		t.Fatalf("expected ActiveSuppressed = 0 after recovery, got %d", daemon2.Status().ActiveSuppressed)
	}
}

func TestDaemonSuppressionClearsWhenRefreshTokenRotates(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := time.UnixMilli(1_750_000_000_000).UTC()
	nowFn := func() time.Time { return now }
	store, runtime, _, registrar, aiHome := openTestSQLiteAndRuntime(t, nowFn)

	initialCred, err := agy.NewNativeOAuthAuth(agy.OAuthInput{
		Email:         "relogin@example.com",
		AccessToken:   "",
		RefreshToken:  "old-broken-refresh-token",
		ExpiresAtMS:   0,
		RefreshedAtMS: now.Add(-time.Hour).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatal(err)
	}
	acc, err := registrar.Register(ctx, initialCred, nil)
	if err != nil {
		t.Fatal(err)
	}

	var calls atomic.Int32
	strategy := &fakeRefreshStrategy{
		providerID: agy.ProviderID,
		expiresAt: func(cred accountapp.Credential) (time.Time, bool) {
			auth := cred.(*agy.OAuthAuth)
			if auth.RefreshToken() == "old-broken-refresh-token" {
				return time.Time{}, true
			}
			return time.UnixMilli(auth.ExpiresAtMS()).UTC(), true
		},
		refresh: func(_ context.Context, cred accountapp.Credential, refreshedAt time.Time) (accountapp.Credential, error) {
			calls.Add(1)
			auth := cred.(*agy.OAuthAuth)
			if auth.RefreshToken() == "old-broken-refresh-token" {
				return nil, accountcredentials.ErrReauthenticationRequired
			}
			return agy.NewOAuthAuth(agy.OAuthInput{
				Email:         auth.Email(),
				AccessToken:   "fresh-relogin-access",
				RefreshToken:  "new-relogin-refresh-token",
				ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
				RefreshedAtMS: refreshedAt.UnixMilli(),
				TokenType:     "Bearer",
				AuthMethod:    agy.AuthMethodConsumer,
			})
		},
	}

	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:      store,
		Strategies: []accountcredentials.RefreshStrategy{strategy},
		Clock:      nowFn,
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon := New(Options{
		AIHomeDir: aiHome,
		Store:     store,
		Refresher: resolver,
		Runtime:   runtime,
		Now:       nowFn,
	})

	if _, err := daemon.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}

	// 用户重新登录写回新的 refresh token（时间未前进到 24h，摘要变化应立即解除抑制）。
	snap, err := store.GetCredentialSnapshot(ctx, acc.Ref())
	if err != nil {
		t.Fatal(err)
	}
	newCred, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "relogin@example.com",
		AccessToken:   "relogin-temp-access",
		RefreshToken:  "relogin-new-refresh-token",
		ExpiresAtMS:   now.Add(2 * time.Minute).UnixMilli(),
		RefreshedAtMS: now.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := accountapp.NewCredentialReplacement(snap, newCred, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ReplaceCredential(ctx, replacement); err != nil {
		t.Fatal(err)
	}

	sum, err := daemon.Tick(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || sum.Refreshed != 1 {
		t.Fatalf("expected suppression lifted after refresh token rotation: calls=%d sum=%+v", calls.Load(), sum)
	}
}

func TestClearAccountAuthInvalidPreservesUnrelatedRateLimits(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := time.UnixMilli(1_750_000_000_000).UTC()
	nowFn := func() time.Time { return now }
	store, runtime, _, registrar, _ := openTestSQLiteAndRuntime(t, nowFn)

	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "mixed-state@example.com",
		AccessToken:   "acc-1",
		RefreshToken:  "ref-1",
		ExpiresAtMS:   now.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: now.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatal(err)
	}
	acc, err := registrar.Register(ctx, auth, nil)
	if err != nil {
		t.Fatal(err)
	}

	rateUntil := now.Add(20 * time.Minute).UnixMilli()
	mixedJSON, err := json.Marshal(map[string]any{
		"cooldownUntil":       now.Add(30 * time.Second).UnixMilli(),
		"authInvalidUntil":    now.Add(30 * time.Second).UnixMilli(),
		"rateLimitUntil":      rateUntil,
		"lastFailureKind":     "auth_invalid",
		"lastFailureReason":   "token_refresh_invalid_grant",
		"lastError":           "token_refresh_invalid_grant",
		"lastFailureAt":       now.UnixMilli(),
		"consecutiveFailures": 1,
		"failCount":           2,
		"modelCooldowns": map[string]any{
			"gpt-5": rateUntil,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: acc.Ref(),
		Document:   mixedJSON,
		UpdatedAt:  now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ReplaceAccountState(ctx, state, nil); err != nil {
		t.Fatal(err)
	}
	if err := runtime.ApplyAccountState(ctx, state); err != nil {
		t.Fatal(err)
	}

	cleared, err := clearAccountAuthInvalid(ctx, store, runtime, acc.Ref(), now.Add(time.Second))
	if err != nil || !cleared {
		t.Fatalf("clearAccountAuthInvalid() = (%v, %v), want (true, nil)", cleared, err)
	}
	after, err := store.GetAccountState(ctx, acc.Ref())
	if err != nil {
		t.Fatalf("GetAccountState() after clear error = %v", err)
	}
	if got := after.DeriveStatus(now.Add(time.Second)).Status(); got != "rate_limited" {
		t.Fatalf("status after clearing auth_invalid = %q, want rate_limited", got)
	}
}

func TestDaemonDelegatedSkipsSafely(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := time.UnixMilli(1_750_000_000_000).UTC()
	nowFn := func() time.Time { return now }
	store, _, _, registrar, aiHome := openTestSQLiteAndRuntime(t, nowFn)

	auth, err := agy.NewNativeOAuthAuth(agy.OAuthInput{
		Email:         "delegated@example.com",
		AccessToken:   "",
		RefreshToken:  "delegated-refresh",
		ExpiresAtMS:   0,
		RefreshedAtMS: now.Add(-time.Hour).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registrar.Register(ctx, auth, nil); err != nil {
		t.Fatal(err)
	}

	var calls atomic.Int32
	strategy := &fakeRefreshStrategy{
		providerID: agy.ProviderID,
		expiresAt:  func(accountapp.Credential) (time.Time, bool) { return time.Time{}, true },
		refresh: func(context.Context, accountapp.Credential, time.Time) (accountapp.Credential, error) {
			calls.Add(1)
			return nil, errors.New("should not be called when delegated")
		},
	}
	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:            store,
		Strategies:       []accountcredentials.RefreshStrategy{strategy},
		Clock:            nowFn,
		RefreshDelegated: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	daemon := New(Options{
		DelegateCredentialRefresh: true,
		AIHomeDir:                 aiHome,
		Store:                     store,
		Refresher:                 resolver,
		Now:                       nowFn,
	})
	daemon.Start(ctx)
	t.Cleanup(func() { _ = daemon.Close() })

	st := daemon.Status()
	if !st.Delegated || st.Running {
		t.Fatalf("expected Delegated=true Running=false, got %+v", st)
	}

	summary, err := daemon.Trigger(ctx, "")
	if err != nil {
		t.Fatalf("Trigger() error = %v", err)
	}
	if !summary.OK || !summary.Delegated || !summary.SkippedAll || calls.Load() != 0 {
		t.Fatalf("expected delegated skip summary, got %+v calls=%d", summary, calls.Load())
	}
}

func TestDaemonBoundedConcurrencyAndLifecycleClose(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	now := time.UnixMilli(1_750_000_000_000).UTC()
	nowFn := func() time.Time { return now }
	store, runtime, _, registrar, aiHome := openTestSQLiteAndRuntime(t, nowFn)

	for i := 0; i < 6; i++ {
		auth, err := agy.NewOAuthAuth(agy.OAuthInput{
			Email:         fmt.Sprintf("worker-%d@example.com", i),
			AccessToken:   fmt.Sprintf("acc-%d", i),
			RefreshToken:  fmt.Sprintf("ref-%d", i),
			ExpiresAtMS:   now.Add(5 * time.Minute).UnixMilli(),
			RefreshedAtMS: now.Add(-time.Hour).UnixMilli(),
			TokenType:     "Bearer",
			AuthMethod:    agy.AuthMethodConsumer,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := registrar.Register(ctx, auth, nil); err != nil {
			t.Fatal(err)
		}
	}

	var inFlight atomic.Int32
	var maxInFlight atomic.Int32
	var totalCalls atomic.Int32
	strategy := &fakeRefreshStrategy{
		providerID: agy.ProviderID,
		expiresAt: func(cred accountapp.Credential) (time.Time, bool) {
			auth := cred.(*agy.OAuthAuth)
			return time.UnixMilli(auth.ExpiresAtMS()).UTC(), true
		},
		refresh: func(_ context.Context, cred accountapp.Credential, refreshedAt time.Time) (accountapp.Credential, error) {
			cur := inFlight.Add(1)
			for {
				prev := maxInFlight.Load()
				if cur <= prev || maxInFlight.CompareAndSwap(prev, cur) {
					break
				}
			}
			time.Sleep(15 * time.Millisecond)
			inFlight.Add(-1)
			totalCalls.Add(1)

			auth := cred.(*agy.OAuthAuth)
			return agy.NewOAuthAuth(agy.OAuthInput{
				Email:         auth.Email(),
				AccessToken:   auth.AccessToken() + "-new",
				RefreshToken:  auth.RefreshToken(),
				ExpiresAtMS:   refreshedAt.Add(2 * time.Hour).UnixMilli(),
				RefreshedAtMS: refreshedAt.UnixMilli(),
				TokenType:     "Bearer",
				AuthMethod:    agy.AuthMethodConsumer,
			})
		},
	}

	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:      store,
		Strategies: []accountcredentials.RefreshStrategy{strategy},
		Clock:      nowFn,
	})
	if err != nil {
		t.Fatal(err)
	}

	tickCh := make(chan time.Time, 1)
	daemon := New(Options{
		AIHomeDir:   aiHome,
		Store:       store,
		Refresher:   resolver,
		Runtime:     runtime,
		Concurrency: 2,
		Now:         nowFn,
		testTickCh:  tickCh,
	})
	daemon.Start(ctx)
	daemon.Start(ctx) // 验证 Start 幂等

	if !daemon.Status().Running {
		t.Fatalf("expected daemon.Status().Running == true after Start")
	}

	tickCh <- now
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if daemon.Status().TickCount >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if daemon.Status().TickCount != 1 || daemon.Status().RefreshedCount != 6 {
		t.Fatalf("expected background tick refreshed 6 accounts, got %+v", daemon.Status())
	}
	if peak := maxInFlight.Load(); peak > 2 || peak < 1 {
		t.Fatalf("max concurrent refresh workers = %d, want in [1, 2]", peak)
	}
	if totalCalls.Load() != 6 {
		t.Fatalf("total refresh calls = %d, want 6", totalCalls.Load())
	}

	if err := daemon.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := daemon.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
	if daemon.Status().Running {
		t.Fatalf("expected Running == false after Close")
	}
}
