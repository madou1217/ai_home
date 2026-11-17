//go:build darwin

package sqliteaccount

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
	"golang.org/x/sys/unix"
)

// newModelSettingsFileWatch owns only the canonical directory and the two exact
// DB/WAL vnodes. fsnotify's Darwin directory backend otherwise opens every child.
// One loop reconciles descriptors and performs all final cleanup.
func newModelSettingsFileWatch(root string) (*modelSettingsFileWatch, error) {
	queue, err := unix.Kqueue()
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(queue)
	parent, err := unix.Open(root, unix.O_EVTONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = unix.Close(queue)
		return nil, err
	}
	var rootIdentity unix.Stat_t
	if err = unix.Fstat(parent, &rootIdentity); err != nil {
		_ = unix.Close(parent)
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
	type targetWatch struct {
		path     string
		fd       int
		identity unix.Stat_t
	}
	targets := []targetWatch{{path: filepath.Join(root, DatabaseFileName), fd: -1}, {path: filepath.Join(root, DatabaseFileName+"-wal"), fd: -1}}
	add := func(fd int, filter int16, flags uint32) error {
		_, err := unix.Kevent(queue, []unix.Kevent_t{{Ident: uint64(fd), Filter: filter, Flags: unix.EV_ADD | unix.EV_CLEAR, Fflags: flags}}, nil, nil)
		return err
	}
	cleanup := func() {
		for _, t := range targets {
			if t.fd >= 0 {
				_ = unix.Close(t.fd)
			}
		}
		_ = unix.Close(parent)
		_ = unix.Close(pipe[0])
		_ = unix.Close(queue)
	}
	sameRoot := func() bool {
		var current unix.Stat_t
		return unix.Lstat(root, &current) == nil && current.Mode&unix.S_IFMT == unix.S_IFDIR && current.Dev == rootIdentity.Dev && current.Ino == rootIdentity.Ino
	}
	reconcile := func() (bool, error) {
		if !sameRoot() {
			return false, errors.New("model_settings_watch_root_identity_changed")
		}
		changed := false
		for i := range targets {
			t := &targets[i]
			var current unix.Stat_t
			err := unix.Lstat(t.path, &current)
			exists := err == nil
			if err != nil && !errors.Is(err, unix.ENOENT) {
				return false, err
			}
			if exists && current.Mode&unix.S_IFMT != unix.S_IFREG {
				return false, errors.New("model_settings_watch_target_not_regular")
			}
			if t.fd >= 0 && exists && current.Dev == t.identity.Dev && current.Ino == t.identity.Ino {
				continue
			}
			changed = changed || t.fd >= 0 || exists
			if t.fd >= 0 {
				_ = unix.Close(t.fd)
				t.fd = -1
			}
			if !exists {
				continue
			}
			fd, err := unix.Open(t.path, unix.O_EVTONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if errors.Is(err, unix.ENOENT) {
				continue
			}
			if err != nil {
				return false, err
			}
			t.fd = fd
			if err := unix.Fstat(fd, &t.identity); err != nil {
				return false, err
			}
			if t.identity.Dev != current.Dev || t.identity.Ino != current.Ino {
				return false, errors.New("model_settings_watch_target_changed_during_open")
			}
			if err := add(fd, unix.EVFILT_VNODE, unix.NOTE_WRITE|unix.NOTE_EXTEND|unix.NOTE_RENAME|unix.NOTE_DELETE|unix.NOTE_ATTRIB|unix.NOTE_REVOKE); err != nil {
				return false, err
			}
		}
		return changed, nil
	}
	if err = add(pipe[0], unix.EVFILT_READ, 0); err == nil {
		err = add(parent, unix.EVFILT_VNODE, unix.NOTE_WRITE|unix.NOTE_RENAME|unix.NOTE_DELETE|unix.NOTE_REVOKE)
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
	failures := make(chan error, 1)
	done := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(done)
		defer close(events)
		defer close(failures)
		defer cleanup()
		var batch [8]unix.Kevent_t
		for {
			n, err := unix.Kevent(queue, nil, batch[:], nil)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			if err != nil {
				failures <- fmt.Errorf("model_settings_kqueue_read: %w", err)
				return
			}
			dirty, recheck := false, false
			for _, event := range batch[:n] {
				if int(event.Ident) == pipe[0] {
					return
				}
				if event.Flags&unix.EV_ERROR != 0 {
					failures <- fmt.Errorf("model_settings_kqueue_event: %d", event.Data)
					return
				}
				if int(event.Ident) == parent {
					if event.Fflags&(unix.NOTE_RENAME|unix.NOTE_DELETE|unix.NOTE_REVOKE) != 0 || !sameRoot() {
						failures <- errors.New("model_settings_watch_root_identity_changed")
						return
					}
					recheck = true
				}
				for _, target := range targets {
					if int(event.Ident) == target.fd {
						dirty = true
						if event.Fflags&(unix.NOTE_RENAME|unix.NOTE_DELETE|unix.NOTE_REVOKE) != 0 {
							recheck = true
						}
					}
				}
			}
			if recheck {
				changed, err := reconcile()
				if err != nil {
					failures <- err
					return
				}
				dirty = dirty || changed
			}
			if dirty {
				select {
				case events <- fsnotify.Event{Name: filepath.Join(root, DatabaseFileName), Op: fsnotify.Write}:
				default:
				}
			}
		}
	}()
	return &modelSettingsFileWatch{Events: events, Errors: failures, close: func() { once.Do(func() { _ = unix.Close(pipe[1]) }); <-done }}, nil
}
