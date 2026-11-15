//go:build !darwin

package sessionevents

import (
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
)

func newSessionFileWatcher(target string) (*sessionFileWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err = watcher.Add(filepath.Dir(target)); err != nil {
		_ = watcher.Close()
		return nil, err
	}
	_ = watcher.Add(target)
	var once sync.Once
	return &sessionFileWatcher{
		Events: watcher.Events, Errors: watcher.Errors,
		rewatch: func() { _ = watcher.Add(target) },
		close: func() {
			once.Do(func() {
				for _, watched := range watcher.WatchList() {
					_ = watcher.Remove(watched)
				}
				_ = watcher.Close()
			})
		},
	}, nil
}
