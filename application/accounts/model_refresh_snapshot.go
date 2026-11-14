package accounts

import (
	"context"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// AccountModelRefreshSnapshot 明确表达模型事务实际所属的账号。
// OAuth 刷新可合法 re-key；空模型列表也不能迫使调用方猜测或复用旧身份。
type AccountModelRefreshSnapshot struct {
	AccountRef accountcore.AccountRef
	Models     []AccountModel
}

// AccountModelSnapshotRefresher 是需要身份确认的事务后装饰器使用的窄端口。
// 错误时 AccountRef 可指示刷新过程中已完成的 re-key，不代表目录提交成功。
type AccountModelSnapshotRefresher interface {
	RefreshAccountModelSnapshot(context.Context, accountcore.AccountRef) (AccountModelRefreshSnapshot, error)
}

// RefreshAccountModels 保留旧调用合同；身份敏感的装饰器应使用显式快照端口。
func (management *ModelManagement) RefreshAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]AccountModel, error) {
	snapshot, err := management.RefreshAccountModelSnapshot(ctx, accountRef)
	return snapshot.Models, err
}
