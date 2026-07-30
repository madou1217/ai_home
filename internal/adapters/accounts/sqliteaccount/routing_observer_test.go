package sqliteaccount

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// TestStorePublishesEveryCommittedRoutingIndexChange 验证账号创建、模型替换和
// 启停都从同一索引边界发送通知，失败或幂等写入不会伪造变化。
func TestStorePublishesEveryCommittedRoutingIndexChange(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	observer := &countingRoutableModelObserver{}
	if err := store.SetRoutableModelObserver(observer); err != nil {
		t.Fatalf("SetRoutableModelObserver() error = %v", err)
	}
	account := newCodexAPIKeyAccount(t, store, 1, "sk-observer-secret")
	if err := store.Create(context.Background(), account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	models, err := accountapp.NormalizeDiscoveredModels(
		[]string{"gpt-5.6-sol"},
	)
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels() error = %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(
		context.Background(),
		account.Ref(),
		models,
		testAccountTime(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
	if _, err := store.SetEnabled(
		context.Background(),
		account.Ref(),
		false,
		testAccountTime().Add(time.Second),
	); err != nil {
		t.Fatalf("SetEnabled() error = %v", err)
	}
	if calls := observer.calls.Load(); calls != 3 {
		t.Fatalf("RoutableModelsChanged() calls = %d, want 3", calls)
	}
}

// countingRoutableModelObserver 只记录同步索引通知次数。
type countingRoutableModelObserver struct {
	calls atomic.Int64
}

func (observer *countingRoutableModelObserver) RoutableModelsChanged() {
	observer.calls.Add(1)
}
