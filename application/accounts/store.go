// Package accounts 定义账号用例依赖的持久化端口和紧凑读取模型。
//
// 该层可以依赖领域模型，但不能依赖 SQLite、文件系统、Server、CLI 或 Provider 运行时。
package accounts

import (
	"context"
	"errors"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrAccountNotFound 表示指定账号不存在。
	ErrAccountNotFound = errors.New("账号不存在")
	// ErrAccountConflict 表示账号引用或 Provider 内 CLI 别名已经被其他账号占用。
	ErrAccountConflict = errors.New("账号冲突")
)

// Store 是账号基础生命周期所需的最小持久化端口。
//
// 凭据、公开资料、usage、模型和运行态使用独立端口，避免账号热路径被冷数据拖慢。
type Store interface {
	// Create 创建一个经过领域校验的基础账号。
	Create(ctx context.Context, account accountcore.Account) error
	// GetByRef 按稳定业务身份读取完整基础账号。
	GetByRef(ctx context.Context, accountRef accountcore.AccountRef) (accountcore.Account, error)
	// GetByCLIAccountID 按 Provider 内用户可见别名读取完整基础账号。
	GetByCLIAccountID(
		ctx context.Context,
		providerID string,
		cliAccountID accountcore.CLIAccountID,
	) (accountcore.Account, error)
	// SetEnabled 原子更新用户启停状态并返回新快照。
	SetEnabled(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		enabled bool,
		changedAt time.Time,
	) (accountcore.Account, error)
	// ListRoutingCandidates 使用稳定游标读取紧凑候选诊断页。
	ListRoutingCandidates(ctx context.Context, query RoutingQuery) ([]RoutingAccount, error)
}
