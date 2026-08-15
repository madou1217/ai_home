package accounts

import (
	"context"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const maxAccountImportReauthenticationAttempts = 32

var (
	// ErrInvalidAccountImport 表示导入身份、既有聚合或应用依赖不一致。
	ErrInvalidAccountImport = errors.New("账号导入无效")
	// ErrInvalidAccountImporterDependencies 表示导入用例缺少注册、查询或重登端口。
	ErrInvalidAccountImporterDependencies = errors.New("账号导入依赖无效")
)

// AccountImportRegistration 是导入用例创建新聚合所需的最小端口。
type AccountImportRegistration interface {
	Register(
		ctx context.Context,
		credential Credential,
		profile PublicProfile,
	) (accountcore.Account, error)
}

// AccountImportReader 是冲突后确认既有稳定聚合所需的最小端口。
type AccountImportReader interface {
	GetByRef(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.Account, error)
}

// AccountImportReauthentication 是同身份 OAuth 再导入所需的最小端口。
type AccountImportReauthentication interface {
	Reauthenticate(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		credential Credential,
		profile PublicProfile,
	) (accountcore.Account, error)
}

// refreshableImportCredential 用最小能力接口识别需要原地更新的 OAuth 凭据。
// 公开资料可能缺失，不能用 profile 是否为空推断认证生命周期。
type refreshableImportCredential interface {
	RefreshToken() string
}

// AccountImportResult 区分新建与同身份更新，同时只返回公开基础账号。
type AccountImportResult struct {
	account accountcore.Account
	created bool
}

// Account 返回最终持久聚合。
func (result AccountImportResult) Account() accountcore.Account {
	return result.account
}

// Created 表示本次导入创建了新聚合；false 表示幂等命中或同身份更新。
func (result AccountImportResult) Created() bool {
	return result.created
}

// AccountImporter 统一新建、静态幂等和 OAuth 同身份更新语义。
type AccountImporter struct {
	registration     AccountImportRegistration
	accounts         AccountImportReader
	reauthentication AccountImportReauthentication
}

// NewAccountImporter 创建依赖完整的账号导入应用服务。
func NewAccountImporter(
	registration AccountImportRegistration,
	accounts AccountImportReader,
	reauthentication AccountImportReauthentication,
) (*AccountImporter, error) {
	if registration == nil || accounts == nil || reauthentication == nil {
		return nil, ErrInvalidAccountImporterDependencies
	}
	return &AccountImporter{
		registration:     registration,
		accounts:         accounts,
		reauthentication: reauthentication,
	}, nil
}

// Import 首次创建账号；同一静态身份返回既有聚合，同一 OAuth 身份原地重登。
func (importer *AccountImporter) Import(
	ctx context.Context,
	credential Credential,
	profile PublicProfile,
) (AccountImportResult, error) {
	if importer == nil || ctx == nil || credential == nil {
		return AccountImportResult{}, ErrInvalidAccountImport
	}
	if err := ctx.Err(); err != nil {
		return AccountImportResult{}, err
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		return AccountImportResult{}, ErrInvalidAccountImport
	}
	account, err := importer.registration.Register(ctx, credential, profile)
	if err == nil {
		if !importedAccountMatches(account, accountRef, credential.ProviderID()) {
			return AccountImportResult{}, ErrInvalidAccountImport
		}
		return AccountImportResult{account: account, created: true}, nil
	}
	if !errors.Is(err, ErrAccountConflict) {
		return AccountImportResult{}, err
	}

	existing, err := importer.accounts.GetByRef(ctx, accountRef)
	if err != nil {
		return AccountImportResult{}, err
	}
	if !importedAccountMatches(existing, accountRef, credential.ProviderID()) {
		return AccountImportResult{}, ErrInvalidAccountImport
	}
	if !isRefreshableImportCredential(credential) {
		return AccountImportResult{account: existing}, nil
	}
	return importer.reauthenticateImportedAccount(
		ctx,
		existing,
		accountRef,
		credential,
		profile,
	)
}

// reauthenticateImportedAccount 只重试已由存储 CAS 证明发生竞争的 OAuth
// 更新；事务内 generation 仲裁负责阻止晚到旧凭据覆盖新凭据。
func (importer *AccountImporter) reauthenticateImportedAccount(
	ctx context.Context,
	existing accountcore.Account,
	accountRef accountcore.AccountRef,
	credential Credential,
	profile PublicProfile,
) (AccountImportResult, error) {
	for range maxAccountImportReauthenticationAttempts {
		updated, err := importer.reauthentication.Reauthenticate(
			ctx,
			accountRef,
			credential,
			profile,
		)
		if err == nil {
			if !importedAccountMatches(
				updated,
				accountRef,
				credential.ProviderID(),
			) {
				return AccountImportResult{}, ErrInvalidAccountImport
			}
			return AccountImportResult{account: updated}, nil
		}
		if !errors.Is(err, ErrReauthenticationConflict) {
			return AccountImportResult{}, err
		}
		if contextErr := ctx.Err(); contextErr != nil {
			return AccountImportResult{}, contextErr
		}
	}
	return AccountImportResult{account: existing}, ErrReauthenticationConflict
}

// isRefreshableImportCredential 只判断能力，不读取或复制刷新凭据内容。
func isRefreshableImportCredential(credential Credential) bool {
	_, refreshable := credential.(refreshableImportCredential)
	return refreshable
}

// importedAccountMatches 验证应用端口没有返回其他聚合或 Provider。
func importedAccountMatches(
	account accountcore.Account,
	accountRef accountcore.AccountRef,
	providerID string,
) bool {
	return account.IsValid() &&
		account.Ref() == accountRef &&
		account.ProviderID() == providerID
}
