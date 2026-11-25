//go:build !darwin && !windows && !linux

package clipboardio

import (
	"context"
	"runtime"
)

type unsupportedIO struct{}

func newSystemIO() IO {
	return &unsupportedIO{}
}

func (u *unsupportedIO) Probe() Capability {
	return Capability{
		Supported: false,
		Reason:    "clipboard IO unsupported on " + runtime.GOOS,
	}
}

func (u *unsupportedIO) ReadText(context.Context, int) (string, bool, error) {
	return "", false, ErrUnsupported
}

func (u *unsupportedIO) ReadFiles(context.Context) ([]string, bool, error) {
	return nil, false, ErrUnsupported
}

func (u *unsupportedIO) ReadImage(context.Context, int) ([]byte, string, bool, error) {
	return nil, "", false, ErrUnsupported
}

func (u *unsupportedIO) WriteText(context.Context, string) error {
	return ErrUnsupported
}

func (u *unsupportedIO) WriteImage(context.Context, []byte, string) error {
	return ErrUnsupported
}

func (u *unsupportedIO) WriteFiles(context.Context, []string) error {
	return ErrUnsupported
}
