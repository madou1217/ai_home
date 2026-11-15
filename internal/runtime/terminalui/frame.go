package terminalui

import (
	"fmt"
	"io"
	"strings"
)

// Frame tracks physical lines, including the ones in normal-screen scrollback.
// It deliberately does not enter an alternate screen or clear scrollback.
// The caller serializes Present and supplies freshly measured terminal size.
type Frame struct {
	lines []string
	cols  int
	rows  int
}

func (frame *Frame) Present(output io.Writer, lines []string, cols, rows int, force bool) error {
	if cols < 1 || rows < 1 {
		return fmt.Errorf("invalid terminal dimensions: %dx%d", cols, rows)
	}
	if rows == 1 {
		// No content plus cursor row fits. A visible resize marker is safer
		// than scrolling all business fields away or addressing absent rows.
		_, err := io.WriteString(output, "\r"+Reset+"\x1b[2K!\r")
		frame.lines = nil
		return err
	}
	full := force || frame.lines == nil || frame.cols != cols || frame.rows != rows
	var b strings.Builder
	if full {
		b.WriteString("\x1b[H" + Reset + "\x1b[J")
		for _, line := range lines {
			// MakeRaw disables ONLCR. LF alone keeps the old column and makes
			// the next logical line form a staircase, then wrap unpredictably.
			b.WriteString(line)
			b.WriteString(Reset + "\r\n")
		}
	} else {
		// Each explicitly terminated line leaves one blank cursor row. A
		// rotating value can add/remove wraps: repaint the visible window,
		// rather than pushing a duplicate full snapshot into scrollback.
		offscreen := max(0, len(lines)-(rows-1))
		layoutChanged := len(frame.lines) != len(lines)
		if layoutChanged {
			// Some terminals push ED-cleared content into scrollback. EL on
			// each physical row guarantees an in-place ordinary refresh.
			for row := 1; row <= rows; row++ {
				fmt.Fprintf(&b, "\x1b[%d;1H%s\x1b[2K", row, Reset)
			}
		}
		for index := offscreen; index < len(lines); index++ {
			if layoutChanged || lines[index] != frame.lines[index] {
				fmt.Fprintf(&b, "\x1b[%d;1H%s\x1b[2K%s%s", index-offscreen+1, Reset, lines[index], Reset)
			}
		}
		if b.Len() > 0 {
			fmt.Fprintf(&b, "\x1b[%d;1H", min(rows, len(lines)-offscreen+1))
		}
	}
	if b.Len() > 0 {
		if _, err := io.WriteString(output, "\x1b[?2026h"+b.String()+"\x1b[?2026l"); err != nil {
			// A partial write may have enabled synchronized updates without
			// reaching their terminator. Preserve the original I/O error.
			_, _ = io.WriteString(output, "\x1b[?2026l")
			return err
		}
	}
	frame.lines = append(frame.lines[:0], lines...)
	frame.cols, frame.rows = cols, rows
	return nil
}
