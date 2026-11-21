//go:build !darwin && !windows

package accountbrowserview

import "context"

func platformSupported() bool                             { return false }
func buildHelper(context.Context) (string, func(), error) { return "", nil, ErrUnsupported }
func preflight(context.Context, string) error             { return ErrUnsupported }
