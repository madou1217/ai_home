package aihserver

import (
	"context"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// accountProbeStateStore 把存储层适配成管理接口的探针端口。
//
// 传输层不直接依赖 sqlite 适配器：类型转换集中在这里，换存储只改这一处。
type accountProbeStateStore struct {
	store *sqliteaccount.Store
}

func (adapter accountProbeStateStore) UpsertProbeState(
	ctx context.Context,
	accountRef string,
	state accountsapi.ProbeState,
) error {
	if adapter.store == nil {
		return nil
	}
	return adapter.store.UpsertProbeState(ctx, accountRef, sqliteaccount.ProbeState{
		Status:      state.Status,
		Error:       state.Error,
		CheckedAtMS: state.CheckedAtMS,
	})
}
