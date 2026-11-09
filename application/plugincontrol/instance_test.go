package plugincontrol

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

type fakeRevisions struct {
	revision int64
	err      error
	calls    int
}

func (revisions *fakeRevisions) CurrentRevision(context.Context) (int64, error) {
	revisions.calls++
	return revisions.revision, revisions.err
}

type fakeCommitter struct {
	revision  int64
	err       error
	calls     int
	operation Operation
	expected  int64
	candidate []byte
}

func (committer *fakeCommitter) Commit(
	_ context.Context,
	operation Operation,
	expectedRevision int64,
	candidate []byte,
) (int64, error) {
	committer.calls++
	committer.operation = operation
	committer.expected = expectedRevision
	committer.candidate = append([]byte(nil), candidate...)
	return committer.revision, committer.err
}

type fakeRuntime struct {
	prepareRequest PrepareRequest
	prepareResult  PreparedCandidate
	prepareErr     error
	activateTicket string
	activateRev    int64
	activateResult ActivationResult
	activateErr    error
	discardTicket  string
	discardReason  string
	discardErr     error
	prepareCalls   int
	activateCalls  int
	discardCalls   int
}

func (runtime *fakeRuntime) Prepare(_ context.Context, request PrepareRequest) (PreparedCandidate, error) {
	runtime.prepareCalls++
	runtime.prepareRequest = request
	return runtime.prepareResult, runtime.prepareErr
}

func (runtime *fakeRuntime) Activate(_ context.Context, ticket string, revision int64) (ActivationResult, error) {
	runtime.activateCalls++
	runtime.activateTicket = ticket
	runtime.activateRev = revision
	return runtime.activateResult, runtime.activateErr
}

func (runtime *fakeRuntime) Discard(_ context.Context, ticket string, reason string) error {
	runtime.discardCalls++
	runtime.discardTicket = ticket
	runtime.discardReason = reason
	return runtime.discardErr
}

func newOperator(t *testing.T, revisions *fakeRevisions, committer *fakeCommitter, runtime *fakeRuntime) *InstanceOperator {
	t.Helper()
	operator, err := NewInstanceOperator(revisions, committer, runtime)
	if err != nil {
		t.Fatalf("NewInstanceOperator() error = %v", err)
	}
	return operator
}

func TestInstanceApplySuccessOrder(t *testing.T) {
	revisions := &fakeRevisions{revision: 3}
	committer := &fakeCommitter{revision: 4}
	runtime := &fakeRuntime{
		prepareResult:  PreparedCandidate{Ticket: "ticket-1", Generation: 8, Candidate: json.RawMessage(`{"schemaVersion":1,"revision":4}`)},
		activateResult: ActivationResult{Generation: 8, State: "active"},
	}
	operator := newOperator(t, revisions, committer, runtime)
	result, err := operator.Apply(context.Background(), OperationEnable, "echo", json.RawMessage(`{"pluginId":"echo"}`), nil)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if result.Revision != 4 || result.Generation != 8 || result.State != "active" {
		t.Fatalf("result = %+v", result)
	}
	if runtime.prepareRequest.ExpectedRevision != 3 || runtime.prepareRequest.Operation != OperationEnable {
		t.Fatalf("prepare request = %+v", runtime.prepareRequest)
	}
	if committer.expected != 3 || committer.operation != OperationEnable {
		t.Fatalf("commit args = %+v", committer)
	}
	if runtime.activateTicket != "ticket-1" || runtime.activateRev != 4 {
		t.Fatalf("activate args = ticket=%q rev=%d", runtime.activateTicket, runtime.activateRev)
	}
	if runtime.discardCalls != 0 {
		t.Fatalf("discard calls = %d", runtime.discardCalls)
	}
}

func TestInstanceApplyExpectedRevisionOverridesRead(t *testing.T) {
	revisions := &fakeRevisions{revision: 3}
	committer := &fakeCommitter{revision: 10}
	runtime := &fakeRuntime{
		prepareResult:  PreparedCandidate{Ticket: "ticket-9", Candidate: json.RawMessage(`{"revision":10}`)},
		activateResult: ActivationResult{State: "active"},
	}
	operator := newOperator(t, revisions, committer, runtime)
	expected := int64(9)
	if _, err := operator.Apply(context.Background(), OperationDisable, "echo", json.RawMessage(`{}`), &expected); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if runtime.prepareRequest.ExpectedRevision != 9 || committer.expected != 9 {
		t.Fatalf("expected revision 未透传: prepare=%d commit=%d", runtime.prepareRequest.ExpectedRevision, committer.expected)
	}
}

func TestInstanceApplyCommitConflictDiscardsCandidate(t *testing.T) {
	revisions := &fakeRevisions{revision: 3}
	committer := &fakeCommitter{err: &RevisionConflictError{Current: 5}}
	runtime := &fakeRuntime{
		prepareResult: PreparedCandidate{Ticket: "ticket-2", Candidate: json.RawMessage(`{"revision":4}`)},
	}
	operator := newOperator(t, revisions, committer, runtime)
	_, err := operator.Apply(context.Background(), OperationEnable, "echo", json.RawMessage(`{}`), nil)
	var conflict *RevisionConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("error = %v, want revision conflict", err)
	}
	if runtime.discardCalls != 1 || runtime.discardTicket != "ticket-2" || runtime.discardReason != "commit_failed" {
		t.Fatalf("discard = calls=%d ticket=%q reason=%q", runtime.discardCalls, runtime.discardTicket, runtime.discardReason)
	}
	if runtime.activateCalls != 0 {
		t.Fatalf("activate calls = %d", runtime.activateCalls)
	}
}

func TestInstanceApplyPrepareRejectedDoesNotCommit(t *testing.T) {
	revisions := &fakeRevisions{revision: 3}
	committer := &fakeCommitter{revision: 4}
	runtime := &fakeRuntime{prepareErr: pluginerr.New(CodeCandidateRejected, "apply boom")}
	operator := newOperator(t, revisions, committer, runtime)
	_, err := operator.Apply(context.Background(), OperationEnable, "echo", json.RawMessage(`{}`), nil)
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != CodeCandidateRejected {
		t.Fatalf("error = %v", err)
	}
	if committer.calls != 0 || runtime.discardCalls != 0 || runtime.activateCalls != 0 {
		t.Fatalf("prepare 被拒后仍调用了后续步骤: commit=%d discard=%d activate=%d", committer.calls, runtime.discardCalls, runtime.activateCalls)
	}
}

func TestInstanceApplyActivateFailureDiscardsAndReturnsError(t *testing.T) {
	revisions := &fakeRevisions{revision: 3}
	committer := &fakeCommitter{revision: 4}
	runtime := &fakeRuntime{
		prepareResult: PreparedCandidate{Ticket: "ticket-3", Candidate: json.RawMessage(`{"revision":4}`)},
		activateErr:   pluginerr.New(CodeRuntimeUnavailable, "node down"),
	}
	operator := newOperator(t, revisions, committer, runtime)
	_, err := operator.Apply(context.Background(), OperationEnable, "echo", json.RawMessage(`{}`), nil)
	if err == nil {
		t.Fatal("Apply() 应返回 activate 错误")
	}
	if runtime.discardCalls != 1 || runtime.discardReason != "activate_failed" {
		t.Fatalf("discard = calls=%d reason=%q", runtime.discardCalls, runtime.discardReason)
	}
}

func TestInstanceApplyRejectsEmptyInstanceID(t *testing.T) {
	revisions := &fakeRevisions{revision: 3}
	committer := &fakeCommitter{}
	runtime := &fakeRuntime{}
	operator := newOperator(t, revisions, committer, runtime)
	_, err := operator.Apply(context.Background(), OperationDisable, "  ", json.RawMessage(`{}`), nil)
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != CodeInstanceUnknown {
		t.Fatalf("error = %v", err)
	}
	if revisions.calls != 0 || runtime.prepareCalls != 0 {
		t.Fatalf("空实例 id 不应读状态或准备候选")
	}
}
