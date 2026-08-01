package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestExportReaderBuildsOneConsistentAccountSnapshot 验证导出读取只组合基础账号、凭据和可选公开资料。
func TestExportReaderBuildsOneConsistentAccountSnapshot(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "synthetic-export-reader-key",
		BaseURL: "https://api.example.invalid/v1",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	account := newExportReaderAccount(t, credential)
	profile, err := accountapp.NewProfileSnapshot(
		testCatalog(t),
		exportProfileStub{
			providerID:   credential.ProviderID(),
			identitySeed: credential.IdentitySeed(),
		},
		account.CreatedAt(),
	)
	if err != nil {
		t.Fatalf("NewProfileSnapshot() error = %v", err)
	}
	source := &exportReaderSource{
		account:    account,
		credential: credential,
		profile:    profile,
	}
	reader, err := accountapp.NewExportReader(source, source, source)
	if err != nil {
		t.Fatalf("NewExportReader() error = %v", err)
	}

	snapshot, err := reader.ReadAccountExport(
		context.Background(),
		account.Ref(),
	)
	if err != nil {
		t.Fatalf("ReadAccountExport() error = %v", err)
	}
	publicProfile, hasProfile := snapshot.Profile()
	if snapshot.Account() != account ||
		snapshot.Credential() != credential ||
		!hasProfile ||
		publicProfile.Email() != "export-reader@example.invalid" {
		t.Fatalf(
			"导出快照不完整: account=%s credential=%T profile=%t",
			snapshot.Account().Ref(),
			snapshot.Credential(),
			hasProfile,
		)
	}
}

// TestExportReaderTreatsMissingProfileAsOptional 验证 API Key 账号没有公开资料时仍可导出。
func TestExportReaderTreatsMissingProfileAsOptional(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-export-without-profile",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	account := newExportReaderAccount(t, credential)
	source := &exportReaderSource{
		account:    account,
		credential: credential,
		profileErr: accountapp.ErrProfileNotFound,
	}
	reader, err := accountapp.NewExportReader(source, source, source)
	if err != nil {
		t.Fatalf("NewExportReader() error = %v", err)
	}

	snapshot, err := reader.ReadAccountExport(
		context.Background(),
		account.Ref(),
	)
	if err != nil {
		t.Fatalf("ReadAccountExport() error = %v", err)
	}
	if _, hasProfile := snapshot.Profile(); hasProfile {
		t.Fatal("缺失的公开资料被伪造成存在")
	}
}

// TestExportReaderStopsAtTheFirstSourceError 验证不存在账号和缺失凭据保持原始应用错误。
func TestExportReaderStopsAtTheFirstSourceError(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	foreignCredential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-export-foreign-binding",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth(foreign) error = %v", err)
	}
	tests := []struct {
		name       string
		source     *exportReaderSource
		expected   error
		credential int
		profile    int
	}{
		{
			name:     "account not found",
			source:   &exportReaderSource{accountErr: accountapp.ErrAccountNotFound},
			expected: accountapp.ErrAccountNotFound,
		},
		{
			name: "credential missing",
			source: &exportReaderSource{
				account:       newExportReaderAccountWithRef(t, accountRef),
				credentialErr: accountapp.ErrCredentialNotFound,
			},
			expected:   accountapp.ErrCredentialNotFound,
			credential: 1,
		},
		{
			name: "credential bound to another account",
			source: &exportReaderSource{
				account:    newExportReaderAccountWithRef(t, accountRef),
				credential: foreignCredential,
				bindingRef: accountcore.AccountRef("acct_fedcba9876543210fedc"),
			},
			expected:   accountapp.ErrInvalidAccountExport,
			credential: 1,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			reader, createErr := accountapp.NewExportReader(
				test.source,
				test.source,
				test.source,
			)
			if createErr != nil {
				t.Fatalf("NewExportReader() error = %v", createErr)
			}
			_, readErr := reader.ReadAccountExport(
				context.Background(),
				accountRef,
			)
			if !errors.Is(readErr, test.expected) {
				t.Fatalf("ReadAccountExport() error = %v", readErr)
			}
			if test.source.credentialCalls != test.credential ||
				test.source.profileCalls != test.profile {
				t.Fatalf(
					"错误后仍继续读取: credential=%d profile=%d",
					test.source.credentialCalls,
					test.source.profileCalls,
				)
			}
		})
	}
}

// TestExportReaderRejectsMissingDependencies 验证用例不会以 nil 端口运行。
func TestExportReaderRejectsMissingDependencies(t *testing.T) {
	t.Parallel()

	source := &exportReaderSource{}
	tests := []struct {
		accounts    accountapp.ExportAccountStore
		credentials accountapp.ExportCredentialStore
		profiles    accountapp.ExportProfileStore
	}{
		{credentials: source, profiles: source},
		{accounts: source, profiles: source},
		{accounts: source, credentials: source},
	}
	for _, test := range tests {
		_, err := accountapp.NewExportReader(
			test.accounts,
			test.credentials,
			test.profiles,
		)
		if !errors.Is(err, accountapp.ErrInvalidExportDependencies) {
			t.Fatalf("NewExportReader() error = %v", err)
		}
	}
}

// exportReaderSource 是三个导出读取端口共享的可观察测试替身。
type exportReaderSource struct {
	account         accountcore.Account
	accountErr      error
	credential      accountapp.Credential
	bindingRef      accountcore.AccountRef
	credentialErr   error
	credentialCalls int
	profile         accountapp.ProfileSnapshot
	profileErr      error
	profileCalls    int
}

// GetByRef 返回预设基础账号。
func (source *exportReaderSource) GetByRef(
	context.Context,
	accountcore.AccountRef,
) (accountcore.Account, error) {
	return source.account, source.accountErr
}

// GetCredentialBinding 返回预设领域凭据及其账号绑定。
func (source *exportReaderSource) GetCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	source.credentialCalls++
	if source.credentialErr != nil {
		return accountapp.CredentialBinding{}, source.credentialErr
	}
	bindingRef := source.bindingRef
	if !bindingRef.IsValid() {
		bindingRef = accountRef
	}
	return accountapp.NewCredentialBinding(
		bindingRef,
		source.credential.ProviderID(),
		source.credential,
	)
}

// GetProfile 返回预设公开资料快照。
func (source *exportReaderSource) GetProfile(
	context.Context,
	accountcore.AccountRef,
) (accountapp.ProfileSnapshot, error) {
	source.profileCalls++
	return source.profile, source.profileErr
}

// exportProfileStub 提供与凭据同源的最小公开资料。
type exportProfileStub struct {
	providerID   string
	identitySeed string
}

// ProviderID 返回测试资料的 Provider。
func (profile exportProfileStub) ProviderID() string {
	return profile.providerID
}

// IdentitySeed 返回与测试凭据相同的稳定身份。
func (profile exportProfileStub) IdentitySeed() string {
	return profile.identitySeed
}

// IsValid 判断测试资料是否包含身份。
func (profile exportProfileStub) IsValid() bool {
	return profile.identitySeed != ""
}

// DisplayName 返回合成展示名。
func (exportProfileStub) DisplayName() string {
	return "Export Reader"
}

// Email 返回合成邮箱。
func (exportProfileStub) Email() string {
	return "export-reader@example.invalid"
}

// SubscriptionKind 返回明确的未知订阅分类。
func (exportProfileStub) SubscriptionKind() string {
	return "unknown"
}

// SubscriptionRaw 表示测试资料没有上游订阅原值。
func (exportProfileStub) SubscriptionRaw() string {
	return ""
}

// newExportReaderAccount 创建与凭据绑定的稳定基础账号。
func newExportReaderAccount(
	t *testing.T,
	credential accountapp.Credential,
) accountcore.Account {
	t.Helper()

	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(
		testCatalog(t),
		accountcore.NewAccountInput{
			Identity:     credential,
			CLIAccountID: alias,
			CreatedAt:    time.Date(2026, time.July, 31, 1, 2, 3, 0, time.UTC),
		},
	)
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return account
}

// newExportReaderAccountWithRef 创建只用于验证读取短路的有效恢复账号。
func newExportReaderAccountWithRef(
	t *testing.T,
	accountRef accountcore.AccountRef,
) accountcore.Account {
	t.Helper()

	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	now := time.Date(2026, time.July, 31, 1, 2, 3, 0, time.UTC)
	account, err := accountcore.RestoreAccount(
		testCatalog(t),
		accountcore.RestoreAccountInput{
			Ref:          accountRef,
			ProviderID:   codex.ProviderID,
			CLIAccountID: alias,
			Enabled:      true,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
	)
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}
