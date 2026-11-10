package webuirefreshjobstore

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testClock 是可控时钟，避免测试依赖真实时间。
type testClock struct {
	mu      sync.Mutex
	current time.Time
}

func newTestClock() *testClock {
	return &testClock{current: time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)}
}

func (clock *testClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.current
}

func (clock *testClock) Advance(delta time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.current = clock.current.Add(delta)
}

// newIDSequence 生成可预测的作业 ID，便于断言复用与淘汰顺序。
func newIDSequence() func(provider, accountRef string) string {
	var counter atomic.Int64
	return func(string, string) string {
		return "job-" + strconv.FormatInt(counter.Add(1), 10)
	}
}

func newTestStore(t *testing.T, options Options) (*Store, *testClock) {
	t.Helper()
	clock := newTestClock()
	options.Now = clock.Now
	if options.NewID == nil {
		options.NewID = newIDSequence()
	}
	return New(options), clock
}

// waitForStatus 轮询到作业进入目标状态；超时直接判失败。
func waitForStatus(t *testing.T, store *Store, jobID string, status string) Snapshot {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		snapshot, exists := store.Get(jobID)
		if exists && snapshot.Status == status {
			return snapshot
		}
		if time.Now().After(deadline) {
			t.Fatalf("作业 %s 未在期限内进入 %s：%+v", jobID, status, snapshot)
		}
		time.Sleep(time.Millisecond)
	}
}

// startImmediate 启动一个立即成功的作业并等它进入 succeeded。
func startImmediate(t *testing.T, store *Store, provider string, accountRef string, scope string) Snapshot {
	t.Helper()
	job, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider:   provider,
		AccountRef: accountRef,
		Scope:      scope,
		Run: func(context.Context) (Snapshot, error) {
			return Snapshot{}, nil
		},
	})
	if alreadyRunning {
		t.Fatalf("首次启动不应复用作业：%+v", job)
	}
	return waitForStatus(t, store, job.ID, StatusSucceeded)
}

func TestStartRunsJobThroughQueuedRunningSucceeded(t *testing.T) {
	store, clock := newTestStore(t, Options{})

	started := make(chan struct{})
	release := make(chan struct{})
	job, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider:   " Codex ",
		AccountRef: " acct_1 ",
		Scope:      ScopeAccount,
		Run: func(context.Context) (Snapshot, error) {
			close(started)
			<-release
			return Snapshot{
				Status: StatusSucceeded,
				Branches: map[string]Branch{
					"status": {Status: StatusSucceeded},
					"models": {Status: StatusSucceeded},
					"usage":  {Status: StatusFailed, Error: "额度接口 502"},
				},
				FailedBranches: []string{"usage"},
				Recovered:      true,
			}, nil
		},
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}
	if job.Status != StatusQueued {
		t.Fatalf("Start 应返回 queued 快照，实际 %s", job.Status)
	}
	if job.Provider != "codex" || job.AccountRef != "acct_1" {
		t.Fatalf("账号标识未按 Node 口径归一：%+v", job)
	}
	if job.Scope != ScopeAccount {
		t.Fatalf("scope 应为 account，实际 %s", job.Scope)
	}
	if job.FinishedAt != nil {
		t.Fatalf("queued 作业的 finishedAt 应为 nil：%+v", job.FinishedAt)
	}
	if job.CreatedAt != clock.Now().UnixMilli() || job.UpdatedAt != job.CreatedAt {
		t.Fatalf("queued 作业时间戳异常：%+v", job)
	}

	<-started
	running, exists := store.Get(job.ID)
	if !exists {
		t.Fatal("running 作业应能在表中查到")
	}
	if running.Status != StatusRunning {
		t.Fatalf("Run 执行期间状态应为 running，实际 %s", running.Status)
	}
	if running.FinishedAt != nil {
		t.Fatalf("running 作业的 finishedAt 应为 nil：%+v", running.FinishedAt)
	}

	clock.Advance(2 * time.Second)
	close(release)
	done := waitForStatus(t, store, job.ID, StatusSucceeded)
	if done.CreatedAt != job.CreatedAt {
		t.Fatalf("CreatedAt 应保持 Start 时的值：%d != %d", done.CreatedAt, job.CreatedAt)
	}
	if done.FinishedAt == nil || *done.FinishedAt != clock.Now().UnixMilli() {
		t.Fatalf("终态应写入 finishedAt：%+v", done.FinishedAt)
	}
	if done.UpdatedAt != *done.FinishedAt {
		t.Fatalf("终态 UpdatedAt 应与 finishedAt 一致：%d != %d", done.UpdatedAt, *done.FinishedAt)
	}
	if done.Error != "" {
		t.Fatalf("成功作业不应带 error：%q", done.Error)
	}
	if len(done.FailedBranches) != 1 || done.FailedBranches[0] != "usage" {
		t.Fatalf("failedBranches 应原样保留：%+v", done.FailedBranches)
	}
	if done.Branches["usage"].Status != StatusFailed || done.Branches["usage"].Error != "额度接口 502" {
		t.Fatalf("branches 应原样保留：%+v", done.Branches)
	}
	if !done.Recovered {
		t.Fatal("recovered 应原样保留")
	}
}

func TestRunErrorMarksJobFailedAndTruncatesError(t *testing.T) {
	store, _ := newTestStore(t, Options{})
	longMessage := strings.Repeat("刷新失败", 200) // 800 个 rune，超过 500 上限。

	job, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider:   "codex",
		AccountRef: "acct_1",
		Scope:      ScopeAccount,
		Run: func(context.Context) (Snapshot, error) {
			return Snapshot{
				Branches:       map[string]Branch{"usage": {Status: StatusFailed, Error: "上游 502"}},
				FailedBranches: []string{"usage"},
			}, errors.New(longMessage)
		},
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}

	done := waitForStatus(t, store, job.ID, StatusFailed)
	if runes := []rune(done.Error); len(runes) != maxErrorRunes {
		t.Fatalf("error 应截断到 %d 个 rune，实际 %d", maxErrorRunes, len(runes))
	}
	if !strings.HasPrefix(done.Error, "刷新失败") {
		t.Fatalf("截断后应保留错误前缀：%q", done.Error)
	}
	if done.FinishedAt == nil {
		t.Fatal("失败作业应写入 finishedAt")
	}
	// 失败时执行面明细仍要保留，界面才能说清是哪一段失败。
	if done.Branches["usage"].Error != "上游 502" {
		t.Fatalf("失败作业应保留 branches：%+v", done.Branches)
	}
	if len(done.FailedBranches) != 1 || done.FailedBranches[0] != "usage" {
		t.Fatalf("失败作业应保留 failedBranches：%+v", done.FailedBranches)
	}
}

func TestRunUsesDetachedContext(t *testing.T) {
	store, _ := newTestStore(t, Options{})
	requestContext, cancel := context.WithCancel(context.Background())
	cancel() // 模拟客户端已经断开。

	observed := make(chan error, 1)
	job, alreadyRunning := store.Start(requestContext, StartRequest{
		Provider:   "codex",
		AccountRef: "acct_1",
		Scope:      ScopeUsage,
		Run: func(ctx context.Context) (Snapshot, error) {
			observed <- ctx.Err()
			return Snapshot{}, nil
		},
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}

	select {
	case err := <-observed:
		if err != nil {
			t.Fatalf("刷新不应随请求上下文取消：%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run 未在期限内执行")
	}
	waitForStatus(t, store, job.ID, StatusSucceeded)
}

func TestStartReusesActiveJobForSameScope(t *testing.T) {
	store, _ := newTestStore(t, Options{})
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int64
	run := func(context.Context) (Snapshot, error) {
		calls.Add(1)
		close(started)
		<-release
		return Snapshot{}, nil
	}

	first, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: "codex", AccountRef: "acct_1", Scope: ScopeUsage, Run: run,
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}
	second, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: " Codex ", AccountRef: " acct_1 ", Scope: ScopeUsage, Run: run,
	})
	if !alreadyRunning {
		t.Fatal("同一目标的第二次启动应复用活动作业")
	}
	if second.ID != first.ID {
		t.Fatalf("复用应返回同一个作业：%s != %s", second.ID, first.ID)
	}
	if second.Status != StatusQueued && second.Status != StatusRunning {
		t.Fatalf("复用快照应是活动状态，实际 %s", second.Status)
	}

	// scope 不同属于不同作业，不能被复用。
	third, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: "codex", AccountRef: "acct_1", Scope: ScopeAccount,
		Run: func(context.Context) (Snapshot, error) { return Snapshot{}, nil },
	})
	if alreadyRunning {
		t.Fatal("不同 scope 不应复用作业")
	}
	if third.ID == first.ID {
		t.Fatalf("不同 scope 应生成新作业：%s", third.ID)
	}

	<-started
	close(release)
	waitForStatus(t, store, first.ID, StatusSucceeded)
	waitForStatus(t, store, third.ID, StatusSucceeded)
	if calls.Load() != 1 {
		t.Fatalf("复用后执行体应只跑一次，实际 %d 次", calls.Load())
	}
}

func TestConcurrentStartCreatesSingleJob(t *testing.T) {
	store, _ := newTestStore(t, Options{})
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int64
	run := func(context.Context) (Snapshot, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return Snapshot{}, nil
	}

	const workers = 16
	type startResult struct {
		job            Snapshot
		alreadyRunning bool
	}
	gate := make(chan struct{})
	results := make(chan startResult, workers)
	var waitGroup sync.WaitGroup
	for index := 0; index < workers; index++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			<-gate
			job, alreadyRunning := store.Start(context.Background(), StartRequest{
				Provider: "codex", AccountRef: "acct_1", Scope: ScopeUsage, Run: run,
			})
			results <- startResult{job: job, alreadyRunning: alreadyRunning}
		}()
	}
	close(gate)
	waitGroup.Wait()
	close(results)

	items := make([]startResult, 0, workers)
	for item := range results {
		items = append(items, item)
	}
	accepted := 0
	jobID := ""
	for _, item := range items {
		if item.alreadyRunning {
			continue
		}
		accepted++
		jobID = item.job.ID
	}
	if accepted != 1 {
		t.Fatalf("并发 Start 应只产生一个作业，实际 %d", accepted)
	}
	if jobID == "" {
		t.Fatal("被接受的作业缺少 ID")
	}
	for _, item := range items {
		if item.job.ID != jobID {
			t.Fatalf("所有调用都应指向同一个作业：%s != %s", item.job.ID, jobID)
		}
	}
	if store.Len() != 1 {
		t.Fatalf("作业表应只有一条记录，实际 %d", store.Len())
	}

	<-started
	close(release)
	waitForStatus(t, store, jobID, StatusSucceeded)
	if calls.Load() != 1 {
		t.Fatalf("执行体应只跑一次，实际 %d 次", calls.Load())
	}
}

func TestPruneRemovesExpiredTerminalJobs(t *testing.T) {
	store, clock := newTestStore(t, Options{Retention: 10 * time.Minute, MaxJobs: 200})
	first := startImmediate(t, store, "codex", "acct_1", ScopeUsage)

	clock.Advance(10 * time.Minute)
	second := startImmediate(t, store, "codex", "acct_2", ScopeUsage)
	if _, exists := store.Get(first.ID); !exists {
		t.Fatal("恰好到达保留期不应删除终态作业")
	}

	clock.Advance(time.Millisecond)
	startImmediate(t, store, "codex", "acct_3", ScopeUsage)
	if _, exists := store.Get(first.ID); exists {
		t.Fatal("超过保留期的终态作业应被删除")
	}
	if _, exists := store.Get(second.ID); !exists {
		t.Fatal("未过保留期的终态作业不应被删除")
	}
}

func TestPruneKeepsJobCountWithinLimit(t *testing.T) {
	store, clock := newTestStore(t, Options{MaxJobs: 2, Retention: time.Hour})
	jobs := make([]Snapshot, 0, 3)
	for index := 0; index < 3; index++ {
		jobs = append(jobs, startImmediate(t, store, "codex", "acct_"+strconv.Itoa(index), ScopeUsage))
		clock.Advance(time.Second)
	}

	if store.Len() != 2 {
		t.Fatalf("作业表应限制在 2 条，实际 %d", store.Len())
	}
	if _, exists := store.Get(jobs[0].ID); exists {
		t.Fatal("超限时应淘汰 updatedAt 最旧的终态作业")
	}
	if _, exists := store.Get(jobs[1].ID); !exists {
		t.Fatal("较新的终态作业不应被淘汰")
	}
	if _, exists := store.Get(jobs[2].ID); !exists {
		t.Fatal("最新作业不应被淘汰")
	}
}

func TestPruneNeverRemovesActiveJobs(t *testing.T) {
	store, _ := newTestStore(t, Options{MaxJobs: 1, Retention: time.Hour})
	started := make(chan struct{})
	release := make(chan struct{})
	active, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: "codex", AccountRef: "acct_active", Scope: ScopeUsage,
		Run: func(context.Context) (Snapshot, error) {
			close(started)
			<-release
			return Snapshot{}, nil
		},
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}
	<-started

	terminal := startImmediate(t, store, "codex", "acct_done", ScopeUsage)
	if _, exists := store.Get(active.ID); !exists {
		t.Fatal("活动作业不应被上限清理")
	}
	if _, exists := store.Get(terminal.ID); !exists {
		t.Fatal("终态作业不应被误删")
	}
	// 唯一可删的作业也在跑，上限无法满足时宁可超限。
	if store.Len() != 2 {
		t.Fatalf("没有可淘汰的终态作业时应保留全部，实际 %d", store.Len())
	}

	close(release)
	waitForStatus(t, store, active.ID, StatusSucceeded)
}

func TestGetReturnsIsolatedCopy(t *testing.T) {
	store, _ := newTestStore(t, Options{})
	finishedAt := int64(1700000000123)
	job, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: "codex", AccountRef: "acct_1", Scope: ScopeAccount,
		Run: func(context.Context) (Snapshot, error) {
			return Snapshot{
				Status: StatusSucceeded,
				Error:  "部分失败",
				Branches: map[string]Branch{
					"status": {Status: StatusSucceeded},
					"usage":  {Status: StatusFailed, Error: "上游 502"},
				},
				FailedBranches: []string{"usage"},
				Recovered:      true,
				FinishedAt:     &finishedAt,
			}, nil
		},
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}

	done := waitForStatus(t, store, job.ID, StatusSucceeded)
	if done.FinishedAt == nil {
		t.Fatal("调用方给出的 finishedAt 应被保留")
	}
	// 调用方改坏副本，不应影响表内状态。
	done.Branches["status"] = Branch{Status: StatusFailed, Error: "被调用方改坏"}
	done.Branches["models"] = Branch{Status: StatusFailed}
	done.FailedBranches[0] = "models"
	*done.FinishedAt = 1
	done.Error = "被调用方改坏"

	fresh, exists := store.Get(job.ID)
	if !exists {
		t.Fatal("作业应仍在表中")
	}
	if len(fresh.Branches) != 2 {
		t.Fatalf("branches 被副本改动污染：%+v", fresh.Branches)
	}
	if fresh.Branches["status"].Status != StatusSucceeded {
		t.Fatalf("branches 值被副本改动污染：%+v", fresh.Branches["status"])
	}
	if _, exists := fresh.Branches["models"]; exists {
		t.Fatal("副本新增的 branch 不应写回表内")
	}
	if len(fresh.FailedBranches) != 1 || fresh.FailedBranches[0] != "usage" {
		t.Fatalf("failedBranches 被副本改动污染：%+v", fresh.FailedBranches)
	}
	if fresh.FinishedAt == nil || *fresh.FinishedAt != finishedAt {
		t.Fatalf("finishedAt 被副本改动污染：%+v", fresh.FinishedAt)
	}
	if fresh.Error != "部分失败" {
		t.Fatalf("error 被副本改动污染：%q", fresh.Error)
	}
}

func TestUsageSnapshotJSONOmitsBranches(t *testing.T) {
	store, _ := newTestStore(t, Options{})
	job := startImmediate(t, store, "codex", "acct_1", ScopeUsage)

	payload, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("反序列化失败：%v", err)
	}
	if _, exists := decoded["branches"]; exists {
		t.Fatalf("usage 作业不应带 branches：%s", payload)
	}
	if _, exists := decoded["failedBranches"]; exists {
		t.Fatalf("空 failedBranches 不应出现在 JSON 里：%s", payload)
	}
	if _, exists := decoded["recovered"]; exists {
		t.Fatalf("recovered=false 不应出现在 JSON 里：%s", payload)
	}
	for _, key := range []string{
		"id", "provider", "accountRef", "status", "createdAt", "updatedAt",
		"finishedAt", "error", "scope",
	} {
		if _, exists := decoded[key]; !exists {
			t.Fatalf("缺少 Node 契约字段 %q：%s", key, payload)
		}
	}
	if decoded["scope"] != ScopeUsage {
		t.Fatalf("scope 应为 usage：%s", payload)
	}
	if decoded["status"] != StatusSucceeded {
		t.Fatalf("status 应为 succeeded：%s", payload)
	}
	if decoded["finishedAt"] == nil {
		t.Fatalf("终态 finishedAt 应为毫秒数字：%s", payload)
	}
}

func TestQueuedSnapshotJSONHasNullFinishedAt(t *testing.T) {
	store, _ := newTestStore(t, Options{})
	started := make(chan struct{})
	release := make(chan struct{})
	job, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: "codex", AccountRef: "acct_1", Scope: ScopeUsage,
		Run: func(context.Context) (Snapshot, error) {
			close(started)
			<-release
			return Snapshot{}, nil
		},
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}

	payload, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if !strings.Contains(string(payload), `"finishedAt":null`) {
		t.Fatalf("queued 作业的 finishedAt 应为 null：%s", payload)
	}

	<-started
	close(release)
	waitForStatus(t, store, job.ID, StatusSucceeded)
}

func TestDefaultJobIDMatchesNodeShape(t *testing.T) {
	store := New(Options{})
	job, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: " Codex ", AccountRef: "acct_1", Scope: ScopeUsage,
		Run: func(context.Context) (Snapshot, error) { return Snapshot{}, nil },
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}

	pattern := regexp.MustCompile(`^acct-refresh-codex-acct_1-[0-9a-z]+-[0-9a-f]{8}$`)
	if !pattern.MatchString(job.ID) {
		t.Fatalf("默认作业 ID 形状与 Node 不一致：%q", job.ID)
	}
	waitForStatus(t, store, job.ID, StatusSucceeded)
}

func TestZeroValueStoreDoesNotPanic(t *testing.T) {
	var store Store
	if store.Len() != 0 {
		t.Fatalf("零值 Store 的 Len 应为 0，实际 %d", store.Len())
	}
	if _, exists := store.Get("missing"); exists {
		t.Fatal("零值 Store 不应查到作业")
	}

	job, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: "codex", AccountRef: "acct_1", Scope: ScopeUsage,
		Run: func(context.Context) (Snapshot, error) { return Snapshot{}, nil },
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}
	if job.ID == "" || job.Status != StatusQueued {
		t.Fatalf("零值 Store 应能正常启动作业：%+v", job)
	}
	waitForStatus(t, &store, job.ID, StatusSucceeded)
}

func TestRunPanicMarksJobFailed(t *testing.T) {
	store, _ := newTestStore(t, Options{})
	job, alreadyRunning := store.Start(context.Background(), StartRequest{
		Provider: "codex", AccountRef: "acct_1", Scope: ScopeUsage,
		Run: func(context.Context) (Snapshot, error) {
			panic("boom")
		},
	})
	if alreadyRunning {
		t.Fatal("首次启动不应复用作业")
	}

	done := waitForStatus(t, store, job.ID, StatusFailed)
	if !strings.Contains(done.Error, "refresh_panic") {
		t.Fatalf("panic 应被收敛成 failed 作业：%q", done.Error)
	}
	if done.FinishedAt == nil {
		t.Fatal("panic 后的作业应写入 finishedAt")
	}
}
