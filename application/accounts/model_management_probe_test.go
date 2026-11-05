package accounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

// stubProbeCredentialReader 固定返回凭据快照或错误，聚焦刷新结果的记录行为。
type stubProbeCredentialReader struct {
	snapshot CredentialSnapshot
	err      error
}

func (reader stubProbeCredentialReader) GetCredentialSnapshot(
	context.Context,
	accountcore.AccountRef,
) (CredentialSnapshot, error) {
	return reader.snapshot, reader.err
}

// capturingProbeRecorder 记录调用参数；observingCtx 用于断言写入上下文仍可写。
type capturingProbeRecorder struct {
	records      []ModelProbeRecord
	observingCtx error
	err          error
}

func (recorder *capturingProbeRecorder) RecordModelProbe(
	ctx context.Context,
	record ModelProbeRecord,
) error {
	recorder.records = append(recorder.records, record)
	recorder.observingCtx = ctx.Err()
	return recorder.err
}

// stubProbeModelStore 只实现 ModelManagement 需要的三个端口方法。
type stubProbeModelStore struct {
	replaced []AccountModel
	err      error
}

func (stubProbeModelStore) ListAccountModels(
	context.Context,
	accountcore.AccountRef,
) ([]AccountModel, error) {
	return nil, ErrAccountNotFound
}

func (store stubProbeModelStore) ReplaceDiscoveredModelsIfCredentialVersion(
	context.Context,
	accountcore.AccountRef,
	[]runtimecore.ModelID,
	time.Time,
	time.Time,
) ([]AccountModel, error) {
	return store.replaced, store.err
}

func (stubProbeModelStore) SetManualModelPolicy(
	context.Context,
	accountcore.AccountRef,
	runtimecore.ModelID,
	ModelManualPolicy,
	time.Time,
) ([]AccountModel, error) {
	return nil, ErrInvalidAccountModel
}

// stubProbeDiscovery 返回固定目录或固定错误。
type stubProbeDiscovery struct {
	models []string
	err    error
}

func (stubProbeDiscovery) ProviderID() string { return "codex" }

func (strategy stubProbeDiscovery) DiscoverModels(
	context.Context,
	Credential,
) ([]string, error) {
	if strategy.err != nil {
		return nil, strategy.err
	}
	return strategy.models, nil
}

func newProbeTestManagement(
	t *testing.T,
	reader AccountCredentialSnapshotReader,
	strategy ProviderModelDiscoverer,
	models AccountModelStore,
	recorder ModelProbeRecorder,
	now time.Time,
) *ModelManagement {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	discovery, err := NewModelDiscovery(
		catalog,
		[]ProviderModelDiscoverer{strategy},
	)
	if err != nil {
		t.Fatalf("NewModelDiscovery() error = %v", err)
	}
	management, err := NewModelManagement(
		reader,
		models,
		discovery,
		nil,
		recorder,
		func() time.Time { return now },
	)
	if err != nil {
		t.Fatalf("NewModelManagement() error = %v", err)
	}
	return management
}

func probeTestAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func probeTestSnapshot(t *testing.T, now time.Time) CredentialSnapshot {
	t.Helper()
	accountRef := probeTestAccountRef(t)
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-probe-test"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	snapshot, err := NewCredentialSnapshot(
		accountRef,
		"codex",
		credential,
		now.Add(-time.Minute),
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	return snapshot
}

// TestRefreshAccountModelsRecordsFailureFact 覆盖失败记录：稳定错误码、300 字符截断、
// 探测时刻来自注入时钟，且记录不会改变原始错误。
func TestRefreshAccountModelsRecordsFailureFact(t *testing.T) {
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	cause := fmt.Errorf("上游返回 403: %s", strings.Repeat("失", 400))
	recorder := &capturingProbeRecorder{}
	management := newProbeTestManagement(
		t,
		stubProbeCredentialReader{err: cause},
		stubProbeDiscovery{},
		stubProbeModelStore{},
		recorder,
		now,
	)
	if _, err := management.RefreshAccountModels(context.Background(), probeTestAccountRef(t)); !errors.Is(err, cause) {
		t.Fatalf("RefreshAccountModels() error = %v, want 原始错误", err)
	}
	if len(recorder.records) != 1 {
		t.Fatalf("探测记录数 = %d, want 1", len(recorder.records))
	}
	record := recorder.records[0]
	if record.Succeeded ||
		record.Source != ModelProbeSourceError ||
		record.ErrorCode != "refresh_failed" ||
		record.ModelCount != 0 {
		t.Fatalf("失败事实 = %#v", record)
	}
	if got := utf8.RuneCountInString(record.ErrorMessage); got != MaxModelProbeErrorMessageLength {
		t.Fatalf("错误消息长度 = %d, want %d", got, MaxModelProbeErrorMessageLength)
	}
	if !record.AttemptedAt.Equal(now) || !record.UpdatedAt.Equal(now) {
		t.Fatalf("探测时刻 = %s/%s, want %s", record.AttemptedAt, record.UpdatedAt, now)
	}
}

// TestRefreshAccountModelsClassifiesDiscoveryFailure 覆盖发现阶段失败的错误码映射。
func TestRefreshAccountModelsClassifiesDiscoveryFailure(t *testing.T) {
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	recorder := &capturingProbeRecorder{}
	management := newProbeTestManagement(
		t,
		stubProbeCredentialReader{snapshot: probeTestSnapshot(t, now)},
		stubProbeDiscovery{err: errors.New("boom")},
		stubProbeModelStore{},
		recorder,
		now,
	)
	if _, err := management.RefreshAccountModels(context.Background(), probeTestAccountRef(t)); err == nil {
		t.Fatal("RefreshAccountModels() 应当失败")
	}
	if len(recorder.records) != 1 {
		t.Fatalf("探测记录数 = %d, want 1", len(recorder.records))
	}
	record := recorder.records[0]
	if record.ErrorCode != "discovery_failed" || !strings.Contains(record.ErrorMessage, "boom") {
		t.Fatalf("发现失败事实 = %#v", record)
	}
}

// TestRefreshAccountModelsRecordsSuccess 覆盖成功事实：来源 remote、模型数取上游发现
// 结果（不是含人工覆盖的完整关系），并清空错误字段。
func TestRefreshAccountModelsRecordsSuccess(t *testing.T) {
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	recorder := &capturingProbeRecorder{}
	management := newProbeTestManagement(
		t,
		stubProbeCredentialReader{snapshot: probeTestSnapshot(t, now)},
		stubProbeDiscovery{models: []string{"gpt-5", "gpt-5-mini"}},
		stubProbeModelStore{},
		recorder,
		now,
	)
	if _, err := management.RefreshAccountModels(context.Background(), probeTestAccountRef(t)); err != nil {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	if len(recorder.records) != 1 {
		t.Fatalf("探测记录数 = %d, want 1", len(recorder.records))
	}
	record := recorder.records[0]
	if !record.Succeeded ||
		record.Source != ModelProbeSourceRemote ||
		record.ModelCount != 2 ||
		record.ErrorCode != "" ||
		record.ErrorMessage != "" {
		t.Fatalf("成功事实 = %#v", record)
	}
}

// TestRefreshAccountModelsSkipsCanceledProbe 覆盖关停/换代：取消不是探测结论，
// 不写失败事实，避免把旧代次的取消覆盖到新代次的结果上。
func TestRefreshAccountModelsSkipsCanceledProbe(t *testing.T) {
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	recorder := &capturingProbeRecorder{}
	management := newProbeTestManagement(
		t,
		stubProbeCredentialReader{err: context.Canceled},
		stubProbeDiscovery{},
		stubProbeModelStore{},
		recorder,
		now,
	)
	if _, err := management.RefreshAccountModels(context.Background(), probeTestAccountRef(t)); !errors.Is(err, context.Canceled) {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	if len(recorder.records) != 0 {
		t.Fatalf("取消不应记录探测事实: %#v", recorder.records)
	}
}

// TestRefreshAccountModelsWritesProbeAfterTimeout 覆盖超时：探测上下文已经取消，
// 失败事实仍必须落盘，因此写入要脱离取消信号。
func TestRefreshAccountModelsWritesProbeAfterTimeout(t *testing.T) {
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	recorder := &capturingProbeRecorder{}
	management := newProbeTestManagement(
		t,
		stubProbeCredentialReader{err: context.DeadlineExceeded},
		stubProbeDiscovery{},
		stubProbeModelStore{},
		recorder,
		now,
	)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := management.RefreshAccountModels(canceled, probeTestAccountRef(t)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	if len(recorder.records) != 1 {
		t.Fatalf("超时探测记录数 = %d, want 1", len(recorder.records))
	}
	if recorder.records[0].ErrorCode != "timeout" {
		t.Fatalf("错误码 = %q, want timeout", recorder.records[0].ErrorCode)
	}
	if recorder.observingCtx != nil {
		t.Fatalf("写入上下文仍被取消: %v", recorder.observingCtx)
	}
}
