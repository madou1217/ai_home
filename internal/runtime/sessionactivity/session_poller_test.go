package sessionactivity

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeTmuxRunner struct {
	detect   TmuxDetectResult
	sessions map[string][]TmuxSession
}

func (f *fakeTmuxRunner) Detect(context.Context) TmuxDetectResult {
	return f.detect
}

func (f *fakeTmuxRunner) ListSessionsForAccount(_ context.Context, _ string, provider, accountRef string, includeDetached bool) []TmuxSession {
	all := f.sessions[provider+":"+accountRef]
	out := make([]TmuxSession, 0, len(all))
	for _, s := range all {
		if includeDetached {
			if !s.PaneDead {
				out = append(out, s)
			}
		} else if s.Attached {
			out = append(out, s)
		}
	}
	return out
}

func TestDeriveAndParseTmuxSessions(t *testing.T) {
	socket, ok := DeriveTmuxSocket("codex", "acct_0123456789abcdef0123")
	if !ok || socket != "aih-codex-acct_0123456789abcdef0123" {
		t.Fatalf("unexpected socket %q ok=%v", socket, ok)
	}

	line14 := strings.Join([]string{
		"s1", "1", "1700000000", "/tmp/work", "Codex Title",
		"win", "codex", "4242", "", "0", "/tmp/work", "", "1700000005", "1700000005",
	}, "\x1f")
	lineDead := strings.Join([]string{
		"s2", "0", "1700000000", "/tmp/dead", "Dead",
		"win2", "codex", "9999", "", "1", "/tmp/dead", "", "1700000001", "1700000001",
	}, "\x1f")
	parsed := ParseTmuxSessionList(line14 + "\n" + lineDead)
	if len(parsed) != 2 {
		t.Fatalf("expected 2 parsed sessions, got %d", len(parsed))
	}
	if !parsed[0].Attached || parsed[0].PaneDead || parsed[0].LastActivityAtMS != 1700000005000 || parsed[0].PanePID != 4242 {
		t.Fatalf("unexpected session 0: %+v", parsed[0])
	}
	if parsed[1].Attached || !parsed[1].PaneDead {
		t.Fatalf("unexpected dead session: %+v", parsed[1])
	}
}

func TestCombineTurnSignalsPrecedence(t *testing.T) {
	// 1. Decisive idle overrides everything
	d1 := CombineTurnSignals([]TurnSignal{
		{State: TurnActive, Authority: AuthorityTurn, LastActivityAt: 9999, Source: "tmux"},
		{State: TurnIdle, Authority: AuthorityTurn, Decisive: true, LastActivityAt: 1000, Source: "cline"},
	})
	if d1.Action != "idle" || d1.Source != "cline" {
		t.Fatalf("expected decisive idle, got %+v", d1)
	}

	// 2. Active >= authoritative idle picks active
	d2 := CombineTurnSignals([]TurnSignal{
		{State: TurnIdle, Authority: AuthorityTurn, LastActivityAt: 2000, Source: "kiro"},
		{State: TurnActive, Authority: AuthorityPositive, LastActivityAt: 2000, Source: "tmux"},
	})
	if d2.Action != "active" || d2.Source != "tmux" {
		t.Fatalf("expected active on tie/newer, got %+v", d2)
	}

	// 3. Authoritative idle newer than active turns off
	d3 := CombineTurnSignals([]TurnSignal{
		{State: TurnActive, Authority: AuthorityPositive, LastActivityAt: 1500, Source: "tmux"},
		{State: TurnIdle, Authority: AuthorityTurn, LastActivityAt: 2500, Source: "kiro"},
	})
	if d3.Action != "idle" || d3.Source != "kiro" {
		t.Fatalf("expected authoritative idle, got %+v", d3)
	}
}

func TestSessionActivityPollerDisabledAndProbes(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	nowMS := int64(1_700_000_050_000)

	const (
		refHook     = "acct_11111111111111111111"
		refDisabled = "acct_22222222222222222222"
		refCline    = "acct_33333333333333333333"
		refKiro     = "acct_44444444444444444444"
	)

	// Write Cline session record (completed -> decisive idle)
	clineDir := filepath.Join(hostHome, ".cline", "data", "sessions", "cs1")
	if err := os.MkdirAll(clineDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(clineDir, "cs1.messages.json"), []byte("[]"), 0o644)
	_ = os.WriteFile(filepath.Join(clineDir, "cs1.json"), []byte(`{"session_id":"cs1","status":"completed","cwd":"/work/cline","started_at":1700000000000,"ended_at":1700000045000}`), 0o644)

	// Write Kiro messages.jsonl (active turn without usage_summary yet)
	kiroDir := filepath.Join(hostHome, ".kiro", "sessions", "0123456789abcdef", "sess_001")
	if err := os.MkdirAll(kiroDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(kiroDir, "session.json"), []byte(`{"id":"sess_001","modelId":"claude-sonnet-4","workspacePaths":["/work/kiro"],"createdAt":1700000000000}`), 0o644)
	_ = os.WriteFile(filepath.Join(kiroDir, "messages.jsonl"), []byte("{\"id\":\"m1\",\"timestamp\":1700000048000,\"payload\":{\"type\":\"assistant\",\"content\":\"hello\"}}\n"), 0o644)

	entries := []RegistryEntry{
		{Provider: "codex", AccountRef: refHook, Cwd: "/work/codex", CreatedAtMS: 1_700_000_000_000, UpdatedAtMS: 1_700_000_040_000},
		{Provider: "codex", AccountRef: refDisabled, Cwd: "/work/dis", CreatedAtMS: 1_700_000_000_000, UpdatedAtMS: 1_700_000_040_000},
		{Provider: "cline", AccountRef: refCline, Cwd: "/work/cline", CreatedAtMS: 1_700_000_000_000, UpdatedAtMS: 1_700_000_040_000},
		{Provider: "kiro", AccountRef: refKiro, Cwd: "/work/kiro", CreatedAtMS: 1_700_000_000_000, UpdatedAtMS: 1_700_000_040_000},
		{Provider: "codex", AccountRef: "gateway_ignored", Gateway: true},
	}

	act := NewAccountActivity(AccountActivityOptions{
		Now: func() time.Time { return time.UnixMilli(nowMS) },
	})
	// Pre-mark hook session turn and cline session turn to test hook retention vs cline decisive end
	act.MarkSessionTurn("codex", refHook, 30*time.Second)
	act.MarkSessionTurn("cline", refCline, 30*time.Second)

	tmux := &fakeTmuxRunner{
		detect: TmuxDetectResult{Available: true, Command: "tmux"},
		sessions: map[string][]TmuxSession{
			"codex:" + refHook: {
				// Quiet pane: for hook mode this must NOT turn off sessionTurnActive
				{Name: "p1", Attached: true, LastActivityAtMS: nowMS - 120_000},
			},
			"codex:" + refDisabled: {
				{Name: "p2", Attached: true, LastActivityAtMS: nowMS - 1_000},
			},
			"cline:" + refCline: {
				{Name: "p3", Attached: true, LastActivityAtMS: nowMS - 1_000, StartPath: "/work/cline", Path: "/work/cline"},
			},
			"kiro:" + refKiro: {
				{Name: "p4", Attached: true, LastActivityAtMS: nowMS - 40_000, StartPath: "/work/kiro", Path: "/work/kiro"},
			},
		},
	}

	poller := NewSessionActivityPoller(SessionPollerOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Activity:    act,
		Tmux:        tmux,
		Interval:    5 * time.Second,
		ListAccountRefs: func(context.Context) []AccountRefRecord {
			return []AccountRefRecord{
				{Provider: "codex", AccountRef: refHook, Enabled: true},
				{Provider: "codex", AccountRef: refDisabled, Enabled: false},
				{Provider: "cline", AccountRef: refCline, Enabled: true},
				{Provider: "kiro", AccountRef: refKiro, Enabled: true},
			}
		},
		ListRegistryEntries: func() []RegistryEntry { return entries },
		IsAccountEnabled: func(_ context.Context, _, ref string) bool {
			return ref != refDisabled
		},
		ResolveHarnessTurnMode: func(harnessID string) string {
			if harnessID == "codex" {
				return "hook"
			}
			return "polling"
		},
		ProcessAlive: func(int) (bool, bool) { return false, true },
		Now:          func() time.Time { return time.UnixMilli(nowMS) },
	})

	summary := poller.Tick(context.Background())
	if !summary.TmuxAvailable || summary.Scopes != 4 || summary.SkippedDisabled != 1 || summary.AccountsWithSessions != 3 {
		t.Fatalf("unexpected poller summary: %+v", summary)
	}

	snap := act.Snapshot()
	// Disabled account must not appear
	if _, exists := snap["codex:"+refDisabled]; exists {
		t.Fatalf("disabled account should not be marked runtime active")
	}
	// Hook mode codex retains sessionTurnActive despite quiet tmux pane
	if !snap["codex:"+refHook].SessionTurnActive || !snap["codex:"+refHook].RuntimeActive {
		t.Fatalf("expected hook codex to remain sessionTurnActive, got %+v", snap["codex:"+refHook])
	}
	// Cline decisive completed session turns off sessionTurnActive even with recent tmux activity
	if snap["cline:"+refCline].SessionTurnActive {
		t.Fatalf("expected cline completed session to clear sessionTurnActive, got %+v", snap["cline:"+refCline])
	}
	// Kiro active assistant line without usage_summary lights sessionTurnActive
	if !snap["kiro:"+refKiro].SessionTurnActive {
		t.Fatalf("expected kiro ongoing turn to mark sessionTurnActive, got %+v", snap["kiro:"+refKiro])
	}
	rawJSON, _ := json.Marshal(snap)
	if len(rawJSON) == 0 {
		t.Fatal("empty json")
	}
}
