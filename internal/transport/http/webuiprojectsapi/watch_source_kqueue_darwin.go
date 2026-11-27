//go:build darwin

package webuiprojectsapi

import (
	"path/filepath"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/internal/runtime/kqueuewatch"
)

// kqueueProjectWatchSource watches explicit paths without fsnotify's
// directory expansion. This matters on macOS: fsnotify opens an fd for every
// child of a watched directory and leaks those fds on Close, so a projects SSE
// reconnect could exhaust RLIMIT_NOFILE.
type kqueueProjectWatchSource struct {
	inner kqueuewatch.Watcher

	events chan projectWatchEvent

	mu    sync.Mutex
	kinds map[string]projectWatchKind

	closeOnce sync.Once
	done      chan struct{}
}

func newProjectWatchSource() (projectWatchSource, error) {
	inner, err := kqueuewatch.New()
	if err != nil {
		return nil, err
	}
	source := &kqueueProjectWatchSource{
		inner:  inner,
		events: make(chan projectWatchEvent, 1024),
		kinds:  make(map[string]projectWatchKind),
		done:   make(chan struct{}),
	}
	go source.loop()
	return source, nil
}

func (source *kqueueProjectWatchSource) loop() {
	defer close(source.done)
	defer close(source.events)
	for {
		select {
		case event, ok := <-source.inner.Events():
			if !ok {
				return
			}
			source.mu.Lock()
			kind, known := source.kinds[event.Path]
			source.mu.Unlock()
			if !known {
				continue
			}
			source.emit(projectWatchEvent{kind: kind, path: event.Path})
		case _, ok := <-source.inner.Errors():
			if !ok {
				return
			}
			// A watcher error means events may be missing: rebuild once and let
			// the hub re-synchronize its targets.
			source.emit(projectWatchEvent{kind: projectWatchKindProjects})
		}
	}
}

func (source *kqueueProjectWatchSource) Add(kind projectWatchKind, path string) error {
	clean := filepath.Clean(strings.TrimSpace(path))
	if clean == "" || clean == "." {
		return nil
	}
	source.mu.Lock()
	if _, exists := source.kinds[clean]; exists {
		source.mu.Unlock()
		return nil
	}
	source.kinds[clean] = kind
	source.mu.Unlock()
	if err := source.inner.Add(clean); err != nil {
		source.mu.Lock()
		delete(source.kinds, clean)
		source.mu.Unlock()
		return err
	}
	return nil
}

func (source *kqueueProjectWatchSource) Remove(path string) {
	clean := filepath.Clean(strings.TrimSpace(path))
	source.mu.Lock()
	delete(source.kinds, clean)
	source.mu.Unlock()
	_ = source.inner.Remove(clean)
}

func (source *kqueueProjectWatchSource) Events() <-chan projectWatchEvent {
	return source.events
}

func (source *kqueueProjectWatchSource) Close() error {
	source.closeOnce.Do(func() {
		_ = source.inner.Close()
	})
	<-source.done
	return nil
}

func (source *kqueueProjectWatchSource) emit(event projectWatchEvent) {
	select {
	case source.events <- event:
	default:
		// A rebuild is already pending; dropping a duplicate is safe.
	}
}
