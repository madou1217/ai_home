//go:build !windows

package winshell

import (
	"context"
	"time"
)

// RunVBSReadText is a no-op stub on non-Windows platforms.
func RunVBSReadText(_ context.Context, _ string, _ time.Duration, _ ...string) (string, error) {
	return "", ErrUnsupported
}

// StartMenuProgramsRoots returns nil on non-Windows platforms.
func StartMenuProgramsRoots() []string {
	return nil
}

// ListShortcuts returns ErrUnsupported on non-Windows platforms.
func ListShortcuts(_ context.Context) ([]Shortcut, error) {
	return nil, ErrUnsupported
}
