package accounts

import (
	"context"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidExportDependencies 表示单账号导出读取器缺少必要端口。
	ErrInvalidExportDependencies = errors.New("账号导出依赖无效")
	// ErrInvalidAccountExport 表示账号快照或标准导出结果无效。
	ErrInvalidAccountExport = errors.New("账号导出数据无效")
	// ErrUnsupportedAccountExport 表示目标凭据无法映射到声明的外部合同。
	ErrUnsupportedAccountExport = errors.New("账号导出类型不受支持")
)

// ExportAccountStore 是单账号导出读取基础身份所需的最小端口。
type ExportAccountStore interface {
	// GetByRef 按稳定账号身份读取基础账号。
	GetByRef(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.Account, error)
}

// ExportCredentialStore 是单账号导出读取领域凭据所需的最小端口。
type ExportCredentialStore interface {
	// GetCredential 按稳定账号身份读取已校验凭据。
	GetCredential(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (Credential, error)
}

// ExportProfileStore 是单账号导出读取可选公开资料所需的最小端口。
type ExportProfileStore interface {
	// GetProfile 按稳定账号身份读取公开资料快照。
	GetProfile(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (ProfileSnapshot, error)
}

// ExportSnapshot 是外部格式适配器可读取的单账号一致快照。
//
// 该值不包含模型、usage、运行态、cooldown 或本地迁移元数据。
type ExportSnapshot struct {
	account    accountcore.Account
	credential Credential
	profile    PublicProfile
}

// Account 返回不包含凭据内容的基础账号。
func (snapshot ExportSnapshot) Account() accountcore.Account {
	return snapshot.account
}

// Credential 返回经过 Provider 领域构造器校验的凭据。
func (snapshot ExportSnapshot) Credential() Credential {
	return snapshot.credential
}

// Profile 返回可选公开资料及其存在标记。
func (snapshot ExportSnapshot) Profile() (PublicProfile, bool) {
	return snapshot.profile, snapshot.profile != nil
}

// ExportReader 只负责组合导出所需的三个账号事实来源。
type ExportReader struct {
	accounts    ExportAccountStore
	credentials ExportCredentialStore
	profiles    ExportProfileStore
}

// NewExportReader 创建不依赖数据库实现或外部 JSON 格式的读取用例。
func NewExportReader(
	accounts ExportAccountStore,
	credentials ExportCredentialStore,
	profiles ExportProfileStore,
) (*ExportReader, error) {
	if accounts == nil || credentials == nil || profiles == nil {
		return nil, ErrInvalidExportDependencies
	}
	return &ExportReader{
		accounts:    accounts,
		credentials: credentials,
		profiles:    profiles,
	}, nil
}

// ReadAccountExport 按固定顺序读取账号、凭据和可选公开资料。
func (reader *ExportReader) ReadAccountExport(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (ExportSnapshot, error) {
	if reader == nil ||
		reader.accounts == nil ||
		reader.credentials == nil ||
		reader.profiles == nil {
		return ExportSnapshot{}, ErrInvalidExportDependencies
	}
	if !accountRef.IsValid() {
		return ExportSnapshot{}, accountcore.ErrInvalidAccountRef
	}
	account, err := reader.accounts.GetByRef(ctx, accountRef)
	if err != nil {
		return ExportSnapshot{}, err
	}
	if !account.IsValid() || account.Ref() != accountRef {
		return ExportSnapshot{}, ErrInvalidAccountExport
	}
	credential, err := reader.credentials.GetCredential(ctx, accountRef)
	if err != nil {
		return ExportSnapshot{}, err
	}
	if !credentialMatchesAccount(accountRef, credential) ||
		credential.ProviderID() != account.ProviderID() {
		return ExportSnapshot{}, ErrInvalidAccountExport
	}
	profile, err := reader.readOptionalProfile(ctx, account)
	if err != nil {
		return ExportSnapshot{}, err
	}
	return ExportSnapshot{
		account:    account,
		credential: credential,
		profile:    profile,
	}, nil
}

// readOptionalProfile 只忽略明确的资料不存在，不吞掉损坏或数据库错误。
func (reader *ExportReader) readOptionalProfile(
	ctx context.Context,
	account accountcore.Account,
) (PublicProfile, error) {
	snapshot, err := reader.profiles.GetProfile(ctx, account.Ref())
	if errors.Is(err, ErrProfileNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	profile := snapshot.Profile()
	if profile == nil {
		return nil, ErrInvalidAccountExport
	}
	profileRef, identityErr := accountcore.DeriveAccountRef(profile)
	if !profile.IsValid() ||
		snapshot.AccountRef() != account.Ref() ||
		profileRef != account.Ref() ||
		identityErr != nil ||
		profile.ProviderID() != account.ProviderID() {
		return nil, ErrInvalidAccountExport
	}
	return profile, nil
}
