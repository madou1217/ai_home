package sessionevents

import "github.com/fsnotify/fsnotify"

// A watcher owns its native descriptors and delivers bounded invalidations for
// one transcript. The bus owns subscription/debounce policy, not OS handles.
type sessionFileWatcher struct {
	Events  <-chan fsnotify.Event
	Errors  <-chan error
	close   func()
	rewatch func()
}

func (watcher *sessionFileWatcher) Close() {
	if watcher != nil && watcher.close != nil {
		watcher.close()
	}
}

func (watcher *sessionFileWatcher) Rewatch() {
	if watcher != nil && watcher.rewatch != nil {
		watcher.rewatch()
	}
}
