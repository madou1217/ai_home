package multiplexer

import (
	"context"
	"strings"
	"testing"
)

func TestRunnerExecutesInjectedTmuxCommandAndParsesSessions(t *testing.T) {
	called := make([]string, 0)
	runner := NewRunner(func(_ context.Context, command string, args ...string) (Result, error) {
		called = append(called, command, strings.Join(args, " "))
		return Result{Stdout: "s-project\t0\t1735000000\t/tmp/project\n"}, nil
	})
	sessions, err := runner.List(context.Background(), ListOptions{Command: "tmux", Socket: "aih-codex-acct_0123"})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(sessions) != 1 || sessions[0].Name != "s-project" || sessions[0].Attached || sessions[0].Path != "/tmp/project" {
		t.Fatalf("sessions = %#v", sessions)
	}
	if len(called) != 2 || called[0] != "tmux" || !strings.Contains(called[1], "list-sessions") {
		t.Fatalf("called = %#v", called)
	}
}
