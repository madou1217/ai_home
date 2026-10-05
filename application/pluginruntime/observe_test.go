package pluginruntime

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"testing"
	"time"
)

type recordingInvoker struct {
	mu     sync.Mutex
	events []map[string]any
	err    error
	block  chan struct{}
}

func (invoker *recordingInvoker) Invoke(_ context.Context, _ int64, _ string, value any, _ time.Duration) (json.RawMessage, error) {
	if invoker.block != nil {
		<-invoker.block
	}
	invoker.mu.Lock()
	defer invoker.mu.Unlock()
	if invoker.err != nil {
		return nil, invoker.err
	}
	encoded, _ := json.Marshal(value)
	var event map[string]any
	_ = json.Unmarshal(encoded, &event)
	invoker.events = append(invoker.events, event)
	return json.RawMessage("null"), nil
}

func (invoker *recordingInvoker) snapshot() []map[string]any {
	invoker.mu.Lock()
	defer invoker.mu.Unlock()
	return append([]map[string]any(nil), invoker.events...)
}

func observeProjection() Projection {
	return Projection{Generation: 4, Contributions: []Contribution{{ID: "obs", Capability: CapabilityObserve, FailurePolicy: "deny", InstanceID: "p"}}}
}

func waitUntil(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met")
}

func TestObservedAttemptsMatchTheNodeEventShape(t *testing.T) {
	registry := NewRegistry()
	if _, err := registry.Replace(HostAccess{Address: "a", Token: "t"}, []Projection{observeProjection()}, map[string]string{"acct_go": "acct_node"}); err != nil {
		t.Fatal(err)
	}
	invoker := &recordingInvoker{}
	observer := NewObserver(invoker, registry, func(context.Context, string) string { return "codex" }, 4)
	defer observer.Close()
	committed := false
	ctx := WithPin(context.Background(), NewPin(4, observeProjection(), observer, time.Now(), func() bool { return committed }))

	ObserveAttempt(ctx, "acct_go", "gpt-5.4", false, "upstream_overloaded")
	committed = true
	ObserveAttempt(ctx, "acct_other", "gpt-5.4", true, "")
	waitUntil(t, func() bool { return len(invoker.snapshot()) == 2 })
	events := invoker.snapshot()
	keys := make([]string, 0)
	for key := range events[0] {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	want := []string{"accountRef", "attempt", "committed", "durationMs", "error", "generation", "model", "outcome", "provider", "type"}
	if len(keys) != len(want) {
		t.Fatalf("keys=%v", keys)
	}
	for index := range want {
		if keys[index] != want[index] {
			t.Fatalf("keys=%v", keys)
		}
	}
	first, second := events[0], events[1]
	if first["accountRef"] != "acct_node" || first["provider"] != "codex" || first["outcome"] != "error" || first["error"] != "upstream_overloaded" || first["committed"] != false || first["attempt"] != float64(0) {
		t.Fatalf("first=%v", first)
	}
	if second["accountRef"] != "acct_other" || second["outcome"] != "return" || second["committed"] != true || second["attempt"] != float64(1) || second["type"] != "gateway.attempt" {
		t.Fatalf("second=%v", second)
	}
}

func TestObservationIsBoundedAndCountsDisposedGenerationsAsDropped(t *testing.T) {
	registry := NewRegistry()
	block := make(chan struct{})
	invoker := &recordingInvoker{block: block}
	observer := NewObserver(invoker, registry, nil, 2)
	ctx := WithPin(context.Background(), NewPin(4, observeProjection(), observer, time.Now(), nil))
	for index := 0; index < 10; index++ {
		ObserveAttempt(ctx, "acct", "m", true, "")
	}
	if observer.Stats().Dropped < 7 {
		t.Fatalf("a full queue must drop instead of blocking: %+v", observer.Stats())
	}
	close(block)
	waitUntil(t, func() bool { return observer.Stats().Queued == 0 })
	observer.Close()

	unknown := NewObserver(&recordingInvoker{err: codedFailure{code: "plugin_generation_unknown"}}, registry, nil, 4)
	defer unknown.Close()
	ObserveAttempt(WithPin(context.Background(), NewPin(4, observeProjection(), unknown, time.Now(), nil)), "acct", "m", true, "")
	waitUntil(t, func() bool { return unknown.Stats().Dropped == 1 })
	if unknown.Stats().Failed != 0 {
		t.Fatalf("a disposed generation is a drop, not a failure: %+v", unknown.Stats())
	}
}

func TestNoPinOrNoObserveContributionMeansNoEvent(t *testing.T) {
	invoker := &recordingInvoker{}
	observer := NewObserver(invoker, NewRegistry(), nil, 4)
	defer observer.Close()
	ObserveAttempt(context.Background(), "acct", "m", true, "")
	requestOnly := Projection{Generation: 4, Contributions: []Contribution{{ID: "rw", Capability: CapabilityGatewayRequest, FailurePolicy: "deny", InstanceID: "p"}}}
	ObserveAttempt(WithPin(context.Background(), NewPin(4, requestOnly, observer, time.Now(), nil)), "acct", "m", true, "")
	time.Sleep(50 * time.Millisecond)
	if len(invoker.snapshot()) != 0 || observer.Stats().Dropped != 0 {
		t.Fatalf("events=%v stats=%+v", invoker.snapshot(), observer.Stats())
	}
}
