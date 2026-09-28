package aihserver

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// failingRuntime 只实现被装饰的两个方法；其余方法不应被调用。
type failingRuntime struct {
	serverAccountRuntime
	err error
}

func (runtime failingRuntime) RecordSuccess(context.Context, runtimecore.ModelRoute, inferencegateway.AttemptSuccess) error {
	return runtime.err
}

func (runtime failingRuntime) RecordFailure(context.Context, runtimecore.ModelRoute, inferencegateway.AttemptFailure) error {
	return runtime.err
}

type captureStore struct {
	mu     sync.Mutex
	deltas []accountoutcomes.Delta
}

func (store *captureStore) AddAccountOutcomes(_ context.Context, deltas []accountoutcomes.Delta) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.deltas = append(store.deltas, deltas...)
	return nil
}

func (*captureStore) ListAccountOutcomes(context.Context, accountoutcomes.Granularity, int64) ([]accountoutcomes.Bucket, error) {
	return nil, nil
}

func (*captureStore) PruneAccountOutcomes(context.Context, accountoutcomes.Granularity, int64) error {
	return nil
}

// TestOutcomeRecordingRuntimeNeverChangesTheResult 验证装饰器原样返回内部运行态的结果，
// 并为成功计数；统计永不影响推理结果。
func TestOutcomeRecordingRuntimeNeverChangesTheResult(t *testing.T) {
	t.Parallel()

	store := &captureStore{}
	recorder, err := accountoutcomes.NewRecorder(accountoutcomes.RecorderOptions{
		Store: store, Clock: time.Now, FlushInterval: time.Hour, Location: time.UTC,
	})
	if err != nil {
		t.Fatalf("NewRecorder() error = %v", err)
	}
	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	route, err := runtimecore.NewModelRoute(ref, "gpt-6-astra")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	inner := errors.New("synthetic runtime error")
	runtime := outcomeRecordingRuntime{serverAccountRuntime: failingRuntime{err: inner}, outcomes: recorder}
	if got := runtime.RecordSuccess(context.Background(), route, inferencegateway.AttemptSuccess{}); !errors.Is(got, inner) {
		t.Fatalf("RecordSuccess() = %v, want inner error passed through", got)
	}
	ok := outcomeRecordingRuntime{serverAccountRuntime: failingRuntime{}, outcomes: recorder}
	if got := ok.RecordSuccess(context.Background(), route, inferencegateway.AttemptSuccess{}); got != nil {
		t.Fatalf("RecordSuccess() = %v, want nil", got)
	}
	if err := recorder.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	for _, delta := range store.deltas {
		if delta.Outcome != accountoutcomes.OutcomeSuccess || delta.Count != 2 {
			t.Fatalf("delta = %#v", delta)
		}
	}
	if len(store.deltas) != 2 {
		t.Fatalf("deltas = %d, want day + hour", len(store.deltas))
	}
}

// snapshotRuntime 是支持运行态快照的替身。
type snapshotRuntime struct {
	failingRuntime
	views []runtimeapp.AccountView
}

func (runtime snapshotRuntime) RuntimeSnapshot() []runtimeapp.AccountView { return runtime.views }

// TestOutcomeRecordingRuntimeSnapshotMergesLastActivity 验证快照合并运行态阻塞与最近结果：
// 有阻塞的账号带上最近失败，仅有活动的健康账号也出现（账号页「上次成功使用」）。
func TestOutcomeRecordingRuntimeSnapshotMergesLastActivity(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	recorder, err := accountoutcomes.NewRecorder(accountoutcomes.RecorderOptions{
		Store: &captureStore{}, Clock: func() time.Time { return now }, FlushInterval: time.Hour, Location: time.UTC,
	})
	if err != nil {
		t.Fatalf("NewRecorder() error = %v", err)
	}
	blockedRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0001")
	healthyRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0002")
	recorder.Record(blockedRef, string(runtimecore.FailureCredentialRejected))
	recorder.Record(healthyRef, accountoutcomes.OutcomeSuccess)

	runtime := outcomeRecordingRuntime{
		serverAccountRuntime: snapshotRuntime{views: []runtimeapp.AccountView{{
			AccountRef: blockedRef,
			Blocks:     []runtimecore.RecoveryTrigger{runtimecore.RecoveryCredentialsUpdated},
		}}},
		outcomes: recorder,
	}
	views := runtime.RuntimeSnapshot()
	if len(views) != 2 {
		t.Fatalf("views = %+v, want blocked + healthy", views)
	}
	blocked, healthy := views[0], views[1]
	if blocked.AccountRef != blockedRef || len(blocked.Blocks) != 1 ||
		!blocked.LastFailureAt.Equal(now) || blocked.LastFailureKind != string(runtimecore.FailureCredentialRejected) ||
		!blocked.LastSuccessAt.IsZero() {
		t.Fatalf("blocked view = %+v", blocked)
	}
	if healthy.AccountRef != healthyRef || len(healthy.Blocks) != 0 ||
		!healthy.LastSuccessAt.Equal(now) || !healthy.LastFailureAt.IsZero() {
		t.Fatalf("healthy view = %+v", healthy)
	}
}
