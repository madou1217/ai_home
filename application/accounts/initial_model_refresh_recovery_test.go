package accounts

import (
	"context"
	"errors"
	"fmt"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// TestInitialModelRefreshRecoveryUsesBoundedStableKeyset 验证启动恢复以固定页大小
// 扫描全部候选，并且只向异步协调器提交低敏账号事实。
func TestInitialModelRefreshRecoveryUsesBoundedStableKeyset(t *testing.T) {
	t.Parallel()

	catalog := initialModelRefreshTestCatalog(t)
	candidates := make([]InitialModelRefreshCandidate, 0, 257)
	for index := 1; index <= 257; index++ {
		providerID := "codex"
		if index%2 == 0 {
			providerID = "claude"
		}
		candidates = append(
			candidates,
			newInitialModelRefreshTestCandidate(t, catalog, index, providerID),
		)
	}
	reader := &initialModelRefreshCandidateReaderStub{candidates: candidates}
	scheduler := &initialModelRefreshSchedulerStub{}
	recovery, err := NewInitialModelRefreshRecovery(catalog, reader, scheduler)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshRecovery() error = %v", err)
	}

	if err := recovery.Recover(context.Background()); err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if len(reader.queries) != 2 ||
		reader.queries[0].AfterRef() != "" ||
		reader.queries[0].Limit() != InitialModelRefreshRecoveryBatchSize ||
		reader.queries[1].AfterRef() != candidates[255].AccountRef() ||
		reader.queries[1].Limit() != InitialModelRefreshRecoveryBatchSize {
		t.Fatalf("恢复查询 = %#v", reader.queries)
	}
	if len(scheduler.candidates) != len(candidates) {
		t.Fatalf(
			"调度数量 = %d, want %d",
			len(scheduler.candidates),
			len(candidates),
		)
	}
	for index, scheduled := range scheduler.candidates {
		if scheduled != candidates[index] {
			t.Fatalf("调度候选 %d = %#v, want %#v", index, scheduled, candidates[index])
		}
	}
}

// TestInitialModelRefreshRecoveryRejectsInvalidPages 验证持久化层不能通过越界、
// 游标回退、乱序或零值候选制造死循环或遗漏。
func TestInitialModelRefreshRecoveryRejectsInvalidPages(t *testing.T) {
	t.Parallel()

	catalog := initialModelRefreshTestCatalog(t)
	recovery, err := NewInitialModelRefreshRecovery(
		catalog,
		&initialModelRefreshCandidateReaderStub{},
		&initialModelRefreshSchedulerStub{},
	)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshRecovery() error = %v", err)
	}
	first := newInitialModelRefreshTestCandidate(t, catalog, 1, "codex")
	second := newInitialModelRefreshTestCandidate(t, catalog, 2, "claude")
	query, err := NewInitialModelRefreshRecoveryQuery(first.AccountRef(), 1)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshRecoveryQuery() error = %v", err)
	}
	tests := []struct {
		name       string
		candidates []InitialModelRefreshCandidate
	}{
		{name: "超过页大小", candidates: []InitialModelRefreshCandidate{second, second}},
		{name: "等于游标", candidates: []InitialModelRefreshCandidate{first}},
		{name: "零值候选", candidates: []InitialModelRefreshCandidate{{}}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			if err := recovery.validatePage(query, test.candidates); !errors.Is(
				err,
				ErrInvalidInitialModelRefreshCandidate,
			) {
				t.Fatalf("validatePage() error = %v", err)
			}
		})
	}

	wideQuery, err := NewInitialModelRefreshRecoveryQuery("", 2)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshRecoveryQuery(wide) error = %v", err)
	}
	if err := recovery.validatePage(
		wideQuery,
		[]InitialModelRefreshCandidate{second, first},
	); !errors.Is(err, ErrInvalidInitialModelRefreshCandidate) {
		t.Fatalf("validatePage(乱序) error = %v", err)
	}
}

// TestInitialModelRefreshRecoveryQueryRejectsInvalidBounds 验证恢复扫描不能使用
// 无效游标、空页或超过固定批量上限的查询。
func TestInitialModelRefreshRecoveryQueryRejectsInvalidBounds(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		afterRef accountcore.AccountRef
		limit    int
	}{
		{name: "无效游标", afterRef: "invalid", limit: 1},
		{name: "空页", limit: 0},
		{name: "超过批量上限", limit: InitialModelRefreshRecoveryBatchSize + 1},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			if _, err := NewInitialModelRefreshRecoveryQuery(
				test.afterRef,
				test.limit,
			); !errors.Is(err, ErrInvalidInitialModelRefreshRecoveryQuery) {
				t.Fatalf("NewInitialModelRefreshRecoveryQuery() error = %v", err)
			}
		})
	}
}

// TestInitialModelRefreshRecoveryPropagatesSchedulingFailure 验证调度器关闭等错误
// 会结束扫描并交给 Host 记录，而不会静默遗漏后续账号。
func TestInitialModelRefreshRecoveryPropagatesSchedulingFailure(t *testing.T) {
	t.Parallel()

	catalog := initialModelRefreshTestCatalog(t)
	candidate := newInitialModelRefreshTestCandidate(t, catalog, 1, "codex")
	scheduleErr := errors.New("synthetic schedule failure")
	recovery, err := NewInitialModelRefreshRecovery(
		catalog,
		&initialModelRefreshCandidateReaderStub{
			candidates: []InitialModelRefreshCandidate{candidate},
		},
		&initialModelRefreshSchedulerStub{err: scheduleErr},
	)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshRecovery() error = %v", err)
	}

	if err := recovery.Recover(context.Background()); !errors.Is(err, scheduleErr) {
		t.Fatalf("Recover() error = %v, want schedule failure", err)
	}
}

// TestInitialModelRefreshRecoverySkipsUnsupportedProviders 验证同库中的其他
// Provider 不会阻断后续 Codex、Claude 首次模型恢复。
func TestInitialModelRefreshRecoverySkipsUnsupportedProviders(t *testing.T) {
	t.Parallel()

	catalog := initialModelRefreshTestCatalog(t)
	candidates := []InitialModelRefreshCandidate{
		newInitialModelRefreshTestCandidate(t, catalog, 1, "codex"),
		newInitialModelRefreshTestCandidate(t, catalog, 2, "grok"),
		newInitialModelRefreshTestCandidate(t, catalog, 3, "claude"),
	}
	scheduler := &initialModelRefreshSchedulerStub{
		unsupportedProviders: map[string]struct{}{"grok": {}},
	}
	recovery, err := NewInitialModelRefreshRecovery(
		catalog,
		&initialModelRefreshCandidateReaderStub{candidates: candidates},
		scheduler,
	)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshRecovery() error = %v", err)
	}

	if err := recovery.Recover(context.Background()); err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if len(scheduler.candidates) != 2 ||
		scheduler.candidates[0] != candidates[0] ||
		scheduler.candidates[1] != candidates[2] {
		t.Fatalf("已调度恢复候选 = %#v", scheduler.candidates)
	}
}

// initialModelRefreshCandidateReaderStub 按生产 keyset 合同返回内存候选。
type initialModelRefreshCandidateReaderStub struct {
	candidates []InitialModelRefreshCandidate
	queries    []InitialModelRefreshRecoveryQuery
	err        error
}

func (reader *initialModelRefreshCandidateReaderStub) ListInitialModelRefreshCandidates(
	_ context.Context,
	query InitialModelRefreshRecoveryQuery,
) ([]InitialModelRefreshCandidate, error) {
	reader.queries = append(reader.queries, query)
	if reader.err != nil {
		return nil, reader.err
	}
	page := make([]InitialModelRefreshCandidate, 0, query.Limit())
	for _, candidate := range reader.candidates {
		if candidate.AccountRef() <= query.AfterRef() {
			continue
		}
		page = append(page, candidate)
		if len(page) == query.Limit() {
			break
		}
	}
	return page, nil
}

// initialModelRefreshSchedulerStub 记录恢复用例提交的稳定账号和 Provider。
type initialModelRefreshSchedulerStub struct {
	candidates           []InitialModelRefreshCandidate
	unsupportedProviders map[string]struct{}
	err                  error
}

func (scheduler *initialModelRefreshSchedulerStub) SupportsModelRefresh(
	providerID string,
) bool {
	_, unsupported := scheduler.unsupportedProviders[providerID]
	return !unsupported
}

func (scheduler *initialModelRefreshSchedulerStub) ScheduleModelRefresh(
	_ context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	if scheduler.err != nil {
		return scheduler.err
	}
	scheduler.candidates = append(scheduler.candidates, InitialModelRefreshCandidate{
		accountRef: accountRef,
		providerID: providerID,
	})
	return nil
}

func initialModelRefreshTestCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return catalog
}

func newInitialModelRefreshTestCandidate(
	t *testing.T,
	catalog *providers.Catalog,
	index int,
	providerID string,
) InitialModelRefreshCandidate {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(fmt.Sprintf("acct_%020x", index))
	if err != nil {
		t.Fatalf("ParseAccountRef(%d) error = %v", index, err)
	}
	candidate, err := NewInitialModelRefreshCandidate(
		catalog,
		accountRef,
		providerID,
	)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshCandidate(%d) error = %v", index, err)
	}
	return candidate
}
