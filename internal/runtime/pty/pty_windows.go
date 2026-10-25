//go:build windows

package pty

import (
	"context"
	"errors"

	gopty "github.com/aymanbagabas/go-pty"
)

var ErrUnsupportedPlatform = errors.New("ConPTY adapter not installed")

type conPtyStarter struct{}

type conPtySession struct {
	terminal gopty.Pty
	command  *gopty.Cmd
}

func Available() bool     { return true }
func NewStarter() Starter { return conPtyStarter{} }

func (conPtyStarter) Start(ctx context.Context, spec Spec) (Session, error) {
	if ctx == nil || spec.Path == "" || spec.Size.Rows == 0 || spec.Size.Cols == 0 {
		return nil, ErrUnsupportedPlatform
	}
	terminal, err := gopty.New()
	if err != nil {
		return nil, err
	}
	if err := terminal.Resize(int(spec.Size.Cols), int(spec.Size.Rows)); err != nil {
		_ = terminal.Close()
		return nil, err
	}
	command := terminal.CommandContext(ctx, spec.Path, spec.Args...)
	command.Env = append([]string(nil), spec.Env...)
	command.Dir = spec.Dir
	if err := command.Start(); err != nil {
		_ = terminal.Close()
		return nil, err
	}
	return &conPtySession{terminal: terminal, command: command}, nil
}

func (session *conPtySession) Read(payload []byte) (int, error) {
	return session.terminal.Read(payload)
}
func (session *conPtySession) Write(payload []byte) (int, error) {
	return session.terminal.Write(payload)
}
func (session *conPtySession) Close() error {
	if session == nil || session.terminal == nil {
		return nil
	}
	return session.terminal.Close()
}
func (session *conPtySession) Resize(size Size) error {
	if session == nil || session.terminal == nil || size.Rows == 0 || size.Cols == 0 {
		return ErrUnsupportedPlatform
	}
	return session.terminal.Resize(int(size.Cols), int(size.Rows))
}
func (session *conPtySession) Wait() error {
	if session == nil || session.command == nil {
		return ErrUnsupportedPlatform
	}
	return session.command.Wait()
}
