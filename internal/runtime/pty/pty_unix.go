//go:build !windows

package pty

import (
	"context"
	"errors"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

var ErrInvalidSpec = errors.New("pty spec invalid")

type unixStarter struct{}

type unixSession struct {
	terminal *os.File
	process  *exec.Cmd
}

func Available() bool     { return true }
func NewStarter() Starter { return unixStarter{} }

func (unixStarter) Start(ctx context.Context, spec Spec) (Session, error) {
	if ctx == nil || spec.Path == "" || spec.Size.Rows == 0 || spec.Size.Cols == 0 {
		return nil, ErrInvalidSpec
	}
	command := exec.CommandContext(ctx, spec.Path, spec.Args...)
	command.Env = append([]string(nil), spec.Env...)
	if spec.Dir != "" {
		command.Dir = spec.Dir
	}
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Rows: spec.Size.Rows, Cols: spec.Size.Cols})
	if err != nil {
		return nil, err
	}
	return &unixSession{terminal: terminal, process: command}, nil
}

func (session *unixSession) Read(payload []byte) (int, error) { return session.terminal.Read(payload) }
func (session *unixSession) Write(payload []byte) (int, error) {
	return session.terminal.Write(payload)
}
func (session *unixSession) Close() error {
	if session == nil || session.terminal == nil {
		return nil
	}
	return session.terminal.Close()
}
func (session *unixSession) Resize(size Size) error {
	if session == nil || session.terminal == nil || size.Rows == 0 || size.Cols == 0 {
		return ErrInvalidSpec
	}
	return pty.Setsize(session.terminal, &pty.Winsize{Rows: size.Rows, Cols: size.Cols})
}
func (session *unixSession) Wait() error {
	if session == nil || session.process == nil {
		return ErrInvalidSpec
	}
	return session.process.Wait()
}
