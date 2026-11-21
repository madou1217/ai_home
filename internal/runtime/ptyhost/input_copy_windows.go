//go:build windows

package ptyhost

import "io"

func inputPumpCanStop(io.Reader) bool { return false }

// Windows does not expose the Unix fd poll contract used by the terminal host.
// Keep the generic stream path for non-Unix callers.
func copyInputUntilStopped(destination io.Writer, source io.Reader, _ <-chan struct{}) {
	_, _ = io.Copy(destination, source)
}
