//go:build !windows

package webuisshapi

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// WatchLocalTerminalResize 在 SIGWINCH 时回调最新尺寸。
func WatchLocalTerminalResize(ctx context.Context, onChange func(pty.Size)) {
	if onChange == nil {
		return
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGWINCH)
	defer signal.Stop(signals)
	for {
		select {
		case <-ctx.Done():
			return
		case <-signals:
			if size, ok := LocalTerminalSize(); ok {
				onChange(size)
			}
		}
	}
}
