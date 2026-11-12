//go:build !windows

package ptyhost

import (
	"context"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// startResizeWatcher 用 SIGWINCH 监听当前终端尺寸；stop 可重复调用。
func startResizeWatcher(
	ctx context.Context,
	sizeFn func() (pty.Size, bool),
	out chan<- pty.Size,
) func() {
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGWINCH)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-signals:
				if size, ok := sizeFn(); ok {
					select {
					case out <- size:
					default:
					}
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			signal.Stop(signals)
			close(done)
		})
	}
}
