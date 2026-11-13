package housekeeping

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type stubInvalidator struct {
	failFor map[string]error
	leaveOn bool
	called  []CodexAppServerTarget
}

func (s *stubInvalidator) Invalidate(_ context.Context, target CodexAppServerTarget) error {
	s.called = append(s.called, target)
	if err, ok := s.failFor[target.RuntimeScope]; ok {
		return err
	}
	if s.leaveOn {
		return nil
	}
	return os.Remove(target.StatePath)
}

func TestPruneStaleCodexAppServerStates(t *testing.T) {
	aiHome := t.TempDir()
	stateDir := filepath.Join(aiHome, "run", "codex-app-server")
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}

	activeRef := "acct_11111111111111111111"
	disabledRef := "acct_22222222222222222222"
	deletedRef := "acct_33333333333333333333"
	failRef := "acct_44444444444444444444"

	files := map[string]string{
		"gateway.json":                 `{"port":3501}`,
		"chat-gateway.json":            `{"port":3502}`,
		activeRef + ".json":            `{"accountRef":"` + activeRef + `","runtimeScope":"` + activeRef + `","port":3503}`,
		"chat-" + activeRef + ".json":  `{"accountRef":"` + activeRef + `","runtimeScope":"chat-` + activeRef + `","port":3504}`,
		disabledRef + ".json":          `{"accountRef":"` + disabledRef + `","runtimeScope":"` + disabledRef + `","port":3505,"multiplexer":"tmux"}`,
		"chat-" + deletedRef + ".json": `{"accountRef":"` + deletedRef + `","runtimeScope":"chat-` + deletedRef + `","port":3506}`,
		failRef + ".json":              `{"accountRef":"` + failRef + `","runtimeScope":"` + failRef + `","port":3507}`,
		"mismatch.json":                `{"accountRef":"` + activeRef + `"}`,
		"badjson.json":                 `{corrupt`,
		activeRef + ".json.bak":        `ignored`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(stateDir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	inv := &stubInvalidator{
		failFor: map[string]error{failRef: errors.New("still running")},
	}
	if _, err := PruneStaleCodexAppServerStates(context.Background(), CodexAppServerPruneOptions{
		AIHomeDir:   aiHome,
		Accounts:    stubAccountsReader{err: errors.New("db error")},
		Invalidator: inv,
	}); err == nil {
		t.Fatal("expected reader error")
	}
	if len(inv.called) != 0 {
		t.Fatalf("unexpected invalidator calls: %+v", inv.called)
	}

	summary, err := PruneStaleCodexAppServerStates(context.Background(), CodexAppServerPruneOptions{
		AIHomeDir: aiHome,
		Accounts: stubAccountsReader{
			accounts: []RegisteredAccount{
				{Provider: "codex", AccountRef: activeRef, Enabled: true, Status: "up"},
				{Provider: "codex", AccountRef: disabledRef, Enabled: false, Status: "down"},
			},
		},
		Invalidator: inv,
	})
	if err != nil {
		t.Fatalf("PruneStaleCodexAppServerStates() err = %v", err)
	}
	if summary.Kept != 4 || summary.Removed != 2 || summary.Failed != 3 {
		t.Fatalf("summary = %+v, want Kept=4 Removed=2 Failed=3", summary)
	}
	if _, err := os.Stat(filepath.Join(stateDir, disabledRef+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("disabled state should be removed, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "chat-"+deletedRef+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("chat deleted state should be removed, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, failRef+".json")); err != nil {
		t.Fatalf("failed invalidation state should remain, err = %v", err)
	}

	aiHome2 := t.TempDir()
	stateDir2 := filepath.Join(aiHome2, "run", "codex-app-server")
	_ = os.MkdirAll(stateDir2, 0o755)
	_ = os.WriteFile(filepath.Join(stateDir2, deletedRef+".json"), []byte(`{"accountRef":"`+deletedRef+`"}`), 0o600)
	summary2, err := PruneStaleCodexAppServerStates(context.Background(), CodexAppServerPruneOptions{
		AIHomeDir:   aiHome2,
		Accounts:    stubAccountsReader{},
		Invalidator: &stubInvalidator{leaveOn: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if summary2.Removed != 0 || summary2.Failed != 1 {
		t.Fatalf("summary2 = %+v, want Removed=0 Failed=1", summary2)
	}
}

type fakeCommandCall struct {
	name string
	args []string
}

type fakeCommandRunner struct {
	calls   []fakeCommandCall
	handler func(name string, args ...string) (string, string, int, error)
}

func (f *fakeCommandRunner) Run(_ context.Context, name string, args ...string) (string, string, int, error) {
	f.calls = append(f.calls, fakeCommandCall{name: name, args: append([]string(nil), args...)})
	return f.handler(name, args...)
}

func TestOSCodexEndpointInvalidatorPosixAndSafetyChecks(t *testing.T) {
	dir := t.TempDir()
	ref := "acct_abcdef0123456789abcd"
	scope := "chat-" + ref
	statePath := filepath.Join(dir, scope+".json")
	if err := os.WriteFile(statePath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	var killedPIDs []int
	runner := &fakeCommandRunner{
		handler: func(name string, args ...string) (string, string, int, error) {
			joined := name + " " + strings.Join(args, " ")
			switch {
			case joined == "tmux -V":
				return "tmux 3.4", "", 0, nil
			case strings.Contains(joined, "kill-server"):
				return "", "", 0, nil
			case strings.HasPrefix(joined, "lsof -nP -iTCP:3555"):
				return "2222\n3333\n", "", 0, nil
			case joined == "ps -o command= -p 2222":
				return "codex app-server --listen ws://127.0.0.1:3555", "", 0, nil
			case joined == "ps -o command= -p 3333":
				return "python3 -m http.server 3555", "", 0, nil
			case strings.Contains(joined, "has-session"):
				return "", "cannot find session", 1, errors.New("exit 1")
			default:
				return "", "", 1, errors.New("unexpected")
			}
		},
	}

	invalidator := OSCodexEndpointInvalidator{
		Runner:   runner,
		Platform: "darwin",
		Env:      func(k string) string { return "" },
		UID:      func() int { return 501 },
		KillPID: func(pid int) error {
			killedPIDs = append(killedPIDs, pid)
			return nil
		},
	}

	err := invalidator.Invalidate(context.Background(), CodexAppServerTarget{
		RuntimeScope:     scope,
		RuntimeNamespace: "chat",
		AccountRef:       ref,
		StatePath:        statePath,
		Port:             3555,
		Socket:           AppServerSocketName(scope),
		Multiplexer:      "tmux",
	})
	if err != nil {
		t.Fatalf("Invalidate() err = %v", err)
	}
	if !slices.Equal(killedPIDs, []int{2222}) {
		t.Fatalf("killedPIDs = %v, want [2222]", killedPIDs)
	}
	if _, err := os.Stat(statePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("statePath should be removed, err = %v", err)
	}

	badStatePath := filepath.Join(dir, ref+".json")
	_ = os.WriteFile(badStatePath, []byte("{}"), 0o600)
	if err := invalidator.Invalidate(context.Background(), CodexAppServerTarget{
		RuntimeScope: ref,
		AccountRef:   ref,
		StatePath:    badStatePath,
		Multiplexer:  "screen",
	}); err == nil {
		t.Fatal("expected error for unknown multiplexer")
	}
	if err := invalidator.Invalidate(context.Background(), CodexAppServerTarget{
		RuntimeScope: ref,
		AccountRef:   ref,
		StatePath:    badStatePath,
		Socket:       "wrong-socket",
	}); err == nil {
		t.Fatal("expected error for mismatched socket")
	}
	if _, err := os.Stat(badStatePath); err != nil {
		t.Fatalf("badStatePath must not be deleted on rejection: %v", err)
	}
}
