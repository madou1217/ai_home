package persistent

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/internal/runtime/multiplexer"
)

var ErrInvalidManager = errors.New("persistent session manager invalid")

type SessionSpec struct {
	Provider    string
	AccountRef  string
	Socket      string
	Session     string
	CWD         string
	Label       string
	Inner       multiplexer.Command
	ForwardArgs []string
}

type invocationRunner interface {
	Execute(context.Context, multiplexer.Invocation) error
}

type Manager struct {
	registry *Registry
	driver   *multiplexer.TmuxDriver
	runner   invocationRunner
}

func NewManager(registry *Registry, driver *multiplexer.TmuxDriver, runner invocationRunner) *Manager {
	return &Manager{registry: registry, driver: driver, runner: runner}
}

func (manager *Manager) Create(ctx context.Context, spec SessionSpec) error {
	if err := manager.validate(ctx, spec); err != nil {
		return err
	}
	if err := manager.runner.Execute(ctx, manager.driver.BuildLaunch(multiplexer.LaunchOptions{
		Command: "tmux", Socket: spec.Socket, Session: spec.Session, CWD: spec.CWD, Inner: spec.Inner,
	})); err != nil {
		return err
	}
	return manager.registry.Write(ctx, Entry{
		Provider: spec.Provider, RuntimeScope: spec.AccountRef, AccountRef: spec.AccountRef,
		Socket: spec.Socket, Session: spec.Session, CWD: spec.CWD, Label: spec.Label, ForwardArgs: append([]string(nil), spec.ForwardArgs...),
	})
}

func (manager *Manager) Attach(ctx context.Context, spec SessionSpec, share bool) error {
	if err := manager.validate(ctx, spec); err != nil {
		return err
	}
	return manager.runner.Execute(ctx, manager.driver.BuildAttach(multiplexer.LaunchOptions{Command: "tmux", Socket: spec.Socket, Session: spec.Session}, share))
}

func (manager *Manager) Restore(ctx context.Context, spec SessionSpec) error {
	if err := manager.validate(ctx, spec); err != nil {
		return err
	}
	return manager.runner.Execute(ctx, manager.driver.BuildLaunch(multiplexer.LaunchOptions{
		Command: "tmux", Socket: spec.Socket, Session: spec.Session, CWD: spec.CWD, Inner: spec.Inner, Detached: true,
	}))
}

func (manager *Manager) Kill(ctx context.Context, spec SessionSpec) error {
	if err := manager.validate(ctx, spec); err != nil {
		return err
	}
	invocation, err := manager.driver.Kill(multiplexer.KillOptions{Command: "tmux", Socket: spec.Socket, Session: spec.Session})
	if err != nil {
		return err
	}
	if err := manager.runner.Execute(ctx, invocation); err != nil {
		return err
	}
	return manager.registry.Remove(ctx, spec.Socket, spec.Session)
}

func (manager *Manager) validate(ctx context.Context, spec SessionSpec) error {
	if manager == nil || manager.registry == nil || manager.driver == nil || manager.runner == nil || ctx == nil || ctx.Err() != nil ||
		spec.Provider == "" || spec.AccountRef == "" || spec.Socket == "" || spec.Session == "" || spec.Inner.Path == "" {
		return ErrInvalidManager
	}
	return nil
}
