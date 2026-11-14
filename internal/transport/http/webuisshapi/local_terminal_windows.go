//go:build windows

package webuisshapi

import (
	"context"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// WatchLocalTerminalResize 在 Windows 上没有 SIGWINCH；尺寸在启动时取一次。
func WatchLocalTerminalResize(context.Context, func(pty.Size)) {}
