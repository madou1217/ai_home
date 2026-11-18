// Package accountwriterlease excludes offline account writes from daemon startup
// and lifetime. OS locks release on process exit; the lock inode is never removed.
package accountwriterlease

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
)

var ErrBusy = errors.New("backup_core_writer_busy")

// A guard borrows this original held FD; it never acquires another OS lock.
// Close seals new calls and waits the same mutex as active Do, not the lifetime
// of idle borrowed references (which would deadlock Session.Close ordering).
type Lease struct {
	mu       sync.Mutex
	file     *os.File
	root     string
	path     string
	closed   bool
	closeErr error
}

type Guard struct {
	lease  *Lease
	closed bool // protected by lease.mu
}

func (l *Lease) Borrow(root string) (*Guard, error) {
	if l == nil {
		return nil, errors.New("account_writer_lease_required")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if root != l.root {
		return nil, errors.New("account_writer_root_mismatch")
	}
	if err := l.checkLocked(); err != nil {
		return nil, err
	}
	return &Guard{lease: l}, nil
}

func (l *Lease) checkLocked() error {
	if l.closed || l.file == nil {
		return errors.New("account_writer_lease_closed")
	}
	opened, err := l.file.Stat()
	if err != nil {
		return err
	}
	current, err := os.Lstat(l.path)
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !opened.Mode().IsRegular() || !os.SameFile(current, opened) {
		return errors.New("account_writer_lock_changed")
	}
	return nil
}

// Do holds the original lease mutex throughout the critical section. The
// callback must not synchronously call Guard/Lease/Database/Session.Close or
// re-enter another Do; lifecycle joins are outside the operations they wait.
func (g *Guard) Do(fn func() error) error {
	if g == nil || g.lease == nil || fn == nil {
		return errors.New("account_writer_guard_required")
	}
	l := g.lease
	l.mu.Lock()
	defer l.mu.Unlock()
	if g.closed {
		return errors.New("account_writer_guard_closed")
	}
	if err := l.checkLocked(); err != nil {
		return err
	}
	return fn()
}
func (g *Guard) Close() error {
	if g == nil || g.lease == nil {
		return nil
	}
	g.lease.mu.Lock()
	defer g.lease.mu.Unlock()
	g.closed = true
	return nil
}

func Acquire(home string) (*Lease, error) {
	root, e := filepath.Abs(home)
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Join(root, "run"), 0700); e != nil {
		return nil, e
	}
	p := filepath.Join(root, "run", "canonical-account-writer.lock")
	if info, e := os.Lstat(p); e == nil && !info.Mode().IsRegular() {
		return nil, errors.New("account_writer_lock_invalid")
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	file, e := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	before, e := os.Lstat(p)
	if e != nil {
		file.Close()
		return nil, e
	}
	opened, e := file.Stat()
	if e != nil || !before.Mode().IsRegular() || !os.SameFile(before, opened) {
		file.Close()
		return nil, errors.New("account_writer_lock_changed")
	}
	if e = lock(file); e != nil {
		file.Close()
		return nil, ErrBusy
	}
	return &Lease{file: file, root: root, path: p}, nil
}
func (l *Lease) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return l.closeErr
	}
	l.closed = true // idle guards become unusable; active Do already joined
	if l.file == nil {
		return nil
	}
	unlock(l.file)
	l.closeErr = l.file.Close()
	if l.closeErr == nil {
		l.file = nil
	}
	return l.closeErr
}
