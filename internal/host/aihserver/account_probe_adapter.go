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

// LoadProbeStates 实现账号列表的读取端口。
func (adapter accountProbeStateStore) LoadProbeStates(
	ctx context.Context,
) (map[string]accountsapi.ProbeState, error) {
	if adapter.store == nil {
		return map[string]accountsapi.ProbeState{}, nil
	}
	states, err := adapter.store.LoadProbeStates(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]accountsapi.ProbeState, len(states))
	for ref, state := range states {
		out[ref] = accountsapi.ProbeState{
			Status:      state.Status,
			Error:       state.Error,
			CheckedAtMS: state.CheckedAtMS,
		}
	}
	return out, nil
}
