package peer

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// DefaultWatchDebounce 是 peer 目录变更事件的防抖窗口。
const DefaultWatchDebounce = 120 * time.Millisecond

// WatchEvent 是 /peer/messages/watch 推送的单条 SSE 事件载荷。
type WatchEvent struct {
	Type string `json:"type"`
	At   int64  `json:"at,omitempty"`
}

// DirectoryWatcher 抽象文件系统监听器，便于测试注入假事件流。
type DirectoryWatcher interface {
	Add(path string) error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
	Close() error
}

type fsnotifyWatcher struct {
	inner *fsnotify.Watcher
}

func newFSNotifyWatcher() (DirectoryWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &fsnotifyWatcher{inner: watcher}, nil
}

func (w *fsnotifyWatcher) Add(path string) error         { return w.inner.Add(path) }
func (w *fsnotifyWatcher) Events() <-chan fsnotify.Event { return w.inner.Events }
func (w *fsnotifyWatcher) Errors() <-chan error          { return w.inner.Errors }
func (w *fsnotifyWatcher) Close() error                  { return w.inner.Close() }

// WatchOptions 控制目录监听参数。
type WatchOptions struct {
	Debounce   time.Duration
	Now        func() time.Time
	NewWatcher func() (DirectoryWatcher, error)
}

// ExistingDirectories 返回 <aiHomeDir>/run/peer 下当前存在的子目录。
func ExistingDirectories(aiHomeDir string) []string {
	root := filepath.Join(strings.TrimSpace(aiHomeDir), "run", "peer")
	names := []string{"pending", "inflight", "archive"}
	dirs := make([]string, 0, len(names))
	for _, name := range names {
		candidate := filepath.Join(root, name)
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			dirs = append(dirs, candidate)
		}
	}
	return dirs
}

// Watch 监听 peer 目录并返回事件流；目录均不存在时先推送 peer-unavailable。
func Watch(ctx context.Context, aiHomeDir string, options WatchOptions) (<-chan WatchEvent, error) {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return nil, ErrStoreUnavailable
	}
	debounce := options.Debounce
	if debounce <= 0 {
		debounce = DefaultWatchDebounce
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	newWatcher := options.NewWatcher
	if newWatcher == nil {
		newWatcher = newFSNotifyWatcher
	}

	events := make(chan WatchEvent, 16)
	dirs := ExistingDirectories(home)
	if len(dirs) == 0 {
		events <- WatchEvent{Type: "peer-unavailable"}
		go func() {
			<-ctx.Done()
			close(events)
		}()
		return events, nil
	}

	watcher, err := newWatcher()
	if err != nil {
		events <- WatchEvent{Type: "peer-unavailable"}
		go func() {
			<-ctx.Done()
			close(events)
		}()
		return events, nil
	}
	watched := 0
	for _, dir := range dirs {
		if addErr := watcher.Add(dir); addErr == nil {
			watched++
		}
	}
	if watched == 0 {
		_ = watcher.Close()
		events <- WatchEvent{Type: "peer-unavailable"}
		go func() {
			<-ctx.Done()
			close(events)
		}()
		return events, nil
	}

	events <- WatchEvent{Type: "ready", At: nowFn().UnixMilli()}
	go runWatchLoop(ctx, watcher, events, debounce, nowFn)
	return events, nil
}

func runWatchLoop(
	ctx context.Context,
	watcher DirectoryWatcher,
	events chan<- WatchEvent,
	debounce time.Duration,
	nowFn func() time.Time,
) {
	var closeOnce sync.Once
	defer closeOnce.Do(func() {
		_ = watcher.Close()
		close(events)
	})

	var timer *time.Timer
	var timerC <-chan time.Time
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
			timer = nil
			timerC = nil
		}
	}
	defer stopTimer()

	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-watcher.Events():
			if !ok {
				return
			}
			if timer == nil {
				timer = time.NewTimer(debounce)
				timerC = timer.C
			}
		case _, ok := <-watcher.Errors():
			if !ok {
				return
			}
		case <-timerC:
			timer = nil
			timerC = nil
			select {
			case events <- WatchEvent{Type: "peer-changed", At: nowFn().UnixMilli()}:
			case <-ctx.Done():
				return
			default:
			}
		}
	}
}
