package pluginruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// gateway.attempt 的应用层单测：不启动真实宿主，直接对阶段语义（洋葱顺序、next 至多一次、
// 预算、只收窄、failurePolicy、提交点结算）做断言。真实宿主 + 真实 Go 的端到端覆盖在
// test/plugin-gateway-go.test.js。

type fakeAttemptInvoker struct {
	// respond 模拟宿主的一次 invoke；需要执行内层尝试时调用 next。
	respond func(ctx context.Context, value map[string]any, next ReverseCall) (string, error)
	calls   []string
	values  []map[string]any
	flipped []map[string]any
}

func (invoker *fakeAttemptInvoker) Invoke(
	ctx context.Context,
	generation int64,
	id string,
	value any,
	timeout time.Duration,
) (json.RawMessage, error) {
	return invoker.InvokeReverse(ctx, generation, id, value, timeout, nil)
}

func (invoker *fakeAttemptInvoker) InvokeReverse(
	ctx context.Context,
	generation int64,
	id string,
	value any,
	timeout time.Duration,
	onCall ReverseCall,
) (json.RawMessage, error) {
	invoker.calls = append(invoker.calls, id)
	encoded, _ := json.Marshal(value)
	var decoded map[string]any
	_ = json.Unmarshal(encoded, &decoded)
	invoker.values = append(invoker.values, decoded)
	raw, err := invoker.respond(ctx, decoded, onCall)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// callNext 执行 next() 并记录插件看到的 flags。
func (invoker *fakeAttemptInvoker) callNext(ctx context.Context, next ReverseCall) (map[string]any, error) {
	value, err := next(ctx, attemptNextMethod, nil)
	if err != nil {
		return nil, err
	}
	flags, _ := value.(map[string]any)
	invoker.flipped = append(invoker.flipped, flags)
	return flags, nil
}

type fakeAttemptRun struct {
	hits   int
	action string
	err    error
	onRun  func()
}

func (run *fakeAttemptRun) run(context.Context) (AttemptRun, error) {
	run.hits++
	if run.onRun != nil {
		run.onRun()
	}
	return AttemptRun{Action: run.action, Err: run.err}, run.err
}

// commitProbe 模拟响应写给客户端的那一刻。
type commitProbe struct {
	once sync.Once
	ch   chan struct{}
	done atomic.Bool
}

func newCommitProbe() *commitProbe { return &commitProbe{ch: make(chan struct{})} }

func (probe *commitProbe) Fire() {
	probe.once.Do(func() {
		probe.done.Store(true)
		close(probe.ch)
	})
}

func (probe *commitProbe) Channel() <-chan struct{} { return probe.ch }
func (probe *commitProbe) Committed() bool          { return probe.done.Load() }

func attemptContribution(id string, order int, policy string) Contribution {
	return Contribution{ID: id, Capability: CapabilityGatewayAttempt, Order: order, FailurePolicy: policy, InstanceID: "inst-" + id}
}

func attemptProjectionOf(items ...Contribution) Projection {
	return Projection{Generation: 7, Contributions: items}
}

func attemptRequest(run *fakeAttemptRun, probe *commitProbe) AttemptRequest {
	return AttemptRequest{
		Provider:   "claude",
		Model:      "claude-opus-5",
		AccountRef: "acct_00000000000000000001",
		AuthType:   "oauth",
		Attempt:    0,
		Run:        run.run,
		Commit:     probe.Channel(),
		Committed:  probe.Committed,
		LastError:  func() string { return "upstream exploded" },
	}
}

// nextAndReport 是常见的中间件写法：调用 next()，把摘要原样返回给宿主。
func nextAndReport(invoker *fakeAttemptInvoker) func(context.Context, map[string]any, ReverseCall) (string, error) {
	return func(ctx context.Context, _ map[string]any, next ReverseCall) (string, error) {
		flags, err := invoker.callNext(ctx, next)
		if err != nil {
			return "", err
		}
		encoded, _ := json.Marshal(flags)
		return string(encoded), nil
	}
}

func TestAttemptStageRunsTheAttemptOnceAndSettlesNextAtTheCommitPoint(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return", onRun: func() { time.Sleep(20 * time.Millisecond); probe.Fire() }}
	invoker := &fakeAttemptInvoker{}
	invoker.respond = nextAndReport(invoker)

	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if !result.Started || result.Err != nil || result.Stop {
		t.Fatalf("result=%+v", result)
	}
	if result.Run.Action != "return" || run.hits != 1 {
		t.Fatalf("run=%+v hits=%d", result.Run, run.hits)
	}
	flags := invoker.flipped[0]
	if flags["committed"] != true || flags["outcome"] != "committed" || flags["stopped"] != false {
		t.Fatalf("flags=%v", flags)
	}
	// 插件只看到尝试描述，没有请求体与凭据。
	value := invoker.values[0]
	if len(value) != 5 || value["provider"] != "claude" || value["model"] != "claude-opus-5" ||
		value["attempt"] != float64(0) || value["accountRef"] != "acct_00000000000000000001" || value["authType"] != "oauth" {
		t.Fatalf("plugin input=%v", value)
	}
}

func TestAttemptStageSummaryBeforeCommitCarriesTheOutcomeAndLastError(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "retry_next"}
	invoker := &fakeAttemptInvoker{}
	invoker.respond = nextAndReport(invoker)
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if !result.Started || result.Run.Action != "retry_next" {
		t.Fatalf("result=%+v", result)
	}
	flags := invoker.flipped[0]
	if flags["committed"] != false || flags["outcome"] != "retry_next" || flags["error"] != "upstream exploded" {
		t.Fatalf("flags=%v", flags)
	}
}

func TestSecondNextFailsWithNextCalledTwiceAndNeverRerunsTheAttempt(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return"}
	var twiceCode string
	invoker := &fakeAttemptInvoker{}
	invoker.respond = func(ctx context.Context, _ map[string]any, next ReverseCall) (string, error) {
		if _, err := invoker.callNext(ctx, next); err != nil {
			return "", err
		}
		if _, err := next(ctx, attemptNextMethod, nil); err != nil {
			var stageErr *StageError
			if errors.As(err, &stageErr) {
				twiceCode = stageErr.Code
			} else {
				twiceCode = err.Error()
			}
		}
		return "null", nil
	}
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if twiceCode != "plugin_next_called_twice" || run.hits != 1 || !result.Started {
		t.Fatalf("twice=%q hits=%d result=%+v", twiceCode, run.hits, result)
	}
}

func TestUnknownReverseMethodIsRejected(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return"}
	var code string
	invoker := &fakeAttemptInvoker{respond: func(ctx context.Context, _ map[string]any, next ReverseCall) (string, error) {
		_, err := next(ctx, "gateway.retry", nil)
		var stageErr *StageError
		if errors.As(err, &stageErr) {
			code = stageErr.Code
		}
		return "null", nil
	}}
	RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if code != "plugin_rpc_method_unknown" {
		t.Fatalf("code=%q", code)
	}
}

func TestRejectBeforeNextKeepsTheUpstreamUnhit(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return"}
	invoker := &fakeAttemptInvoker{respond: func(context.Context, map[string]any, ReverseCall) (string, error) {
		return `{"reject":{"status":451,"message":"blocked by A"}}`, nil
	}}
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if result.Started || result.Rejected == nil {
		t.Fatalf("result=%+v", result)
	}
	if result.Rejected.Status != 451 || result.Rejected.Message != "blocked by A" || result.Rejected.Code != "plugin_rejected" {
		t.Fatalf("rejected=%+v", result.Rejected)
	}
	if run.hits != 0 {
		t.Fatalf("上游零命中，实际 %d", run.hits)
	}
}

func TestRejectStatusOutsideTheContractIsAnInvalidResult(t *testing.T) {
	for name, raw := range map[string]string{
		"too-low":  `{"reject":{"status":200,"message":"nope"}}`,
		"too-high": `{"reject":{"status":600,"message":"nope"}}`,
		"missing":  `{"reject":{"message":"nope"}}`,
	} {
		probe := newCommitProbe()
		run := &fakeAttemptRun{action: "return"}
		invoker := &fakeAttemptInvoker{respond: func(context.Context, map[string]any, ReverseCall) (string, error) { return raw, nil }}
		result := RunAttemptStage(
			context.Background(),
			invoker,
			attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
			attemptRequest(run, probe),
			AttemptOptions{},
		)
		if result.Started || result.Rejected == nil || result.Rejected.Status != 502 || result.Rejected.Code != "plugin_result_invalid" {
			t.Fatalf("%s: result=%+v", name, result)
		}
		if run.hits != 0 {
			t.Fatalf("%s: 上游零命中，实际 %d", name, run.hits)
		}
	}
}

func TestReturningNullWithoutNextIsADenyFailure(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return"}
	invoker := &fakeAttemptInvoker{respond: func(context.Context, map[string]any, ReverseCall) (string, error) { return "null", nil }}
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if result.Started || result.Rejected == nil || result.Rejected.Code != "plugin_result_invalid" || run.hits != 0 {
		t.Fatalf("result=%+v hits=%d", result, run.hits)
	}
	if len(result.Failures) != 1 || result.Failures[0].ContributionID != "a.attempt" {
		t.Fatalf("failures=%+v", result.Failures)
	}
}

func TestDelegatePolicyIsATransparentMiddleware(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return"}
	invoker := &fakeAttemptInvoker{respond: func(context.Context, map[string]any, ReverseCall) (string, error) {
		return "", &StageError{Code: "plugin_rpc_timeout", Message: "slow"}
	}}
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("d.attempt", 0, "delegate")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if !result.Started || result.Err != nil || result.Run.Action != "return" {
		t.Fatalf("result=%+v", result)
	}
	if run.hits != 1 || len(result.Failures) != 1 || result.Failures[0].Code != "plugin_rpc_timeout" {
		t.Fatalf("hits=%d failures=%+v", run.hits, result.Failures)
	}
}

func TestPreNextBudgetOverrunDeniesAndCancelsThePluginCall(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return"}
	cancelled := make(chan struct{})
	invoker := &fakeAttemptInvoker{respond: func(ctx context.Context, _ map[string]any, _ ReverseCall) (string, error) {
		select {
		case <-ctx.Done():
			close(cancelled)
			return "", ctx.Err()
		case <-time.After(2 * time.Second):
			return "null", nil
		}
	}}
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{StepBudget: 30 * time.Millisecond},
	)
	if result.Started || result.Rejected == nil || result.Rejected.Status != 502 || result.Rejected.Code != "plugin_rpc_timeout" {
		t.Fatalf("result=%+v", result)
	}
	if run.hits != 0 {
		t.Fatalf("deny 时上游零命中，实际 %d", run.hits)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("超时必须真的取消插件调用")
	}
}

func TestWaitingInsideNextDoesNotCountAgainstThePluginBudget(t *testing.T) {
	probe := newCommitProbe()
	// 提交点在尝试结束前：next() 只等首字节，之后的等待不算插件预算。
	run := &fakeAttemptRun{action: "return", onRun: func() { probe.Fire(); time.Sleep(120 * time.Millisecond) }}
	invoker := &fakeAttemptInvoker{}
	invoker.respond = nextAndReport(invoker)
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{StepBudget: 30 * time.Millisecond},
	)
	if !result.Started || len(result.Failures) != 0 || result.Err != nil {
		t.Fatalf("result=%+v", result)
	}
	if invoker.flipped[0]["committed"] != true {
		t.Fatalf("flags=%v", invoker.flipped[0])
	}
}

func TestStopOnlyNarrowsAnUncommittedFailover(t *testing.T) {
	// 未提交的 retry_next：插件可以停止换号。
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "retry_next"}
	invoker := &fakeAttemptInvoker{}
	invoker.respond = func(ctx context.Context, _ map[string]any, next ReverseCall) (string, error) {
		if _, err := invoker.callNext(ctx, next); err != nil {
			return "", err
		}
		return `{"recovery":"stop"}`, nil
	}
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if !result.Stop {
		t.Fatalf("未提交的 retry_next 应该可以停止换号：%+v", result)
	}
	if invoker.flipped[0]["stopped"] != false {
		t.Fatalf("插件看到的是它返回前的状态：%v", invoker.flipped[0])
	}

	// 已提交的尝试：stop 不生效。
	committed := newCommitProbe()
	committed.Fire()
	run2 := &fakeAttemptRun{action: "retry_next"}
	invoker2 := &fakeAttemptInvoker{}
	invoker2.respond = func(ctx context.Context, _ map[string]any, next ReverseCall) (string, error) {
		if _, err := invoker2.callNext(ctx, next); err != nil {
			return "", err
		}
		return `{"recovery":"stop"}`, nil
	}
	result2 := RunAttemptStage(
		context.Background(),
		invoker2,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run2, committed),
		AttemptOptions{},
	)
	if result2.Stop {
		t.Fatalf("已提交的尝试不能被插件改写：%+v", result2)
	}

	// 终态结果（不是换号动作）：stop 不生效。
	probe3 := newCommitProbe()
	run3 := &fakeAttemptRun{action: "return"}
	invoker3 := &fakeAttemptInvoker{}
	invoker3.respond = func(ctx context.Context, _ map[string]any, next ReverseCall) (string, error) {
		if _, err := invoker3.callNext(ctx, next); err != nil {
			return "", err
		}
		return `{"recovery":"stop"}`, nil
	}
	result3 := RunAttemptStage(
		context.Background(),
		invoker3,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run3, probe3),
		AttemptOptions{},
	)
	if result3.Stop {
		t.Fatalf("只有换号动作可以被收窄：%+v", result3)
	}
}

func TestAttemptStageRunsInSnapshotOrderAsAnOnion(t *testing.T) {
	probe := newCommitProbe()
	var order []string
	run := &fakeAttemptRun{action: "return", onRun: func() { order = append(order, "attempt") }}
	invoker := &fakeAttemptInvoker{}
	invoker.respond = func(ctx context.Context, _ map[string]any, next ReverseCall) (string, error) {
		current := invoker.calls[len(invoker.calls)-1]
		order = append(order, current+":in")
		if _, err := invoker.callNext(ctx, next); err != nil {
			return "", err
		}
		order = append(order, current+":out")
		return "null", nil
	}
	outer := attemptContribution("b.attempt", 2, "deny")
	outer.InstanceID = "outer"
	inner := attemptContribution("a.attempt", 1, "deny")
	inner.InstanceID = "inner"
	RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(outer, inner),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if strings.Join(order, ",") != "a.attempt:in,b.attempt:in,attempt,b.attempt:out,a.attempt:out" {
		t.Fatalf("order=%v", order)
	}
}

func TestEmptyChainRunsTheAttemptWithoutPluginRPC(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return"}
	invoker := &fakeAttemptInvoker{respond: func(context.Context, map[string]any, ReverseCall) (string, error) {
		t.Fatal("空链不应该调用插件")
		return "", nil
	}}
	result := RunAttemptStage(context.Background(), invoker, attemptProjectionOf(), attemptRequest(run, probe), AttemptOptions{})
	if !result.Started || run.hits != 1 || result.Run.Action != "return" {
		t.Fatalf("result=%+v hits=%d", result, run.hits)
	}
}

func TestPinnedStageWithoutAttemptContributionsDoesNotRun(t *testing.T) {
	run := &fakeAttemptRun{action: "return"}
	request := attemptRequest(run, newCommitProbe())
	observeOnly := Projection{Generation: 3, Contributions: []Contribution{
		{ID: "obs", Capability: CapabilityObserve, FailurePolicy: "deny", InstanceID: "inst-obs"},
	}}
	ctx := WithPin(context.Background(), NewPin(3, observeOnly, nil, time.Now(), nil))
	if _, ran := RunPinnedAttemptStage(ctx, request, AttemptOptions{}); ran {
		t.Fatal("没有 gateway.attempt 贡献项时不应该运行阶段")
	}
	if _, ran := RunPinnedAttemptStage(context.Background(), request, AttemptOptions{}); ran {
		t.Fatal("没有代次时不应该运行阶段")
	}
	if run.hits != 0 {
		t.Fatalf("没有运行阶段就不该执行尝试，实际 %d", run.hits)
	}
}

func TestAttemptRunErrorIsSurfacedToTheCallerAndTheSummaryCarriesIt(t *testing.T) {
	probe := newCommitProbe()
	failure := errors.New("upstream exploded")
	run := &fakeAttemptRun{action: "error", err: failure}
	invoker := &fakeAttemptInvoker{}
	invoker.respond = nextAndReport(invoker)
	result := RunAttemptStage(
		context.Background(),
		invoker,
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if !errors.Is(result.Err, failure) {
		t.Fatalf("尝试错误必须原样交还宿主：%+v", result)
	}
	flags := invoker.flipped[0]
	if flags["outcome"] != "error" || !strings.Contains(flags["error"].(string), "upstream exploded") {
		t.Fatalf("flags=%v", flags)
	}
}

func TestAttemptStageWithoutReverseSupportFailsClosed(t *testing.T) {
	probe := newCommitProbe()
	run := &fakeAttemptRun{action: "return"}
	// 只实现 Invoke 的调用器：无法执行 next()，必须按 deny 拒绝，而不是静默放行。
	result := RunAttemptStage(
		context.Background(),
		forwardOnlyInvoker{},
		attemptProjectionOf(attemptContribution("a.attempt", 0, "deny")),
		attemptRequest(run, probe),
		AttemptOptions{},
	)
	if result.Started || result.Rejected == nil || result.Rejected.Code != "plugin_runtime_inactive" {
		t.Fatalf("result=%+v", result)
	}
	if run.hits != 0 {
		t.Fatalf("上游零命中，实际 %d", run.hits)
	}
}

type forwardOnlyInvoker struct{}

func (forwardOnlyInvoker) Invoke(context.Context, int64, string, any, time.Duration) (json.RawMessage, error) {
	return json.RawMessage("null"), nil
}
