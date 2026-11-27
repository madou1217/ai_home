//go:build !darwin

package peer

import "github.com/fsnotify/fsnotify"

type fsnotifyWatcher struct {
	inner *fsnotify.Watcher
}

func newDirectoryWatcher() (DirectoryWatcher, error) {
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
