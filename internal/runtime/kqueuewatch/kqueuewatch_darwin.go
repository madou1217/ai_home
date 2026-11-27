//go:build darwin

package kqueuewatch

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

type watcher struct {
	queue int
	pipe  [2]int

	events chan Event
	errs   chan error

	mu     sync.Mutex
	paths  map[int]string
	fds    map[string]int
	closed bool

	closeOnce sync.Once
	done      chan struct{}
}

// New creates a kqueue watcher with one queue and one control pipe.
func New() (Watcher, error) {
	queue, err := unix.Kqueue()
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(queue)
	pipe := [2]int{}
	if err := unix.Pipe(pipe[:]); err != nil {
		_ = unix.Close(queue)
		return nil, err
	}
	unix.CloseOnExec(pipe[0])
	unix.CloseOnExec(pipe[1])
	change := unix.Kevent_t{Ident: uint64(pipe[0]), Filter: unix.EVFILT_READ, Flags: unix.EV_ADD}
	if _, err := unix.Kevent(queue, []unix.Kevent_t{change}, nil, nil); err != nil {
		_ = unix.Close(pipe[0])
		_ = unix.Close(pipe[1])
		_ = unix.Close(queue)
		return nil, err
	}
	source := &watcher{
		queue:  queue,
		pipe:   pipe,
		events: make(chan Event, 256),
		errs:   make(chan error, 8),
		paths:  make(map[int]string),
		fds:    make(map[string]int),
		done:   make(chan struct{}),
	}
	go source.loop()
	return source, nil
}

func (w *watcher) Add(path string) error {
	clean := filepath.Clean(strings.TrimSpace(path))
	if clean == "" || clean == "." {
		return nil
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return unix.EBADF
	}
	if _, exists := w.fds[clean]; exists {
		w.mu.Unlock()
		return nil
	}
	w.mu.Unlock()

	fd, err := unix.Open(clean, unix.O_EVTONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		_ = unix.Close(fd)
		return err
	}
	flags := uint32(unix.NOTE_WRITE | unix.NOTE_ATTRIB | unix.NOTE_RENAME | unix.NOTE_DELETE)
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		flags |= unix.NOTE_EXTEND
	}

	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		_ = unix.Close(fd)
		return unix.EBADF
	}
	if _, exists := w.fds[clean]; exists {
		w.mu.Unlock()
		_ = unix.Close(fd)
		return nil
	}
	w.paths[fd] = clean
	w.fds[clean] = fd
	w.mu.Unlock()

	change := unix.Kevent_t{Ident: uint64(fd), Filter: unix.EVFILT_VNODE, Flags: unix.EV_ADD | unix.EV_CLEAR, Fflags: flags}
	if _, err := unix.Kevent(w.queue, []unix.Kevent_t{change}, nil, nil); err != nil {
		w.mu.Lock()
		delete(w.paths, fd)
		delete(w.fds, clean)
		w.mu.Unlock()
		_ = unix.Close(fd)
		return err
	}
	return nil
}

func (w *watcher) Remove(path string) error {
	clean := filepath.Clean(strings.TrimSpace(path))
	if clean == "" || clean == "." {
		return nil
	}
	w.mu.Lock()
	fd, exists := w.fds[clean]
	if exists {
		delete(w.fds, clean)
		delete(w.paths, fd)
	}
	w.mu.Unlock()
	if !exists {
		return nil
	}
	change := unix.Kevent_t{Ident: uint64(fd), Filter: unix.EVFILT_VNODE, Flags: unix.EV_DELETE}
	_, _ = unix.Kevent(w.queue, []unix.Kevent_t{change}, nil, nil)
	_ = unix.Close(fd)
	return nil
}

func (w *watcher) Events() <-chan Event { return w.events }

func (w *watcher) Errors() <-chan error { return w.errs }

func (w *watcher) Close() error {
	w.closeOnce.Do(func() { _ = unix.Close(w.pipe[1]) })
	<-w.done
	return nil
}

func (w *watcher) loop() {
	defer close(w.done)
	defer close(w.events)
	defer close(w.errs)
	defer w.shutdown()

	batch := make([]unix.Kevent_t, 64)
	for {
		count, err := unix.Kevent(w.queue, nil, batch, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			w.emitError(err)
			return
		}
		for index := 0; index < count; index++ {
			event := batch[index]
			if int(event.Ident) == w.pipe[0] {
				return
			}
			fd := int(event.Ident)
			w.mu.Lock()
			path, exists := w.paths[fd]
			w.mu.Unlock()
			if !exists {
				continue
			}
			op := Op(0)
			if event.Fflags&(unix.NOTE_WRITE|unix.NOTE_EXTEND) != 0 {
				op |= Write
			}
			if event.Fflags&unix.NOTE_ATTRIB != 0 {
				op |= Chmod
			}
			if event.Fflags&unix.NOTE_DELETE != 0 {
				op |= Remove
			}
			if event.Fflags&unix.NOTE_RENAME != 0 {
				op |= Rename
			}
			if op == 0 {
				continue
			}
			w.emit(Event{Path: path, Op: op})
			if event.Fflags&(unix.NOTE_DELETE|unix.NOTE_RENAME) != 0 {
				w.rearm(fd, path)
			}
		}
	}
}

// rearm drops the watch for a deleted/renamed vnode and re-opens the path when
// it still exists (SQLite WAL and session files are often atomically replaced).
func (w *watcher) rearm(fd int, path string) {
	w.mu.Lock()
	if w.paths[fd] == path {
		delete(w.paths, fd)
		delete(w.fds, path)
	}
	w.mu.Unlock()
	_ = unix.Close(fd)
	if _, err := os.Stat(path); err == nil {
		_ = w.Add(path)
	}
}

func (w *watcher) emit(event Event) {
	select {
	case w.events <- event:
	default:
		// A pending change is already queued; the consumer re-reads state.
	}
}

func (w *watcher) emitError(err error) {
	select {
	case w.errs <- err:
	default:
	}
}

func (w *watcher) shutdown() {
	w.mu.Lock()
	w.closed = true
	fds := make([]int, 0, len(w.paths))
	for fd := range w.paths {
		fds = append(fds, fd)
	}
	w.paths = make(map[int]string)
	w.fds = make(map[string]int)
	w.mu.Unlock()
	for _, fd := range fds {
		_ = unix.Close(fd)
	}
	_ = unix.Close(w.queue)
	_ = unix.Close(w.pipe[0])
}
