// Package pty is the platform-neutral PTY boundary for interactive provider
// processes. Platform files own the actual terminal implementation.
package pty

import (
	"context"
	"io"
)

type Size struct {
	Rows uint16
	Cols uint16
}

type Spec struct {
	Path string
	Args []string
	Env  []string
	Dir  string
	Size Size
}

type Session interface {
	io.ReadWriteCloser
	Resize(Size) error
	Wait() error
}

type Starter interface {
	Start(context.Context, Spec) (Session, error)
}
