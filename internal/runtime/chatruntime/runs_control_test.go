package chatruntime

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

func openRunsTestService(t *testing.T, opts ...func(*ServiceOptions)) *Service {
	t.Helper()
	tmp := t.TempDir()
	cfg := ServiceOptions{
		DBPath:      filepath.Join(tmp, "app-state.db"),
		AIHomeDir:   filepath.Join(tmp, ".ai_home"),
		HostHomeDir: tmp,
	}
	for _, fn := range opts {
		fn(&cfg)
	}
	svc, err := NewService(context.Background(), cfg)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	return svc
}

func TestRunsControlRegistryInputResizeAndAbort(t *testing.T) {
	ctx := context.Background()
	svc := openRunsTestService(t)

	var mu sync.Mutex
	var gotInputs []string
	var gotSteers []string
	var gotCols, gotRows int
	aborted := false

	svc.RegisterActiveRun(ActiveRunRegistration{
		RunID:           "run-1",
		Provider:        "Claude",
		AccountRef:      "acct-1",
		SessionID:       "sess-1",
		ProjectDirName:  "proj-a",
		ProjectPath:     "/tmp/proj-a",
		StartedAt:       100,
		InteractionMode: "confirm",
		WriteInput: func(input string, appendNewline bool) error {
			mu.Lock()
			defer mu.Unlock()
			if appendNewline {
				gotInputs = append(gotInputs, input+"\r")
			} else {
				gotInputs = append(gotInputs, input)
			}
			return nil
		},
		WriteSteer: func(content string) error {
			mu.Lock()
			defer mu.Unlock()
			gotSteers = append(gotSteers, content)
			return nil
		},
		Resize: func(cols, rows int) error {
			mu.Lock()
			defer mu.Unlock()
			gotCols = cols
			gotRows = rows
			return nil
		},
		Abort: func() error {
			mu.Lock()
			aborted = true
			mu.Unlock()
			return nil
		},
		GetContentSnapshot: func() string { return "hello snapshot" },
	})
	svc.RegisterActiveRun(ActiveRunRegistration{
		RunID:          "run-2",
		Provider:       "codex",
		AccountRef:     "acct-2",
		SessionID:      "sess-2",
		ProjectDirName: "",
		StartedAt:      200,
	})

	runs, err := svc.ListActiveRuns(ctx, ListActiveRunsFilter{Provider: "claude", ProjectDirName: "proj-a"})
	if err != nil {
		t.Fatalf("ListActiveRuns: %v", err)
	}
	if len(runs) != 1 || runs[0].RunID != "run-1" || runs[0].ContentSnapshot != "hello snapshot" {
		t.Fatalf("unexpected filtered runs: %+v", runs)
	}

	// projectDirName 仅在两边都有值时过滤（codex 无 projectDirName 也应被保留）
	codexRuns, err := svc.ListActiveRuns(ctx, ListActiveRunsFilter{Provider: "codex", ProjectDirName: "proj-a"})
	if err != nil {
		t.Fatalf("ListActiveRuns codex: %v", err)
	}
	if len(codexRuns) != 1 || codexRuns[0].RunID != "run-2" {
		t.Fatalf("expected run-2 kept when run projectDirName empty, got %+v", codexRuns)
	}

	if err := svc.WriteRunInput(ctx, "run-1", "ls", true, ""); err != nil {
		t.Fatalf("WriteRunInput input: %v", err)
	}
	if err := svc.WriteRunInput(ctx, "run-1", "focus tests", false, "steer"); err != nil {
		t.Fatalf("WriteRunInput steer: %v", err)
	}
	if err := svc.WriteRunInput(ctx, "run-missing", "ls", true, ""); err == nil || errorCode(err) != "native_chat_run_not_found" {
		t.Fatalf("expected native_chat_run_not_found, got %v", err)
	}
	if err := svc.WriteRunInput(ctx, "run-1", "", true, ""); err == nil || errorCode(err) != "native_chat_input_empty" {
		t.Fatalf("expected native_chat_input_empty, got %v", err)
	}
	if err := svc.WriteRunInput(ctx, "run-2", "hi", false, "steer"); err == nil || errorCode(err) != "native_steer_unsupported" {
		t.Fatalf("expected native_steer_unsupported, got %v", err)
	}

	c, rw, err := svc.ResizeRun(ctx, "run-1", 999, 2)
	if err != nil || c != 400 || rw != 4 {
		t.Fatalf("expected clamped resize 400x4, got (%d,%d,%v)", c, rw, err)
	}
	mu.Lock()
	if len(gotInputs) != 1 || gotInputs[0] != "ls\r" || len(gotSteers) != 1 || gotSteers[0] != "focus tests" || gotCols != 400 || gotRows != 4 {
		mu.Unlock()
		t.Fatalf("unexpected callbacks state: inputs=%v steers=%v cols=%d rows=%d", gotInputs, gotSteers, gotCols, gotRows)
	}
	mu.Unlock()

	gone, err := svc.AbortRun(ctx, "run-1")
	if err != nil || gone {
		t.Fatalf("AbortRun run-1: gone=%v err=%v", gone, err)
	}
	mu.Lock()
	if !aborted {
		mu.Unlock()
		t.Fatal("expected Abort callback invoked")
	}
	mu.Unlock()

	gone2, err := svc.AbortRun(ctx, "run-1")
	if err != nil || !gone2 {
		t.Fatalf("expected idempotent alreadyGone=true on second abort, got gone=%v err=%v", gone2, err)
	}
}

func TestRunsControlCanonicalNativeApprovalAndDisconnectExpiry(t *testing.T) {
	ctx := context.Background()
	svc := openRunsTestService(t)
	sess, err := svc.CreateSession(ctx, CreateSessionInput{
		Provider:            "claude",
		ExecutionAccountRef: "acct-1",
		ProjectPath:         t.TempDir(),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	surface := NewNativeApprovalSurface(svc.Store(), sess.SessionID, "claude", "acct-1")
	t.Cleanup(surface.Dispose)
	svc.RegisterApprovalSurface(sess.SessionID, surface)
	svc.BindApprovalSurfaceRun("run-canon-1", surface)

	evCh := make(chan EventEnvelope, 16)
	unsub, err := svc.EventHub().Subscribe(sess.SessionID, func(ev EventEnvelope) {
		evCh <- ev
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer unsub()

	type reqResult struct {
		dec map[string]any
		err error
	}
	resCh := make(chan reqResult, 1)
	go func() {
		dec, rerr := svc.RequestNativeApproval(ctx, NativeApprovalInboundRequest{
			RunID:     "run-canon-1",
			ToolName:  "Bash",
			Input:     map[string]any{"command": "echo hi"},
			ToolUseID: "tu-1",
		})
		resCh <- reqResult{dec: dec, err: rerr}
	}()

	var interactionID string
	deadline := time.After(3 * time.Second)
	for interactionID == "" {
		select {
		case ev := <-evCh:
			if ev.Type == "interaction.requested" {
				if inter, _ := ev.Payload["interaction"].(map[string]any); inter != nil {
					interactionID = asString(inter["interactionId"])
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for interaction.requested event")
		}
	}

	outcome, err := svc.DecideNativeApproval(ctx, "run-canon-1", interactionID, "allow", "")
	if err != nil {
		t.Fatalf("DecideNativeApproval: %v", err)
	}
	if outcome.Decision != "allow" || outcome.AlreadyResolved {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}

	res := <-resCh
	if res.err != nil {
		t.Fatalf("RequestNativeApproval failed: %v", res.err)
	}
	if res.dec["behavior"] != "allow" {
		t.Fatalf("expected allow decision, got %+v", res.dec)
	}

	// 验证客户端断连时自动过期持久化交互并广播 interaction.expired
	reqCtx, cancelReq := context.WithCancel(ctx)
	resCh2 := make(chan reqResult, 1)
	go func() {
		dec, rerr := svc.RequestNativeApproval(reqCtx, NativeApprovalInboundRequest{
			RunID:    "run-canon-1",
			ToolName: "Write",
			Input:    map[string]any{"path": "/tmp/x"},
		})
		resCh2 <- reqResult{dec: dec, err: rerr}
	}()

	var inter2ID string
	deadline2 := time.After(3 * time.Second)
	for inter2ID == "" {
		select {
		case ev := <-evCh:
			if ev.Type == "interaction.requested" {
				if inter, _ := ev.Payload["interaction"].(map[string]any); inter != nil {
					inter2ID = asString(inter["interactionId"])
				}
			}
		case <-deadline2:
			t.Fatal("timed out waiting for second interaction.requested")
		}
	}

	cancelReq()
	_ = <-resCh2

	expiredSeen := false
	deadline3 := time.After(3 * time.Second)
	for !expiredSeen {
		select {
		case ev := <-evCh:
			if ev.Type == "interaction.expired" {
				if inter, _ := ev.Payload["interaction"].(map[string]any); inter != nil && asString(inter["interactionId"]) == inter2ID {
					expiredSeen = true
				}
			}
		case <-deadline3:
			t.Fatal("expected interaction.expired event on client disconnect")
		}
	}
}

func TestRunsControlStandaloneApprovalAndCLIInstallConfirmation(t *testing.T) {
	ctx := context.Background()
	svc := openRunsTestService(t)
	svc.RegisterActiveRun(ActiveRunRegistration{
		RunID:    "run-ext-1",
		Provider: "claude",
	})

	decCh := make(chan map[string]any, 1)
	go func() {
		dec, _ := svc.RequestNativeApproval(ctx, NativeApprovalInboundRequest{
			RunID:    "run-ext-1",
			ToolName: "Edit",
			Input:    map[string]any{"file": "a.go"},
		})
		decCh <- dec
	}()

	var promptID string
	for i := 0; i < 40 && promptID == ""; i++ {
		runs, _ := svc.ListActiveRuns(ctx, ListActiveRunsFilter{Provider: "claude"})
		if len(runs) == 1 && runs[0].ActivePrompt != nil {
			promptID = asString(runs[0].ActivePrompt["promptId"])
		}
		if promptID == "" {
			time.Sleep(15 * time.Millisecond)
		}
	}
	if promptID == "" {
		t.Fatal("expected pending standalone approval exposed in ListActiveRuns activePrompt")
	}

	out, err := svc.DecideNativeApproval(ctx, "run-ext-1", promptID, "deny", "不需要写入")
	if err != nil || out.AlreadyResolved || out.Decision != "deny" {
		t.Fatalf("unexpected standalone decide outcome: %+v err=%v", out, err)
	}
	dec := <-decCh
	if dec["behavior"] != "deny" || dec["message"] != "不需要写入" {
		t.Fatalf("unexpected standalone decision payload: %+v", dec)
	}

	// 二次决策返回 AlreadyResolved: true
	out2, err := svc.DecideNativeApproval(ctx, "run-ext-1", promptID, "allow", "")
	if err != nil || !out2.AlreadyResolved {
		t.Fatalf("expected alreadyResolved=true, got %+v err=%v", out2, err)
	}

	// CLI 安装确认注册表
	reg := svc.CLIInstallConfirmations()
	ticket := reg.Create("gemini", 2*time.Second)
	if !reg.Has(ticket.ConfirmationID) {
		t.Fatal("expected confirmation pending")
	}
	res := svc.DecideCLIInstallConfirmation(ticket.ConfirmationID, "CANCEL", "user")
	if res == nil || res.Decision != "cancel" {
		t.Fatalf("expected cancel outcome, got %+v", res)
	}
	waited, err := ticket.Wait(ctx)
	if err != nil || waited.Decision != "cancel" {
		t.Fatalf("unexpected waited ticket: %+v err=%v", waited, err)
	}

	// 超时自动 confirm
	ticket2 := reg.Create("codex", 30*time.Millisecond)
	waited2, err := ticket2.Wait(ctx)
	if err != nil || waited2.Decision != "confirm" || waited2.Source != "timeout" {
		t.Fatalf("expected timeout confirm, got %+v err=%v", waited2, err)
	}
}

type ptySlashTestRunner struct {
	scriptPath string
	workDir    string
}

func (r *ptySlashTestRunner) Start(ctx context.Context, req NativeRunRequest) (*NativeRunHandle, error) {
	if !pty.Available() {
		return nil, NewError("pty_unavailable", http.StatusServiceUnavailable, nil)
	}
	runner := &execNativeTurnRunner{}
	return runner.startInteractivePTY(ctx, req, "/bin/sh", []string{r.scriptPath}, r.workDir)
}

func TestInteractivePTYSlashTerminalTimelineAndInputResize(t *testing.T) {
	if !pty.Available() {
		t.Skip("pty unavailable")
	}
	ctx := context.Background()
	tmp := t.TempDir()
	scriptPath := filepath.Join(tmp, "pty_echo.sh")
	script := "#!/bin/sh\necho \"PTY_READY\"\nIFS= read -r line\necho \"GOT:$line\"\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}

	svc := openRunsTestService(t, func(opts *ServiceOptions) {
		opts.NativeRunner = &ptySlashTestRunner{scriptPath: scriptPath, workDir: tmp}
	})
	sess, err := svc.CreateSession(ctx, CreateSessionInput{
		Provider:            "claude",
		ExecutionAccountRef: "acct-1",
		ProjectPath:         tmp,
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	_, err = svc.DispatchCommand(ctx, sess.SessionID, map[string]any{
		"commandId": "cmd-pty-1",
		"type":      "slash.execute",
		"payload": map[string]any{
			"name":      "status",
			"arguments": "",
		},
	})
	if err != nil {
		t.Fatalf("DispatchCommand slash.execute: %v", err)
	}

	var runID string
	for i := 0; i < 60 && runID == ""; i++ {
		runs, _ := svc.ListActiveRuns(ctx, ListActiveRunsFilter{SessionID: sess.SessionID})
		if len(runs) > 0 {
			runID = runs[0].RunID
		}
		if runID == "" {
			time.Sleep(25 * time.Millisecond)
		}
	}
	if runID == "" {
		t.Fatal("timed out waiting for active PTY run")
	}

	if _, _, err := svc.ResizeRun(ctx, runID, 100, 40); err != nil {
		t.Fatalf("ResizeRun: %v", err)
	}
	if err := svc.WriteRunInput(ctx, runID, "你好PTY", true, ""); err != nil {
		t.Fatalf("WriteRunInput: %v", err)
	}
	if err := svc.WaitForActorIdle(ctx, sess.SessionID); err != nil {
		t.Fatalf("WaitForActorIdle: %v", err)
	}

	tl, err := svc.ReadTimeline(ctx, sess.SessionID, "", 30)
	if err != nil {
		t.Fatalf("ReadTimeline: %v", err)
	}
	var terminalItem *TimelineItem
	for i := range tl.Items {
		if tl.Items[i].Kind == "terminal" {
			terminalItem = &tl.Items[i]
		}
	}
	if terminalItem == nil {
		t.Fatalf("expected terminal timeline item, got %+v", tl.Items)
	}
	if terminalItem.Status != "completed" || asString(terminalItem.Detail["terminalId"]) != runID {
		t.Fatalf("unexpected terminal item metadata: %+v", terminalItem)
	}
	content := ""
	if terminalItem.Content != nil {
		content = *terminalItem.Content
	}
	if !strings.Contains(content, "PTY_READY") || !strings.Contains(content, "GOT:你好PTY") {
		t.Fatalf("expected PTY output echoed in terminal item, got %q", content)
	}
}
