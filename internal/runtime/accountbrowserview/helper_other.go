//go:build !darwin && !windows

package accountbrowserview

import (
	"context"
	"strconv"
)

func platformSupported() bool                             { return false }
func buildHelper(context.Context) (string, func(), error) { return "", nil, ErrUnsupported }
func preflight(context.Context, string) error             { return ErrUnsupported }

func nativeArgs(pid int, _ uint64) []string { return []string{strconv.Itoa(pid)} }
