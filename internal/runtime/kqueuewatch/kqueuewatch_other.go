//go:build !darwin

package kqueuewatch

import "errors"

// New is only implemented on macOS. Other platforms use fsnotify directly.
func New() (Watcher, error) {
	return nil, errors.New("kqueuewatch: darwin only")
}
