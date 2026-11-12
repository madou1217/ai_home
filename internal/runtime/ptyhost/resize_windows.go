//go:build windows

package ptyhost

import (
	"context"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// startResizeWatcher 在 Windows 控制台没有 SIGWINCH，用低频尺寸变化探测；
// 只在尺寸真的变化时下发，避免无意义 resize。
func startResizeWatcher(
	ctx context.Context,
	sizeFn func() (pty.Size, bool),
	out chan<- pty.Size,
) func() {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		var last pty.Size
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-ticker.C:
				size, ok := sizeFn()
				if !ok || size == last {
					continue
				}
				last = size
				select {
				case out <- size:
				default:
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(done) })
	}
}
