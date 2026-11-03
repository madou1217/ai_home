package providercli

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

type fakePTYStarter struct {
	session *fakePTYSession
	spec    pty.Spec
}

func (starter *fakePTYStarter) Start(_ context.Context, spec pty.Spec) (pty.Session, error) {
	starter.spec = spec
	return starter.session, nil
}

type fakePTYSession struct {
	bytes.Buffer
	input bytes.Buffer
}

func (session *fakePTYSession) Close() error          { return nil }
func (session *fakePTYSession) Resize(pty.Size) error { return nil }
func (session *fakePTYSession) Wait() error           { return nil }

func TestRunnerUsesPTYForInteractiveDirectProcess(t *testing.T) {
	starter := &fakePTYStarter{session: &fakePTYSession{}}
	var stdout bytes.Buffer
	runner, err := NewRunner(Options{
		Stdin:       bytes.NewBufferString("hello"),
		Stdout:      &stdout,
		Stderr:      io.Discard,
		Interactive: true,
		PTYStarter:  starter,
	})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	// The direct process path is exercised through the narrow helper so the
	// test does not depend on an installed provider binary.
	if err := runner.runInteractiveDirect(context.Background(), "/bin/sh", nil, nil); err != nil {
		t.Fatalf("runInteractiveDirect() error = %v", err)
	}
	if starter.spec.Path != "/bin/sh" || starter.spec.Size.Rows == 0 || starter.spec.Size.Cols == 0 {
		t.Fatalf("PTY spec = %#v", starter.spec)
	}
}
