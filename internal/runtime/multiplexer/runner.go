package multiplexer

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
)

var ErrCommandFailed = errors.New("multiplexer command failed")

type Result struct {
	Stdout string
	Stderr string
	Status int
}

type RunFunc func(context.Context, string, ...string) (Result, error)

type Runner struct {
	run RunFunc
}

func NewRunner(run RunFunc) *Runner {
	if run == nil {
		run = runCommand
	}
	return &Runner{run: run}
}

type Session struct {
	Name     string
	Attached bool
	Created  int64
	Path     string
}

func (runner *Runner) List(ctx context.Context, options ListOptions) ([]Session, error) {
	if runner == nil || ctx == nil || strings.TrimSpace(options.Socket) == "" {
		return nil, ErrInvalidSession
	}
	invocation := NewTmuxDriver().List(options)
	result, err := runner.run(ctx, invocation.Command, invocation.Args...)
	if err != nil {
		return nil, err
	}
	if result.Status != 0 {
		return nil, ErrCommandFailed
	}
	return parseSessions(result.Stdout), nil
}

func (runner *Runner) Execute(ctx context.Context, invocation Invocation) error {
	if runner == nil || ctx == nil || strings.TrimSpace(invocation.Command) == "" || len(invocation.Args) == 0 {
		return ErrInvalidSession
	}
	result, err := runner.run(ctx, invocation.Command, invocation.Args...)
	if err != nil {
		return err
	}
	if result.Status != 0 {
		return ErrCommandFailed
	}
	return nil
}

func parseSessions(stdout string) []Session {
	result := make([]Session, 0)
	for _, line := range strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 4 || strings.TrimSpace(parts[0]) == "" {
			continue
		}
		created, _ := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
		result = append(result, Session{
			Name:     strings.TrimSpace(parts[0]),
			Attached: strings.TrimSpace(parts[1]) != "0",
			Created:  created,
			Path:     strings.TrimSpace(parts[3]),
		})
	}
	return result
}

func runCommand(ctx context.Context, command string, args ...string) (Result, error) {
	process := exec.CommandContext(ctx, command, args...)
	output, err := process.Output()
	result := Result{Stdout: string(output)}
	if err == nil {
		result.Status = 0
		return result, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.Status = exitError.ExitCode()
		result.Stderr = string(exitError.Stderr)
		return result, nil
	}
	return result, err
}
