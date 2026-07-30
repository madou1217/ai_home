package inferencegateway_test

import (
	"context"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// BenchmarkCoordinatorExecute 测量不含网络和 SQLite I/O 的 Canonical 编排开销。
func BenchmarkCoordinatorExecute(benchmark *testing.B) {
	benchmark.Run("ready_account_success", func(benchmark *testing.B) {
		fixture := newCoordinatorFixture(benchmark, "codex", 1)
		events := successfulEvents(benchmark, "resp_benchmark")
		upstream := benchmarkUpstream{
			protocol: inference.ProtocolCodexResponses,
			execute: func(emit inferencegateway.EventSink) inferencegateway.AttemptResult {
				for _, event := range events {
					if err := emit(event); err != nil {
						benchmark.Fatalf("emit() error = %v", err)
					}
				}
				return inferencegateway.CompletedAttempt()
			},
		}
		coordinator := fixture.newCoordinator(
			benchmark,
			upstream,
			benchmarkAttemptRecorder{},
		)
		request := newTextRequest(benchmark, "gpt-5.6-sol", true)
		benchmark.ReportAllocs()
		benchmark.ResetTimer()

		for range benchmark.N {
			if err := coordinator.Execute(
				context.Background(),
				request,
				discardBenchmarkEvent,
			); err != nil {
				benchmark.Fatalf("Execute() error = %v", err)
			}
		}
	})

	benchmark.Run("thirty_one_failures_then_success", func(benchmark *testing.B) {
		fixture := newCoordinatorFixture(
			benchmark,
			"codex",
			inferencegateway.DefaultAccountScanLimit,
		)
		_, failure := overloadedFailure(benchmark)
		successEvents := successfulEvents(benchmark, "resp_benchmark_failover")
		lastAccount := fixture.accounts[len(fixture.accounts)-1].Ref()
		upstream := benchmarkUpstream{
			protocol: inference.ProtocolCodexResponses,
			executeInvocation: func(
				invocation inferencegateway.Invocation,
				emit inferencegateway.EventSink,
			) inferencegateway.AttemptResult {
				if invocation.Account().Ref() != lastAccount {
					return inferencegateway.FailedAttempt(failure)
				}
				for _, event := range successEvents {
					if err := emit(event); err != nil {
						benchmark.Fatalf("emit() error = %v", err)
					}
				}
				return inferencegateway.CompletedAttempt()
			},
		}
		coordinator := fixture.newCoordinator(
			benchmark,
			upstream,
			benchmarkAttemptRecorder{},
		)
		request := newTextRequest(benchmark, "gpt-5.6-sol", true)
		benchmark.ReportAllocs()
		benchmark.ResetTimer()

		for range benchmark.N {
			if err := coordinator.Execute(
				context.Background(),
				request,
				discardBenchmarkEvent,
			); err != nil {
				benchmark.Fatalf("Execute() error = %v", err)
			}
		}
	})
}

// benchmarkUpstream 是不记录调用历史的最小上游基准替身。
type benchmarkUpstream struct {
	protocol          inference.ProtocolID
	execute           func(inferencegateway.EventSink) inferencegateway.AttemptResult
	executeInvocation func(
		inferencegateway.Invocation,
		inferencegateway.EventSink,
	) inferencegateway.AttemptResult
}

// ProtocolID 返回基准使用的真实线协议。
func (upstream benchmarkUpstream) ProtocolID() inference.ProtocolID {
	return upstream.protocol
}

// SupportsCredential 接受基准夹具中已校验的合成凭据。
func (benchmarkUpstream) SupportsCredential(
	credential accountapp.Credential,
) bool {
	return credential != nil
}

// Execute 同步执行预构造事件，不引入网络、日志或测试锁开销。
func (upstream benchmarkUpstream) Execute(
	_ context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	if upstream.executeInvocation != nil {
		return upstream.executeInvocation(invocation, emit), nil
	}
	return upstream.execute(emit), nil
}

// benchmarkAttemptRecorder 丢弃已经验证过的低敏状态事实。
type benchmarkAttemptRecorder struct{}

// RecordSuccess 实现无 I/O 的成功状态端口。
func (benchmarkAttemptRecorder) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
) error {
	return nil
}

// RecordFailure 实现无 I/O 的失败状态端口。
func (benchmarkAttemptRecorder) RecordFailure(
	context.Context,
	runtimecore.ModelRoute,
	inferencegateway.AttemptFailure,
) error {
	return nil
}

// discardBenchmarkEvent 同步消费 Canonical 事件。
func discardBenchmarkEvent(inference.StreamEvent) error {
	return nil
}
