package inferencegateway

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
)

// observationInvoker 是 observe 投递的假宿主：把插件收到的事件原样留在内存里。
type observationInvoker struct {
	mu     sync.Mutex
	events []map[string]any
}

func (invoker *observationInvoker) Invoke(_ context.Context, _ int64, _ string, value any, _ time.Duration) (json.RawMessage, error) {
	encoded, _ := json.Marshal(value)
	var event map[string]any
	_ = json.Unmarshal(encoded, &event)
	invoker.mu.Lock()
	invoker.events = append(invoker.events, event)
	invoker.mu.Unlock()
	return json.RawMessage("null"), nil
}

func (invoker *observationInvoker) snapshot() []map[string]any {
	invoker.mu.Lock()
	defer invoker.mu.Unlock()
	return append([]map[string]any(nil), invoker.events...)
}

func (invoker *observationInvoker) waitForEvents(t *testing.T, count int) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if events := invoker.snapshot(); len(events) >= count {
			return events
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("未在期限内收到 %d 条观察事件（实际 %d 条）", count, len(invoker.snapshot()))
	return nil
}

// pinnedObservation 装配一条带 observe 代次的请求上下文，返回事件捕获器。
func pinnedObservation(t *testing.T) (*observationInvoker, context.Context) {
	t.Helper()

	projection := pluginruntime.Projection{
		Generation: 7,
		Contributions: []pluginruntime.Contribution{{
			ID: "obs", Capability: pluginruntime.CapabilityObserve, FailurePolicy: "deny", InstanceID: "p",
		}},
	}
	registry := pluginruntime.NewRegistry()
	if _, err := registry.Replace(pluginruntime.HostAccess{Address: "host", Token: "t"}, []pluginruntime.Projection{projection}, nil); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	invoker := &observationInvoker{}
	observer := pluginruntime.NewObserver(invoker, registry, nil, 4)
	t.Cleanup(observer.Close)
	ctx := pluginruntime.WithPin(
		context.Background(),
		pluginruntime.NewPin(7, projection, observer, time.Now(), nil),
	)
	return invoker, ctx
}

// TestObservedAttemptRecorderObservesStaleCredentialSuccess 验证凭据代次过期时仍投递
// 成功观察事件：运行态清理必须 fail-closed，但这次尝试确实发生过，observe 插件不能漏。
func TestObservedAttemptRecorderObservesStaleCredentialSuccess(t *testing.T) {
	t.Parallel()

	invoker, ctx := pinnedObservation(t)
	observation := newFailureTestObservation(t, failureTestTime().Add(-time.Hour))
	verifier := &credentialObservationVerifierStub{currentAt: failureTestTime()}
	attempts := &credentialObservationAttemptRecorder{}
	recorder, err := NewObservedAttemptRecorder(attempts, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}
	success, err := NewAttemptSuccess(failureTestTime().Add(time.Second))
	if err != nil {
		t.Fatalf("NewAttemptSuccess() error = %v", err)
	}

	recorded, err := recorder.RecordSuccess(
		ctx,
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		success,
	)
	if err != nil || recorded {
		t.Fatalf("RecordSuccess() recorded=%t error=%v", recorded, err)
	}
	if attempts.SuccessCount() != 0 {
		t.Fatalf("过期凭据不得写入运行态：successes=%d", attempts.SuccessCount())
	}
	// 等事件离开队列：使用 observer 的投递计数而不是固定 sleep。
	events := invoker.waitForEvents(t, 1)
	event := events[0]
	if event["outcome"] != "return" || event["committed"] != true || event["type"] != "gateway.attempt" {
		t.Fatalf("event=%v", event)
	}
	if event["accountRef"] != observation.AccountRef().String() || event["model"] != "gpt-5.6-sol" {
		t.Fatalf("event=%v", event)
	}
}

// TestObservedAttemptRecorderObservesStaleCredentialFailure 验证过期凭据的失败同样
// 出现在观察事件里，且 error 字段仍是这次尝试的失败分类。
func TestObservedAttemptRecorderObservesStaleCredentialFailure(t *testing.T) {
	t.Parallel()

	invoker, ctx := pinnedObservation(t)
	observation := newFailureTestObservation(t, failureTestTime().Add(-time.Hour))
	verifier := &credentialObservationVerifierStub{currentAt: failureTestTime()}
	attempts := &credentialObservationAttemptRecorder{}
	recorder, err := NewObservedAttemptRecorder(attempts, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}

	recorded, err := recorder.RecordFailure(
		ctx,
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		newFailureTestAttempt(t, false),
	)
	if err != nil || recorded {
		t.Fatalf("RecordFailure() recorded=%t error=%v", recorded, err)
	}
	if attempts.FailureCount() != 0 {
		t.Fatalf("过期凭据不得写入运行态：failures=%d", attempts.FailureCount())
	}
	events := invoker.waitForEvents(t, 1)
	event := events[0]
	if event["outcome"] != "error" || event["error"] != "rate_limited" || event["committed"] != false {
		t.Fatalf("event=%v", event)
	}
}
