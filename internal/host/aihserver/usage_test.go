package aihserver

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	agyauth "github.com/madou1217/ai_home/core/accounts/agy"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// TestSeedUsageRefreshesRestoresPersistedBlockAfterRestart 验证启动先恢复额度阻塞再异步刷新。
func TestSeedUsageRefreshesRestoresPersistedBlockAfterRestart(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	aiHomeDir := t.TempDir()
	first, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open(first) error = %v", err)
	}
	capturedAt := time.Date(2026, time.July, 31, 4, 0, 0, 0, time.UTC)
	credential, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-synthetic-usage-restart-access",
		RefreshToken: "sk-ant-ort01-synthetic-usage-restart-refresh",
		ExpiresAtMS:  capturedAt.Add(time.Hour).UnixMilli(),
		Scopes:       []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174777",
		},
	})
	if err != nil {
		t.Fatalf("claudeauth.NewOAuthAuth() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(
		catalog,
		accountcore.NewAccountInput{
			Identity:     credential,
			CLIAccountID: alias,
			CreatedAt:    capturedAt,
		},
	)
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	registration, err := accountapp.NewRegistration(
		account,
		credential,
		capturedAt,
	)
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if err := first.Register(ctx, registration); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	agyCredential, err := agyauth.NewOAuthAuth(agyauth.OAuthInput{
		Email:         "usage-startup-agy@example.invalid",
		AccessToken:   "agy-synthetic-usage-startup-access",
		RefreshToken:  "agy-synthetic-usage-startup-refresh",
		ExpiresAtMS:   capturedAt.Add(2 * time.Hour).UnixMilli(),
		RefreshedAtMS: capturedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agyauth.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("agyauth.NewOAuthAuth() error = %v", err)
	}
	agyAlias, err := accountcore.NewCLIAccountID(2)
	if err != nil {
		t.Fatalf("NewCLIAccountID(agy) error = %v", err)
	}
	agyAccount, err := accountcore.NewAccount(
		catalog,
		accountcore.NewAccountInput{
			Identity:     agyCredential,
			CLIAccountID: agyAlias,
			CreatedAt:    capturedAt,
		},
	)
	if err != nil {
		t.Fatalf("NewAccount(agy) error = %v", err)
	}
	agyRegistration, err := accountapp.NewRegistration(
		agyAccount,
		agyCredential,
		capturedAt,
	)
	if err != nil {
		t.Fatalf("NewRegistration(agy) error = %v", err)
	}
	if err := first.Register(ctx, agyRegistration); err != nil {
		t.Fatalf("Register(agy) error = %v", err)
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: account.Ref(),
		ProviderID: claudeauth.ProviderID,
		Source:     "claude_oauth_usage",
		CapturedAt: capturedAt,
		Entries: []usagecore.EntryInput{{
			Bucket:       "primary",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityExhausted,
		}},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	if err := first.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("first.Close() error = %v", err)
	}

	reopened, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open(restart) error = %v", err)
	}
	t.Cleanup(func() {
		_ = reopened.Close()
	})
	accountRuntime, err := runtimeinmemory.New(func() time.Time {
		return capturedAt
	})
	if err != nil {
		t.Fatalf("runtimeinmemory.New() error = %v", err)
	}
	service, err := usageapp.NewService(usageapp.Dependencies{
		Catalog:     catalog,
		Store:       reopened,
		Credentials: startupCredentialResolver{},
		Models:      reopened,
		Runtime:     accountRuntime,
		Strategies:  []usageapp.ProviderStrategy{startupUsageStrategy{}},
		Clock: func() time.Time {
			return capturedAt
		},
	})
	if err != nil {
		t.Fatalf("accountusage.NewService() error = %v", err)
	}
	coordinator, err := usageapp.NewCoordinator(usageapp.CoordinatorOptions{
		Catalog:   catalog,
		Refresher: startupUsageRefresher{},
		ProviderConcurrency: map[string]int{
			claudeauth.ProviderID: 1,
		},
		RefreshTimeout:  time.Second,
		RefreshInterval: time.Hour,
		StaggerWindow:   time.Minute,
		BaseBackoff:     time.Second,
		MaxBackoff:      time.Minute,
		Clock: func() time.Time {
			return capturedAt
		},
	})
	if err != nil {
		t.Fatalf("accountusage.NewCoordinator() error = %v", err)
	}
	t.Cleanup(func() {
		_ = coordinator.Close()
	})
	if err := seedUsageRefreshes(
		ctx,
		reopened,
		service,
		coordinator,
	); err != nil {
		t.Fatalf("seedUsageRefreshes() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(
		account.Ref(),
		"claude-opus-5",
	)
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	eligibility, err := accountRuntime.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Status() != runtimecore.EligibilityQuotaBlocked {
		t.Fatalf("restart eligibility = %#v", eligibility)
	}
}

// startupCredentialResolver 只满足恢复服务依赖；恢复路径不会读取凭据。
type startupCredentialResolver struct{}

// ResolveCredentialSnapshot 不应在同步恢复路径被调用。
func (startupCredentialResolver) ResolveCredentialSnapshot(
	context.Context,
	accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	return accountapp.CredentialSnapshot{}, usageapp.ErrUsageUnsupported
}

// startupUsageStrategy 只提供持久快照所属 Provider 和模型族合同。
type startupUsageStrategy struct{}

// ProviderID 返回持久测试快照使用的 Claude Provider。
func (startupUsageStrategy) ProviderID() string {
	return claudeauth.ProviderID
}

// FetchUsage 不应在同步恢复路径被调用。
func (startupUsageStrategy) FetchUsage(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
	time.Time,
) (usagecore.Snapshot, error) {
	return usagecore.Snapshot{}, usageapp.ErrUsageUnsupported
}

// MatchesModelFamily 对账号级阻塞固定返回 false。
func (startupUsageStrategy) MatchesModelFamily(
	string,
	runtimecore.ModelID,
) bool {
	return false
}

// startupUsageRefresher 隔离后台调度，确保测试只观察同步恢复结果。
type startupUsageRefresher struct{}

// RefreshUsage 让异步任务立即终止，不改写已恢复的运行态。
func (startupUsageRefresher) RefreshUsage(
	context.Context,
	accountcore.AccountRef,
) (usageapp.ReadResult, error) {
	return usageapp.ReadResult{}, usageapp.ErrUsageUnsupported
}
