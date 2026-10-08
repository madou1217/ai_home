package inmemory

import (
	"context"
	"sync"
	"testing"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// restartStateStore 是跨「进程重启」保留冷却的内存替身。
type restartStateStore struct {
	mu   sync.Mutex
	rows map[string]runtimeapp.PersistedModelState
}

func newRestartStateStore() *restartStateStore {
	return &restartStateStore{rows: make(map[string]runtimeapp.PersistedModelState)}
}

func restartStoreKey(route runtimecore.ModelRoute) string {
	return route.AccountRef().String() + "|" + route.ModelID().String()
}

func (store *restartStateStore) LoadModelStates(
	ctx context.Context,
) ([]runtimeapp.PersistedModelState, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	entries := make([]runtimeapp.PersistedModelState, 0, len(store.rows))
	for _, entry := range store.rows {
		entries = append(entries, entry)
	}
	return entries, nil
}

func (store *restartStateStore) SaveModelState(
	ctx context.Context,
	entry runtimeapp.PersistedModelState,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.rows[restartStoreKey(entry.Route)] = entry
	return nil
}

func (store *restartStateStore) DeleteModelState(
	ctx context.Context,
	route runtimecore.ModelRoute,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.rows, restartStoreKey(route))
	return nil
}

// TestRuntimeRestoresModelCooldownAfterRestart 验证运行态分发器重建后仍拦住刚被
// 限流的账号模型，且不牵连同账号的其它模型。
func TestRuntimeRestoresModelCooldownAfterRestart(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := runtimeTestTime()
	cooled := newTestRoute(t, 1, "gpt-5.6-sol")
	sibling := newTestRoute(t, 1, "gpt-5.4")
	store := newRestartStateStore()

	first, err := NewWithStore(ctx, func() time.Time { return now }, store, nil)
	if err != nil {
		t.Fatalf("NewWithStore() error = %v", err)
	}
	if err := first.RecordFailure(
		ctx,
		cooled,
		newCooldownFailure(t, runtimecore.FailureRateLimited, 5*time.Minute),
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	assertEligibilityStatus(
		t,
		first,
		cooled,
		runtimecore.EligibilityModelCooldown,
	)

	restarted, err := NewWithStore(
		ctx,
		func() time.Time { return now.Add(time.Minute) },
		store,
		nil,
	)
	if err != nil {
		t.Fatalf("NewWithStore(restart) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		restarted,
		cooled,
		runtimecore.EligibilityModelCooldown,
	)
	assertEligibilityStatus(
		t,
		restarted,
		sibling,
		runtimecore.EligibilityAvailable,
	)
	if restarted.PersistError() != nil {
		t.Fatalf("PersistError() = %v, want nil", restarted.PersistError())
	}

	// 冷却到期后重启不再拦路由，且存储行被回收。
	expired, err := NewWithStore(
		ctx,
		func() time.Time { return now.Add(10 * time.Minute) },
		store,
		nil,
	)
	if err != nil {
		t.Fatalf("NewWithStore(expired) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		expired,
		cooled,
		runtimecore.EligibilityAvailable,
	)
	store.mu.Lock()
	remaining := len(store.rows)
	store.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("过期冷却仍留在存储中: %d 行", remaining)
	}
}

// TestRuntimeSuccessClearsPersistedCooldown 验证一次成功把冷却从存储中一并删除。
func TestRuntimeSuccessClearsPersistedCooldown(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := runtimeTestTime()
	route := newTestRoute(t, 1, "gpt-5.6-sol")
	store := newRestartStateStore()
	runtime, err := NewWithStore(ctx, func() time.Time { return now }, store, nil)
	if err != nil {
		t.Fatalf("NewWithStore() error = %v", err)
	}
	if err := runtime.RecordFailure(
		ctx,
		route,
		newCooldownFailure(t, runtimecore.FailureRateLimited, 5*time.Minute),
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if err := runtime.RecordSuccess(
		ctx,
		route,
		newRuntimeSuccess(t, now.Add(30*time.Second)),
	); err != nil {
		t.Fatalf("RecordSuccess() error = %v", err)
	}

	restarted, err := NewWithStore(
		ctx,
		func() time.Time { return now.Add(time.Minute) },
		store,
		nil,
	)
	if err != nil {
		t.Fatalf("NewWithStore(restart) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		restarted,
		route,
		runtimecore.EligibilityAvailable,
	)
}
