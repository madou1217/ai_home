package accountruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// memoryStateStore 是运行态持久化的确定性内存替身。
type memoryStateStore struct {
	mu sync.Mutex
	// rows 按「账号|模型」保存最近一次写入的投影。
	rows map[string]PersistedModelState
	// loads / saves / deletes 记录调用次数，用于断言写路径没有放大。
	loads   int
	saves   int
	deletes int
	// failSave 为真时所有写入失败，用于验证降级路径。
	failSave bool
}

func newMemoryStateStore() *memoryStateStore {
	return &memoryStateStore{rows: make(map[string]PersistedModelState)}
}

func stateStoreKey(route runtimecore.ModelRoute) string {
	return route.AccountRef().String() + "|" + route.ModelID().String()
}

func (store *memoryStateStore) LoadModelStates(
	ctx context.Context,
) ([]PersistedModelState, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.loads++
	entries := make([]PersistedModelState, 0, len(store.rows))
	for _, entry := range store.rows {
		entries = append(entries, entry)
	}
	return entries, nil
}

func (store *memoryStateStore) SaveModelState(
	ctx context.Context,
	entry PersistedModelState,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.saves++
	if store.failSave {
		return errors.New("存储写入失败")
	}
	store.rows[stateStoreKey(entry.Route)] = entry
	return nil
}

func (store *memoryStateStore) DeleteModelState(
	ctx context.Context,
	route runtimecore.ModelRoute,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.deletes++
	delete(store.rows, stateStoreKey(route))
	return nil
}

func (store *memoryStateStore) snapshot() map[string]PersistedModelState {
	store.mu.Lock()
	defer store.mu.Unlock()
	copied := make(map[string]PersistedModelState, len(store.rows))
	for key, entry := range store.rows {
		copied[key] = entry
	}
	return copied
}

// TestRegistryPersistsCooldownAcrossRestart 验证冷却写入存储后，新进程立即按同一
// 解除时间拦住被限流的模型。
func TestRegistryPersistsCooldownAcrossRestart(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := registryTestTime()
	route := registryTestRoute(t, 1, "gpt-5.6-sol")
	store := newMemoryStateStore()

	registry, err := NewRegistryWithStore(
		ctx,
		func() time.Time { return now },
		store,
	)
	if err != nil {
		t.Fatalf("NewRegistryWithStore() error = %v", err)
	}
	if _, err := registry.RecordFailure(
		ctx,
		route,
		runtimecore.FailureRateLimited,
		2*time.Minute,
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if registry.PersistError() != nil {
		t.Fatalf("PersistError() = %v, want nil", registry.PersistError())
	}

	restarted, err := NewRegistryWithStore(
		ctx,
		func() time.Time { return now.Add(time.Minute) },
		store,
	)
	if err != nil {
		t.Fatalf("NewRegistryWithStore(restart) error = %v", err)
	}
	eligibility, err := restarted.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() ||
		eligibility.Status() != runtimecore.EligibilityModelCooldown ||
		!eligibility.RetryAt().Equal(now.Add(2*time.Minute)) {
		t.Fatalf("重启后资格 = %#v", eligibility)
	}

	afterExpiry, err := NewRegistryWithStore(
		ctx,
		func() time.Time { return now.Add(3 * time.Minute) },
		store,
	)
	if err != nil {
		t.Fatalf("NewRegistryWithStore(expired) error = %v", err)
	}
	if afterExpiry.Len() != 0 {
		t.Fatalf("过期冷却仍被保留: Len() = %d", afterExpiry.Len())
	}
	if len(store.snapshot()) != 0 {
		t.Fatal("过期冷却未从存储中清理")
	}
}

// TestRegistryDropsCorruptPersistedStateOnLoad 验证损坏的状态行在预载时被丢弃，
// 且不影响其它账号模型的冷却。
func TestRegistryDropsCorruptPersistedStateOnLoad(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := registryTestTime()
	healthy := registryTestRoute(t, 1, "gpt-5.6-sol")
	corrupt := registryTestRoute(t, 2, "gpt-5.6-sol")
	store := newMemoryStateStore()
	store.rows[stateStoreKey(healthy)] = PersistedModelState{
		Route: healthy,
		State: runtimecore.ModelStateSnapshot{
			CooldownKind:  runtimecore.FailureRateLimited,
			CooldownUntil: now.Add(5 * time.Minute),
			LastFailureAt: now,
		},
	}
	store.rows[stateStoreKey(corrupt)] = PersistedModelState{
		Route: corrupt,
		State: runtimecore.ModelStateSnapshot{
			CooldownKind:  "made_up_kind",
			CooldownUntil: now.Add(5 * time.Minute),
			LastFailureAt: now,
		},
	}

	registry, err := NewRegistryWithStore(
		ctx,
		func() time.Time { return now },
		store,
	)
	if err != nil {
		t.Fatalf("NewRegistryWithStore() error = %v", err)
	}
	if registry.Len() != 1 {
		t.Fatalf("Len() = %d, want 1", registry.Len())
	}
	eligibility, err := registry.CheckEligibility(ctx, corrupt)
	if err != nil {
		t.Fatalf("CheckEligibility(corrupt) error = %v", err)
	}
	if !eligibility.Eligible() {
		t.Fatalf("损坏行仍在拦路由: %#v", eligibility)
	}
	if len(store.snapshot()) != 1 {
		t.Fatal("损坏行未从存储中清理")
	}
}

// TestRegistryKeepsCooldownWhenPersistenceFails 验证存储写失败不会让冷却失效，
// 也不会把正常请求判为失败，同时失败可观测。
func TestRegistryKeepsCooldownWhenPersistenceFails(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := registryTestTime()
	route := registryTestRoute(t, 1, "gpt-5.6-sol")
	store := newMemoryStateStore()
	store.failSave = true
	observed := 0
	registry, err := NewRegistryWithStore(
		ctx,
		func() time.Time { return now },
		store,
		WithPersistErrorObserver(func(error) { observed++ }),
	)
	if err != nil {
		t.Fatalf("NewRegistryWithStore() error = %v", err)
	}

	if _, err := registry.RecordFailure(
		ctx,
		route,
		runtimecore.FailureRateLimited,
		2*time.Minute,
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	eligibility, err := registry.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() {
		t.Fatalf("持久化失败时冷却未生效: %#v", eligibility)
	}
	if registry.PersistError() == nil {
		t.Fatal("持久化失败未被记录")
	}
	if observed != 1 {
		t.Fatalf("观测出口调用 %d 次, want 1", observed)
	}
}

// TestRegistryDoesNotWriteOnEligibilityReads 验证读取路径不产生存储写入。
func TestRegistryDoesNotWriteOnEligibilityReads(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := registryTestTime()
	route := registryTestRoute(t, 1, "gpt-5.6-sol")
	store := newMemoryStateStore()
	registry, err := NewRegistryWithStore(
		ctx,
		func() time.Time { return now },
		store,
	)
	if err != nil {
		t.Fatalf("NewRegistryWithStore() error = %v", err)
	}
	if _, err := registry.RecordFailure(
		ctx,
		route,
		runtimecore.FailureRateLimited,
		2*time.Minute,
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	store.mu.Lock()
	beforeSaves := store.saves
	store.mu.Unlock()

	for range 5 {
		if _, err := registry.CheckEligibility(ctx, route); err != nil {
			t.Fatalf("CheckEligibility() error = %v", err)
		}
	}
	// 冷却到期后的读取会回收内存状态，但同样不应产生存储写入。
	if _, err := registry.CheckEligibility(
		ctx,
		route,
	); err != nil && !errors.Is(err, runtimecore.ErrInvalidRuntimeTime) {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	store.mu.Lock()
	afterSaves := store.saves
	store.mu.Unlock()
	if afterSaves != beforeSaves {
		t.Fatalf("读取路径产生写入: saves %d -> %d", beforeSaves, afterSaves)
	}
}

// TestRegistryForgetsPersistedStateForDeletedAccount 验证账号被遗忘时存储同步清理。
func TestRegistryForgetsPersistedStateForDeletedAccount(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := registryTestTime()
	first := registryTestRoute(t, 1, "gpt-5.6-sol")
	second := registryTestRoute(t, 2, "gpt-5.6-sol")
	store := newMemoryStateStore()
	registry, err := NewRegistryWithStore(
		ctx,
		func() time.Time { return now },
		store,
	)
	if err != nil {
		t.Fatalf("NewRegistryWithStore() error = %v", err)
	}
	for _, route := range []runtimecore.ModelRoute{first, second} {
		if _, err := registry.RecordFailure(
			ctx,
			route,
			runtimecore.FailureRateLimited,
			time.Minute,
		); err != nil {
			t.Fatalf("RecordFailure() error = %v", err)
		}
	}

	registry.ForgetAccount(accountRefOf(t, first))
	if registry.Len() != 1 {
		t.Fatalf("Len() = %d, want 1", registry.Len())
	}
	remaining := store.snapshot()
	if len(remaining) != 1 {
		t.Fatalf("存储剩余 %d 行, want 1", len(remaining))
	}
	if _, found := remaining[stateStoreKey(first)]; found {
		t.Fatal("被遗忘账号的冷却仍留在存储中")
	}
}

// accountRefOf 取出元组的账号身份。
func accountRefOf(
	t *testing.T,
	route runtimecore.ModelRoute,
) accountcore.AccountRef {
	t.Helper()

	return route.AccountRef()
}
