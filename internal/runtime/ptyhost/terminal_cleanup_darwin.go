//go:build darwin

package ptyhost

import (
	"io"
	"os"
	"time"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

const (
	terminalFlushRead        = 0x00000001
	terminalFlushWrite       = 0x00000002
	terminalCleanupSequence  = "\x1b[?2026l\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?2004l\x1b[?2006l\x1b[?2031l\x1b[?2048l\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?6l\x1b[?1l\x1b[>4l\x1b[0m"
	terminalReplyDrainWindow = 150 * time.Millisecond
	terminalReplyDrainTick   = 20 * time.Millisecond
)

// cleanupTerminal restores terminal modes owned by a foreground TUI. The
// provider is connected to a separate PTY, so these bytes must go to the
// caller's terminal, not to the child session.
func cleanupTerminal(input io.Reader, output io.Writer) {
	inputFile, inputOK := terminalFile(input)
	if inputOK {
		// macOS TIOCFLUSH takes the FREAD/FWRITE bit mask. Drop bytes already
		// queued by the dead TUI before the shell receives the terminal back.
		flushTerminal(inputFile, terminalFlushRead|terminalFlushWrite)
	}
	outputFile, outputOK := terminalFile(output)
	if !outputOK || !term.IsTerminal(int(outputFile.Fd())) {
		return
	}
	_, _ = io.WriteString(output, terminalCleanupSequence)
	if inputOK && inputFile.Fd() == outputFile.Fd() {
		// DA/DECRQM replies are asynchronous: a terminal emulator can place a
		// response in the tty input queue just after the child has exited. Keep
		// the hand-off window short, but flush repeatedly so the shell never
		// interprets a late CSI reply as user input.
		drainLateTerminalReplies(inputFile)
	}
}

func flushTerminal(file *os.File, direction int) {
	if file == nil {
		return
	}
	_ = unix.IoctlSetPointerInt(int(file.Fd()), unix.TIOCFLUSH, direction)
}

func drainLateTerminalReplies(file *os.File) {
	if file == nil {
		return
	}
	deadline := time.Now().Add(terminalReplyDrainWindow)
	for time.Now().Before(deadline) {
		flushTerminal(file, terminalFlushRead)
		time.Sleep(terminalReplyDrainTick)
	}
	flushTerminal(file, terminalFlushRead)
}

func terminalFile(value any) (*os.File, bool) {
	file, ok := value.(*os.File)
	return file, ok && file != nil
}
