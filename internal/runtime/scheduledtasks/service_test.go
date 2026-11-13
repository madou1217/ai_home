package scheduledtasks

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
)

type fakeAccountLister struct {
	accounts map[string][]string
}

func (l *fakeAccountLister) ListByProvider(_ context.Context, provider string) ([]string, error) {
	return append([]string(nil), l.accounts[provider]...), nil
}

type fakeExecutor struct {
	mu    sync.Mutex
	calls []string
}

func (e *fakeExecutor) Execute(_ context.Context, req accountactivity.ExecutionRequest) (map[string]any, error) {
	e.mu.Lock()
	e.calls = append(e.calls, req.Provider+":"+req.AccountRef+":"+req.ActionID)
	e.mu.Unlock()
	return map[string]any{
		"status": accountactivity.StatusClaimed,
	}, nil
}

func TestCronAndScheduleHelpers(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	cron := ParseCron("30 9 * * 1,3,5")
	if cron == nil {
		t.Fatalf("expected valid cron")
	}
	if desc := DescribeCron("30 9 * * 1,3,5"); !strings.Contains(desc, "09:30") {
		t.Fatalf("unexpected cron description: %q", desc)
	}
	hours := 1.0
	mins := 30.0
	norm := NormalizeSchedule(&ScheduleInput{Kind: "interval", Hours: &hours, Minutes: &mins})
	if norm == nil || *norm.Hours != 1 || *norm.Minutes != 30 {
		t.Fatalf("unexpected normalized interval: %+v", norm)
	}
	anchor := time.Date(2026, 11, 13, 10, 0, 0, 0, loc).UnixMilli()
	next := ComputeNextRunAt(norm, anchor+1000, anchor, loc)
	want := anchor + 90*60*1000
	if next != want {
		t.Fatalf("expected nextRunAt=%d, got %d", want, next)
	}
}

func TestServiceReconcileUpsertRunTickAndRecords(t *testing.T) {
	aiHome := t.TempDir()
	now := time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }

	// 预先写入一条崩溃残留 running=true 的状态。
	_, err := writeStateFile(aiHome, State{
		Version: StateVersion,
		Tasks: []Task{{
			ID:        "stask-stale",
			Name:      "stale",
			EventID:   CustomCommandEventID,
			Schedule:  &Schedule{Kind: "daily", At: "09:05"},
			Enabled:   true,
			Running:   true,
			NextRunAt: now.Add(5 * time.Minute).UnixMilli(),
		}},
	}, now.UnixMilli())
	if err != nil {
		t.Fatalf("seed state failed: %v", err)
	}

	catalog := accountactivity.NewCatalog(map[string][]accountactivity.Action{
		"zcode": {{
			ID:               "trial_plan",
			Label:            "领体验包",
			Schedulable:      true,
			ScheduleDebounce: time.Minute,
		}},
	})
	jobs := accountactivity.NewJobManager(clock, nil)
	exec := &fakeExecutor{}
	lister := &fakeAccountLister{accounts: map[string][]string{"zcode": {"acct-1"}}}
	actSvc, err := accountactivity.NewService(accountactivity.ServiceDependencies{
		Catalog:  catalog,
		Accounts: lister,
		Executor: exec,
		Jobs:     jobs,
		Now:      clock,
	})
	if err != nil {
		t.Fatalf("NewService(activity) failed: %v", err)
	}

	var customCommands []string
	svc, err := NewService(ServiceDependencies{
		AIHomeDir:        aiHome,
		Catalog:          catalog,
		ActivityService:  actSvc,
		ActivityAccounts: lister,
		Now:              clock,
		Location:         time.UTC,
		CustomRunner: func(_ context.Context, command string, _ string) EventResult {
			customCommands = append(customCommands, command)
			return EventResult{Status: "ok", Summary: "done"}
		},
	})
	if err != nil {
		t.Fatalf("NewService(scheduled) failed: %v", err)
	}

	list := svc.List()
	if len(list.Tasks) != 1 || list.Tasks[0].Running {
		t.Fatalf("expected stale running flag cleared, got %+v", list.Tasks)
	}
	if len(list.Events) < 2 {
		t.Fatalf("expected activity + custom events, got %+v", list.Events)
	}

	// 新建活动计划任务与自定义命令任务。
	actTask, errCode := svc.Upsert(UpsertInput{
		Name:     "每日领卡",
		EventID:  "activity:zcode:trial_plan",
		Schedule: &ScheduleInput{Kind: "daily", At: "10:00"},
	})
	if errCode != "" || actTask.ID == "" {
		t.Fatalf("Upsert activity failed: %s", errCode)
	}
	cmdTask, errCode := svc.Upsert(UpsertInput{
		Name:        "清理日志",
		EventID:     CustomCommandEventID,
		EventParams: map[string]any{"command": "echo hi"},
		Schedule:    &ScheduleInput{Kind: "daily", At: "09:01"},
	})
	if errCode != "" || cmdTask.ID == "" {
		t.Fatalf("Upsert custom failed: %s", errCode)
	}

	// 验证手动执行活动任务与防抖跳过。
	res1 := svc.RunTask(context.Background(), actTask.ID, TriggerManual)
	if !res1.OK || res1.Record == nil || res1.Record.Status != "ok" {
		t.Fatalf("expected ok record, got %+v", res1)
	}
	if !strings.Contains(res1.Record.Summary, "领取 1/1 成功") {
		t.Fatalf("unexpected summary: %q", res1.Record.Summary)
	}
	res2 := svc.RunTask(context.Background(), actTask.ID, TriggerManual)
	if !res2.OK || !res2.Skipped || res2.Reason != "debounced" {
		t.Fatalf("expected debounced skip, got %+v", res2)
	}

	// 推进时钟触发自定义命令任务 tick。
	now = now.Add(2 * time.Minute)
	svc.Tick(context.Background())
	if len(customCommands) != 1 || customCommands[0] != "echo hi" {
		t.Fatalf("expected custom task triggered on tick, got %+v", customCommands)
	}

	// 分页过滤 records。
	recs := svc.Records(RecordsQuery{TaskID: cmdTask.ID, Days: 7, Limit: 10})
	if recs.Total != 1 || len(recs.Records) != 1 || recs.Records[0].Trigger != TriggerSchedule {
		t.Fatalf("unexpected records query result: %+v", recs)
	}

	// toggle & remove。
	toggled, errCode := svc.SetEnabled(cmdTask.ID, false)
	if errCode != "" || toggled.Enabled || toggled.NextRunAt != 0 {
		t.Fatalf("expected disabled task, got %+v err=%s", toggled, errCode)
	}
	if ok, errCode := svc.Remove(cmdTask.ID); !ok || errCode != "" {
		t.Fatalf("Remove failed: %v %s", ok, errCode)
	}
}
