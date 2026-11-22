package systemproxy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"time"
)

const commandTimeout = 30 * time.Second

// backend is the platform-specific implementation. All backends receive an
// injected runner so dry-run execution control lives in one place.
type backend interface {
	scope() string
	capture(ctx context.Context, run runner) (Snapshot, error)
	listServices(ctx context.Context, run runner) ([]Service, error)
	apply(ctx context.Context, run runner, options ApplyOptions) (Result, error)
	restore(ctx context.Context, run runner, snapshot Snapshot, options RestoreOptions) (Result, error)
}

// runner executes one host command. It exists so the package has a single
// execution point and can guarantee dry-run never reaches an exec call.
type runner interface {
	Run(ctx context.Context, name string, args ...string) runResult
}

type runResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
	Err      error
}

func (r runResult) OK() bool {
	return r.Err == nil && r.ExitCode == 0
}

// commandRunner is the production runner. Commands are executed directly, not
// through a shell, with a per-command timeout derived from the caller context.
type commandRunner struct{}

func (commandRunner) Run(ctx context.Context, name string, args ...string) runResult {
	runContext, cancel := context.WithTimeout(nonNilContext(ctx), commandTimeout)
	defer cancel()

	command := exec.CommandContext(runContext, name, args...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr

	err := command.Run()
	result := runResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: 0}
	if err != nil {
		result.Err = err
		result.ExitCode = -1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			result.ExitCode = exitError.ExitCode()
			result.Err = nil
		}
	}
	return result
}

// step is one mutation in a plan. execName is empty for in-process actions such
// as notifying the OS that settings changed. action.Args must already be
// redacted; execArgs carry the real values and are never exposed.
type step struct {
	action    Action
	execName  string
	execArgs  []string
	inProcess func() error
}

type plan struct {
	op    string
	scope string
	steps []step
}

func newPlan(op, scope string) *plan {
	return &plan{op: op, scope: scope}
}

func (p *plan) addCommand(service, kind, name string, execArgs []string, displayArgs []string) {
	if displayArgs == nil {
		displayArgs = execArgs
	}
	p.steps = append(p.steps, step{
		action: Action{
			Service: service,
			Kind:    kind,
			Command: name,
			Args:    append([]string(nil), displayArgs...),
		},
		execName: name,
		execArgs: append([]string(nil), execArgs...),
	})
}

func (p *plan) addAction(service, kind, note string, run func() error) {
	p.steps = append(p.steps, step{
		action: Action{
			Service: service,
			Kind:    kind,
			Note:    note,
		},
		inProcess: run,
	})
}

func (p *plan) empty() bool {
	return len(p.steps) == 0
}

// execute runs a plan unless dryRun is set. It returns the redacted actions in
// both modes, so callers can display exactly what happened or would happen.
func (p *plan) execute(ctx context.Context, run runner, dryRun bool) (Result, error) {
	result := Result{
		Platform: runtime.GOOS,
		Scope:    p.scope,
		DryRun:   dryRun,
		Changed:  !p.empty(),
		Actions:  make([]Action, 0, len(p.steps)),
	}
	for _, item := range p.steps {
		result.Actions = append(result.Actions, item.action)
		if dryRun {
			continue
		}
		switch {
		case item.execName != "":
			outcome := run.Run(ctx, item.execName, item.execArgs...)
			if !outcome.OK() {
				return result, commandFailure(p.op, item.action, outcome)
			}
		case item.inProcess != nil:
			if err := item.inProcess(); err != nil {
				return result, fmt.Errorf(
					"systemproxy: %s %s for service %q: %w",
					p.op, item.action.Kind, item.action.Service, err,
				)
			}
		}
	}
	return result, nil
}

func commandFailure(op string, action Action, outcome runResult) error {
	detail := "command failed"
	switch {
	case outcome.Err != nil:
		detail = outcome.Err.Error()
	case outcome.ExitCode >= 0:
		detail = fmt.Sprintf("exit status %d", outcome.ExitCode)
	}
	return fmt.Errorf(
		"systemproxy: %s %s via %s for service %q: %s: %w",
		op, action.Kind, action.Command, action.Service, detail, ErrCommandFailed,
	)
}

// failedDetection wraps a failed detection command without leaking output.
func failedDetection(op string, outcome runResult) error {
	detail := "command failed"
	switch {
	case outcome.Err != nil:
		detail = outcome.Err.Error()
	case outcome.ExitCode >= 0:
		detail = fmt.Sprintf("exit status %d", outcome.ExitCode)
	}
	return fmt.Errorf("systemproxy: detect %s: %s: %w", op, detail, ErrDetectFailed)
}
