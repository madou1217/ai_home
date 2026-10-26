package persistent

import (
	"context"
	"reflect"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/multiplexer"
)

type fakeRunner struct {
	invocations []multiplexer.Invocation
}

func (runner *fakeRunner) Execute(_ context.Context, invocation multiplexer.Invocation) error {
	runner.invocations = append(runner.invocations, invocation)
	return nil
}

func TestManagerUsesStrictCreateExactAttachAndDetachedRestore(t *testing.T) {
	registry, err := NewRegistry(t.TempDir())
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	mux := multiplexer.NewTmuxDriver()
	runner := &fakeRunner{}
	manager := NewManager(registry, mux, runner)
	base := SessionSpec{Provider: "codex", AccountRef: "acct_0123456789abcdef0123", Socket: "aih-codex-acct_0123456789abcdef0123", Session: "s-project", CWD: "/tmp", Inner: multiplexer.Command{Path: "codex"}}
	if err := manager.Create(context.Background(), base); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := manager.Attach(context.Background(), base, false); err != nil {
		t.Fatalf("Attach() error = %v", err)
	}
	if err := manager.Restore(context.Background(), base); err != nil {
		t.Fatalf("Restore() error = %v", err)
	}
	if len(runner.invocations) != 3 {
		t.Fatalf("invocations = %#v", runner.invocations)
	}
	if reflect.DeepEqual(runner.invocations[0].Args, runner.invocations[2].Args) || runner.invocations[0].Detached || !runner.invocations[2].Detached {
		t.Fatalf("create/restore invocations = %#v", runner.invocations)
	}
	entries, err := registry.List(context.Background())
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %#v, err = %v", entries, err)
	}
}
