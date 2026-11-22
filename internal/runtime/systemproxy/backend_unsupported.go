//go:build !darwin && !windows && !linux

package systemproxy

import (
	"context"
	"runtime"
)

type unsupportedBackend struct{}

func currentBackend() backend {
	return unsupportedBackend{}
}

func (unsupportedBackend) scope() string {
	return ""
}

func unsupportedResult() Result {
	return Result{Platform: runtime.GOOS}
}

func (unsupportedBackend) capture(context.Context, runner) (Snapshot, error) {
	return Snapshot{}, ErrUnsupportedPlatform
}

func (unsupportedBackend) listServices(context.Context, runner) ([]Service, error) {
	return nil, ErrUnsupportedPlatform
}

func (unsupportedBackend) apply(context.Context, runner, ApplyOptions) (Result, error) {
	return unsupportedResult(), ErrUnsupportedPlatform
}

func (unsupportedBackend) restore(context.Context, runner, Snapshot, RestoreOptions) (Result, error) {
	return unsupportedResult(), ErrUnsupportedPlatform
}
