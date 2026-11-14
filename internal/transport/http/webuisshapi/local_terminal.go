package webuisshapi

import (
	"os"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// LocalTerminalSize 返回当前进程 stdin 的终端尺寸。
func LocalTerminalSize() (pty.Size, bool) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return pty.Size{}, false
	}
	cols, rows, err := term.GetSize(int(os.Stdin.Fd()))
	if err != nil || cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 {
		return pty.Size{}, false
	}
	return pty.Size{Cols: uint16(cols), Rows: uint16(rows)}, true
}
