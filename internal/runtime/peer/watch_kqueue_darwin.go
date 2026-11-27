//go:build darwin

package peer

import (
	"sync"

	"github.com/fsnotify/fsnotify"

	"github.com/madou1217/ai_home/internal/runtime/kqueuewatch"
)

// kqueueDirectoryWatcher adapts the directory-vnode watcher to the
// fsnotify-shaped port used by Watch. It deliberately does not expand
// directories: run/peer/pending can hold thousands of files, and fsnotify's
// kqueue backend would open (and leak) one fd per file on every reconnect.
type kqueueDirectoryWatcher struct {
	inner kqueuewatch.Watcher

	events chan fsnotify.Event
	errs   chan error

	closeOnce sync.Once
	done      chan struct{}
}

func newDirectoryWatcher() (DirectoryWatcher, error) {
	inner, err := kqueuewatch.New()
	if err != nil {
		return nil, err
	}
	watcher := &kqueueDirectoryWatcher{
		inner:  inner,
		events: make(chan fsnotify.Event, 64),
		errs:   make(chan error, 8),
		done:   make(chan struct{}),
	}
	go watcher.loop()
	return watcher, nil
}

func (w *kqueueDirectoryWatcher) loop() {
	defer close(w.done)
	defer close(w.events)
	defer close(w.errs)
	for {
		select {
		case event, ok := <-w.inner.Events():
			if !ok {
				return
			}
			op := fsnotify.Op(0)
			if event.Op.Has(kqueuewatch.Write) {
				op |= fsnotify.Write
			}
			if event.Op.Has(kqueuewatch.Create) {
				op |= fsnotify.Create
			}
			if event.Op.Has(kqueuewatch.Remove) {
				op |= fsnotify.Remove
			}
			if event.Op.Has(kqueuewatch.Rename) {
				op |= fsnotify.Rename
			}
			if event.Op.Has(kqueuewatch.Chmod) {
				op |= fsnotify.Chmod
			}
			select {
			case w.events <- fsnotify.Event{Name: event.Path, Op: op}:
			default:
			}
		case err, ok := <-w.inner.Errors():
			if !ok {
				return
			}
			select {
			case w.errs <- err:
			default:
			}
		}
	}
}

func (w *kqueueDirectoryWatcher) Add(path string) error { return w.inner.Add(path) }

func (w *kqueueDirectoryWatcher) Events() <-chan fsnotify.Event { return w.events }

func (w *kqueueDirectoryWatcher) Errors() <-chan error { return w.errs }

func (w *kqueueDirectoryWatcher) Close() error {
	w.closeOnce.Do(func() {
		_ = w.inner.Close()
	})
	<-w.done
	return nil
}
