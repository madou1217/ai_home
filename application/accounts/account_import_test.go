package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestAccountImporterCreatesNewAggregate 验证首次导入仍只走注册用例。
func TestAccountImporterCreatesNewAggregate(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "import-new-key"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	account := newImportedAccount(t, credential, 1)
	registration := &importRegistrationStub{account: account}
	reader := &importAccountReaderStub{}
	reauthentication := &importReauthenticationStub{}
	importer, err := accountapp.NewAccountImporter(
		registration,
		reader,
		reauthentication,
	)
	if err != nil {
		t.Fatalf("NewAccountImporter() error = %v", err)
	}

	result, err := importer.Import(context.Background(), credential, nil)
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if result.Account() != account || !result.Created() ||
		registration.calls != 1 || reader.calls != 0 || reauthentication.calls != 0 {
		t.Fatalf("result=%#v registration=%d reader=%d reauthentication=%d", result, registration.calls, reader.calls, reauthentication.calls)
	}
}

// TestAccountImporterReauthenticatesExistingOAuthAggregate 验证同一 OAuth 身份
// 再导入会更新原聚合，而不是创建影子账号或返回无意义冲突。
func TestAccountImporterReauthenticatesExistingOAuthAggregate(t *testing.T) {
	t.Parallel()

	credential, profile := newClaudeReauthValues(
		t,
		"123e4567-e89b-12d3-a456-426614174301",
		"import-existing",
	)
	existing := newImportedAccount(t, credential, 9)
	registration := &importRegistrationStub{err: accountapp.ErrAccountConflict}
	reader := &importAccountReaderStub{account: existing}
	reauthentication := &importReauthenticationStub{account: existing}
	importer, err := accountapp.NewAccountImporter(
		registration,
		reader,
		reauthentication,
	)
	if err != nil {
		t.Fatalf("NewAccountImporter() error = %v", err)
	}

	result, err := importer.Import(context.Background(), credential, profile)
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if result.Account().Ref() != existing.Ref() || result.Created() ||
		registration.calls != 1 || reader.calls != 1 || reauthentication.calls != 1 ||
		reauthentication.accountRef != existing.Ref() ||
		reauthentication.credential != credential ||
		reauthentication.profile != profile {
		t.Fatalf("result=%#v registration=%d reader=%d reauthentication=%#v", result, registration.calls, reader.calls, reauthentication)
	}
}

// TestAccountImporterTreatsSameStaticIdentityAsIdempotent 验证完全相同的静态
// 凭据重复导入返回既有账号，不把静态凭据误送入 OAuth 重登链。
func TestAccountImporterTreatsSameStaticIdentityAsIdempotent(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "import-static-key"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	existing := newImportedAccount(t, credential, 4)
	registration := &importRegistrationStub{err: accountapp.ErrAccountConflict}
	reader := &importAccountReaderStub{account: existing}
	reauthentication := &importReauthenticationStub{}
	importer, err := accountapp.NewAccountImporter(
		registration,
		reader,
		reauthentication,
	)
	if err != nil {
		t.Fatalf("NewAccountImporter() error = %v", err)
	}

	result, err := importer.Import(context.Background(), credential, nil)
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if result.Account() != existing || result.Created() ||
		reader.calls != 1 || reauthentication.calls != 0 {
		t.Fatalf("result=%#v reader=%d reauthentication=%d", result, reader.calls, reauthentication.calls)
	}
}

// TestAccountImporterReauthenticatesRefreshableOAuthWithoutProfile 验证公开
// 资料缺失不等于静态凭据；可刷新 OAuth 仍须把新 Token 原地写回。
func TestAccountImporterReauthenticatesRefreshableOAuthWithoutProfile(t *testing.T) {
	t.Parallel()

	credential, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "import-profileless-access",
		RefreshToken: "import-profileless-refresh",
		ExpiresAtMS:  4_102_444_800_000,
		Scopes:       []string{claude.InferenceScope},
		Identity: claude.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174399",
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	existing := newImportedAccount(t, credential, 11)
	registration := &importRegistrationStub{err: accountapp.ErrAccountConflict}
	reader := &importAccountReaderStub{account: existing}
	reauthentication := &importReauthenticationStub{account: existing}
	importer, err := accountapp.NewAccountImporter(
		registration,
		reader,
		reauthentication,
	)
	if err != nil {
		t.Fatalf("NewAccountImporter() error = %v", err)
	}

	result, err := importer.Import(context.Background(), credential, nil)
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if result.Created() || result.Account().Ref() != existing.Ref() ||
		reader.calls != 1 || reauthentication.calls != 1 ||
		reauthentication.credential != credential ||
		reauthentication.profile != nil {
		t.Fatalf(
			"result=%#v reader=%d reauthentication=%#v",
			result,
			reader.calls,
			reauthentication,
		)
	}
}

// TestAccountImporterFailsClosedWhenConflictCannotResolveIdentity 验证冲突后的
// 持久账号若不属于导入身份，不会被错误更新。
func TestAccountImporterFailsClosedWhenConflictCannotResolveIdentity(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "import-target-key"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	otherCredential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "import-other-key"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth(other) error = %v", err)
	}
	registration := &importRegistrationStub{err: accountapp.ErrAccountConflict}
	reader := &importAccountReaderStub{account: newImportedAccount(t, otherCredential, 8)}
	reauthentication := &importReauthenticationStub{}
	importer, err := accountapp.NewAccountImporter(registration, reader, reauthentication)
	if err != nil {
		t.Fatalf("NewAccountImporter() error = %v", err)
	}

	_, err = importer.Import(context.Background(), credential, nil)
	if !errors.Is(err, accountapp.ErrInvalidAccountImport) || reauthentication.calls != 0 {
		t.Fatalf("Import() error=%v reauthentication=%d", err, reauthentication.calls)
	}
}

// TestAccountImporterRetriesNewerOAuthAfterConcurrentCredentialWrite 验证可
// 证明更新的 OAuth generation 在 CAS 冲突后会重读并继续收敛。
func TestAccountImporterRetriesNewerOAuthAfterConcurrentCredentialWrite(
	t *testing.T,
) {
	t.Parallel()

	const accountUUID = "123e4567-e89b-12d3-a456-426614174395"
	newest := newClaudeImportCredential(t, accountUUID, "newest", 1_800_000_120_000)
	existing := newImportedAccount(t, newest, 12)
	reader := &importAccountReaderStub{account: existing}
	registration := &importRegistrationStub{err: accountapp.ErrAccountConflict}
	reauthentication := &importReauthenticationStub{
		account: existing,
		errors:  []error{accountapp.ErrReauthenticationConflict, nil},
	}
	importer, err := accountapp.NewAccountImporter(
		registration,
		reader,
		reauthentication,
	)
	if err != nil {
		t.Fatalf("NewAccountImporter() error = %v", err)
	}

	result, err := importer.Import(context.Background(), newest, nil)
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if result.Created() || result.Account().Ref() != existing.Ref() ||
		reader.calls != 1 || reauthentication.calls != 2 {
		t.Fatalf(
			"result=%#v reads=%d reauthentication=%d",
			result,
			reader.calls,
			reauthentication.calls,
		)
	}
}

type importRegistrationStub struct {
	account accountcore.Account
	err     error
	calls   int
}

func (stub *importRegistrationStub) Register(
	context.Context,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	stub.calls++
	return stub.account, stub.err
}

type importAccountReaderStub struct {
	account accountcore.Account
	err     error
	calls   int
}

func (stub *importAccountReaderStub) GetByRef(
	context.Context,
	accountcore.AccountRef,
) (accountcore.Account, error) {
	stub.calls++
	return stub.account, stub.err
}

type importReauthenticationStub struct {
	account    accountcore.Account
	err        error
	calls      int
	accountRef accountcore.AccountRef
	credential accountapp.Credential
	profile    accountapp.PublicProfile
	errors     []error
}

func (stub *importReauthenticationStub) Reauthenticate(
	_ context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	stub.calls++
	stub.accountRef = accountRef
	stub.credential = credential
	stub.profile = profile
	if stub.calls <= len(stub.errors) {
		return stub.account, stub.errors[stub.calls-1]
	}
	return stub.account, stub.err
}

func newClaudeImportCredential(
	t *testing.T,
	accountUUID string,
	label string,
	expiresAtMS int64,
) *claude.OAuthAuth {
	t.Helper()

	credential, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "import-" + label + "-access",
		RefreshToken: "import-" + label + "-refresh",
		ExpiresAtMS:  expiresAtMS,
		Scopes:       []string{claude.InferenceScope},
		Identity: claude.OAuthIdentity{
			AccountUUID: accountUUID,
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return credential
}

func newImportedAccount(
	t *testing.T,
	credential accountapp.Credential,
	cliAccountID int64,
) accountcore.Account {
	t.Helper()

	alias, err := accountcore.NewCLIAccountID(cliAccountID)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return account
}
