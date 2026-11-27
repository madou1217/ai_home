//go:build !darwin && !linux && !windows

package appsessions

import (
	"context"
	"errors"
)

func listProcesses(_ context.Context) ([]Process, error) {
	return nil, errors.New("process enumeration unsupported")
}

func terminateProcesses(_ context.Context, _ []int) ([]int, error) {
	return nil, errors.New("process termination unsupported")
}
