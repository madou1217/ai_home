package accounts

import (
	"context"
	"errors"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrAccountReKeyConflict 表示新身份对应的账号已经存在，或旧账号不存在。
	ErrAccountReKeyConflict = errors.New("账号身份迁移目标冲突")
	// ErrAccountReKeyUnsupported 表示当前存储或部署不允许迁移账号身份。
	ErrAccountReKeyUnsupported = errors.New("账号身份迁移不受支持")
)

// AccountReKeyStore 把一次刷新产生的新稳定身份迁移到新的 AccountRef。
//
// 刷新只在 Go 自己负责凭据的账号上触发迁移（Node 台账里的账号由宿主维护身份
// 映射，Go 不能替它改）。实现必须在单个事务里搬完账号、凭据和全部从属快照，
// 任何一步失败都不能留下半迁移状态。
type AccountReKeyStore interface {
	ReKeyAccount(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		credential Credential,
		updatedAt time.Time,
	) (CredentialSnapshot, error)
}
