package accountrouting_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// TestRecruiterUsesSQLiteAndProductionCredentialResolver 验证真实数据库到凭据可用化的完整征召链。
func TestRecruiterUsesSQLiteAndProductionCredentialResolver(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := time.Date(2026, 7, 28, 8, 0, 0, 0, time.UTC)
	catalog := integrationCatalog(t)
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: t.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-recruitment-api-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	readyRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	missingIdentity := identityBefore(t, readyRef)
	missingAlias, _ := accountcore.NewCLIAccountID(1)
	missingAccount, err := accountcore.NewAccount(
		catalog,
		accountcore.NewAccountInput{
			Identity:     missingIdentity,
			CLIAccountID: missingAlias,
			CreatedAt:    now,
		},
	)
	if err != nil {
		t.Fatalf("NewAccount(missing) error = %v", err)
	}
	if err := store.Create(ctx, missingAccount); err != nil {
		t.Fatalf("Store.Create(missing) error = %v", err)
	}

	readyAlias, _ := accountcore.NewCLIAccountID(2)
	readyAccount, err := accountcore.NewAccount(
		catalog,
		accountcore.NewAccountInput{
			Identity:     credential,
			CLIAccountID: readyAlias,
			CreatedAt:    now,
		},
	)
	if err != nil {
		t.Fatalf("NewAccount(ready) error = %v", err)
	}
	registration, err := accountapp.NewRegistration(
		readyAccount,
		credential,
		now,
	)
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if err := store.Register(ctx, registration); err != nil {
		t.Fatalf("Store.Register() error = %v", err)
	}

	provider, err := codexoauth.New(
		&http.Client{Timeout: time.Second},
		func() time.Time { return now },
	)
	if err != nil {
		t.Fatalf("codexoauth.New() error = %v", err)
	}
	credentialResolver, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store:      store,
			Strategies: []accountcredentials.RefreshStrategy{provider},
			Clock:      func() time.Time { return now },
		},
	)
	if err != nil {
		t.Fatalf("accountcredentials.NewResolver() error = %v", err)
	}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates:  store,
			Credentials: credentialResolver,
		},
	)
	if err != nil {
		t.Fatalf("accountrouting.NewRecruiter() error = %v", err)
	}
	request, err := accountrouting.NewRequest(
		catalog,
		" CODEX ",
		"",
		3,
	)
	if err != nil {
		t.Fatalf("accountrouting.NewRequest() error = %v", err)
	}

	result, err := recruiter.Recruit(ctx, request)
	if err != nil {
		t.Fatalf("Recruit() error = %v", err)
	}
	if result.Account().Ref() != readyAccount.Ref() ||
		result.Account().CLIAccountID() != readyAlias ||
		result.Credential().IdentitySeed() != credential.IdentitySeed() ||
		result.Examined() != 2 ||
		!result.SourceExhausted() {
		t.Fatalf("Recruit() result = %#v", result)
	}
	t.Logf(
		"provider=%s examined=%d selected_cli_account_id=%d selected_ref=%s",
		result.Account().ProviderID(),
		result.Examined(),
		result.Account().CLIAccountID().Int64(),
		result.Account().Ref(),
	)
}

// integrationIdentitySource 是创建无凭据基础账号所需的测试身份。
type integrationIdentitySource struct {
	identitySeed string
}

// ProviderID 返回 Codex Provider。
func (integrationIdentitySource) ProviderID() string {
	return "codex"
}

// IdentitySeed 返回确定性测试身份种子。
func (source integrationIdentitySource) IdentitySeed() string {
	return source.identitySeed
}

// identityBefore 搜索排序在目标账号之前的有效身份。
func identityBefore(
	t *testing.T,
	target accountcore.AccountRef,
) integrationIdentitySource {
	t.Helper()

	for index := 0; index < 10_000; index++ {
		source := integrationIdentitySource{
			identitySeed: fmt.Sprintf(
				"oauth:codex:missing-recruitment-%d",
				index,
			),
		}
		accountRef, err := accountcore.DeriveAccountRef(source)
		if err != nil {
			t.Fatalf("DeriveAccountRef(missing) error = %v", err)
		}
		if accountRef.String() < target.String() {
			return source
		}
	}
	t.Fatal("未找到排序在目标账号之前的测试身份")
	return integrationIdentitySource{}
}

// integrationCatalog 创建生产内置 Provider 注册表。
func integrationCatalog(t *testing.T) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return catalog
}
