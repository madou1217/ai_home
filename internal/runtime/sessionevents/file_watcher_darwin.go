//go:build darwin

package sessionevents

import (
	"errors"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
	"golang.org/x/sys/unix"
)

// The pinned fsnotify kqueue adapter expands a directory into every child and
// can re-add descriptors concurrently with Close. Own just the directory and
// target vnode here; a single loop performs reconciliation and final cleanup.
func newSessionFileWatcher(target string) (*sessionFileWatcher, error) {
	queue, err := unix.Kqueue()
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(queue)
	parent, err := unix.Open(filepath.Dir(target), unix.O_EVTONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = unix.Close(queue)
		return nil, err
	}
	pipe := make([]int, 2)
	if err = unix.Pipe(pipe); err != nil {
		_ = unix.Close(parent)
		_ = unix.Close(queue)
		return nil, err
	}
	unix.CloseOnExec(pipe[0])
	unix.CloseOnExec(pipe[1])
	add := func(fd int, filter int16, flags uint32) error {
		_, err := unix.Kevent(queue, []unix.Kevent_t{{Ident: uint64(fd), Filter: filter,
			Flags: unix.EV_ADD | unix.EV_CLEAR, Fflags: flags}}, nil, nil)
		return err
	}
	file := -1
	var identity unix.Stat_t
	reconcile := func() (bool, error) {
		var current unix.Stat_t
		err := unix.Stat(target, &current)
		exists := err == nil && current.Mode&unix.S_IFMT == unix.S_IFREG
		if err != nil && !errors.Is(err, unix.ENOENT) && !errors.Is(err, unix.ENOTDIR) {
			return false, err
		}
		if file >= 0 && exists && current.Dev == identity.Dev && current.Ino == identity.Ino {
			return false, nil
		}
		changed := file >= 0 || exists
		if file >= 0 {
			_ = unix.Close(file)
			file = -1
		}
		if !exists {
			return changed, nil
		}
		file, err = unix.Open(target, unix.O_EVTONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			file = -1
			if errors.Is(err, unix.ENOENT) {
				return changed, nil
			}
			return changed, err
		}
		if err = unix.Fstat(file, &identity); err != nil {
			_ = unix.Close(file)
			file = -1
			return changed, err
		}
		return changed, add(file, unix.EVFILT_VNODE, unix.NOTE_WRITE|unix.NOTE_EXTEND|unix.NOTE_RENAME|unix.NOTE_DELETE|unix.NOTE_ATTRIB)
	}
	cleanup := func() {
		if file >= 0 {
			_ = unix.Close(file)
		}
		_ = unix.Close(parent)
		_ = unix.Close(pipe[0])
		_ = unix.Close(queue)
	}
	if err = add(pipe[0], unix.EVFILT_READ, 0); err == nil {
		err = add(parent, unix.EVFILT_VNODE, unix.NOTE_WRITE|unix.NOTE_RENAME|unix.NOTE_DELETE)
	}
	if err == nil {
		_, err = reconcile()
	}
	if err != nil {
		cleanup()
		_ = unix.Close(pipe[1])
		return nil, err
	}
	events := make(chan fsnotify.Event, 1)
	errorsCh := make(chan error, 1)
	done := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(done)
		defer close(events)
		defer close(errorsCh)
		defer cleanup()
		var batch [8]unix.Kevent_t
		for {
			n, readErr := unix.Kevent(queue, nil, batch[:], nil)
			if errors.Is(readErr, unix.EINTR) {
				continue
			}
			if readErr != nil {
				errorsCh <- readErr
				return
			}
			dirty, reconcileTarget := false, false
			for _, event := range batch[:n] {
				if int(event.Ident) == pipe[0] {
					return
				}
				if int(event.Ident) == file && event.Fflags&(unix.NOTE_WRITE|unix.NOTE_EXTEND|unix.NOTE_RENAME|unix.NOTE_DELETE) != 0 {
					dirty = true
				}
				if int(event.Ident) == parent || event.Fflags&(unix.NOTE_RENAME|unix.NOTE_DELETE) != 0 {
					reconcileTarget = true
				}
			}
			if reconcileTarget {
				changed, reconcileErr := reconcile()
				if reconcileErr != nil {
					errorsCh <- reconcileErr
					return
				}
				dirty = dirty || changed
			}
			if dirty {
				select {
				case events <- fsnotify.Event{Name: target, Op: fsnotify.Write}:
				default: // a file invalidation is already pending
				}
			}
		}
	}()
	return &sessionFileWatcher{Events: events, Errors: errorsCh, close: func() {
		once.Do(func() { _ = unix.Close(pipe[1]) })
		<-done
	}}, nil
}
