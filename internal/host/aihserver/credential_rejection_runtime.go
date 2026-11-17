package aihserver

import (
	"context"
	"sync"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// BeginObservedCredentialRejection 保留 WithPorts 内层 override 的能力边界。
// 不支持时显式返回 sentinel，原 recorder 才可走既有 ref-only 终态路径。
func (runtime outcomeRecordingRuntime) BeginObservedCredentialRejection(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
) (inferencegateway.CredentialRejectionWrite, error) {
	observed, ok := runtime.serverAccountRuntime.(inferencegateway.ObservedCredentialRejectionRuntime)
	if !ok {
		return nil, inferencegateway.ErrObservedCredentialRejectionUnsupported
	}
	write, err := observed.BeginObservedCredentialRejection(ctx, route, observation)
	if err != nil {
		if write != nil {
			write.Close()
		}
		return nil, err
	}
	if write == nil {
		return nil, inferencegateway.ErrInvalidObservedAttemptRecorder
	}
	return &outcomeCredentialRejectionWrite{runtime: runtime, route: route, write: write}, nil
}

// ClearObservedCredentialRejection 只转发可选内存能力；没有 daemon caller。
func (runtime outcomeRecordingRuntime) ClearObservedCredentialRejection(
	ctx context.Context,
	rejected accountcredentials.CredentialObservation,
	replacement accountcredentials.CredentialObservation,
) (bool, error) {
	observed, ok := runtime.serverAccountRuntime.(inferencegateway.ObservedCredentialRejectionRuntime)
	if !ok {
		return false, inferencegateway.ErrObservedCredentialRejectionUnsupported
	}
	return observed.ClearObservedCredentialRejection(ctx, rejected, replacement)
}

type outcomeCredentialRejectionWrite struct {
	mu        sync.Mutex
	runtime   outcomeRecordingRuntime
	route     runtimecore.ModelRoute
	write     inferencegateway.CredentialRejectionWrite
	attempted bool
	closed    bool
}

// Commit 仅在 observed 写确实落地后计一次；不再调用 ref-only RecordFailure。
func (write *outcomeCredentialRejectionWrite) Commit(ctx context.Context, failure inferencegateway.AttemptFailure) (bool, error) {
	write.mu.Lock()
	defer write.mu.Unlock()
	if write.closed || write.attempted {
		return false, nil
	}
	write.attempted = true
	recorded, err := write.write.Commit(ctx, failure)
	if recorded && err == nil {
		write.runtime.outcomes.Record(write.route.AccountRef(), string(failure.RuntimeKind()))
		write.runtime.quotaRefresh.observe(write.route.AccountRef(), failure.RuntimeKind())
	}
	return recorded, err
}

func (write *outcomeCredentialRejectionWrite) Close() {
	write.mu.Lock()
	defer write.mu.Unlock()
	if write.closed {
		return
	}
	write.closed = true
	write.write.Close()
}

var _ inferencegateway.ObservedCredentialRejectionRuntime = outcomeRecordingRuntime{}
