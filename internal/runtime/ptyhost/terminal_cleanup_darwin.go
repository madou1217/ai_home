//go:build darwin

package ptyhost

import (
	"io"
	"os"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

const (
	terminalFlushRead       = 0x00000001
	terminalFlushWrite      = 0x00000002
	terminalCleanupSequence = "\x1b[?2026l\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?2004l\x1b[?2006l\x1b[?2031l\x1b[?2048l\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?6l\x1b[?1l\x1b[>4l\x1b[0m"
)

// cleanupTerminal restores terminal modes owned by a foreground TUI. The
// provider is connected to a separate PTY, so these bytes must go to the
// caller's terminal, not to the child session.
func cleanupTerminal(input io.Reader, output io.Writer) {
	if file, ok := terminalFile(input); ok {
		// macOS TIOCFLUSH takes the FREAD/FWRITE bit mask. Drop bytes already
		// queued by the dead TUI before the shell receives the terminal back.
		_ = unix.IoctlSetInt(int(file.Fd()), unix.TIOCFLUSH, terminalFlushRead|terminalFlushWrite)
	}
	file, ok := terminalFile(output)
	if !ok || !term.IsTerminal(int(file.Fd())) {
		return
	}
	_, _ = io.WriteString(output, terminalCleanupSequence)
}

func terminalFile(value any) (*os.File, bool) {
	file, ok := value.(*os.File)
	return file, ok && file != nil
}
