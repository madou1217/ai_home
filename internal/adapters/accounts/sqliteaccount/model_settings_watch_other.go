//go:build !darwin

package sqliteaccount

import "github.com/fsnotify/fsnotify"

func newModelSettingsFileWatch(root string) (*modelSettingsFileWatch, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := watcher.Add(root); err != nil {
		_ = watcher.Close()
		return nil, err
	}
	return &modelSettingsFileWatch{Events: watcher.Events, Errors: watcher.Errors, close: func() { _ = watcher.Close() }}, nil
}
