//go:build !darwin

package ptyhost

import "io"

// cleanupTerminal is intentionally a no-op on platforms whose terminal ioctl
// contract is not shared with macOS. The termios restore in host.go remains the
// portable cleanup path.
func cleanupTerminal(_ io.Reader, _ io.Writer) {}
