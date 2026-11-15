// Package accountwriterlease excludes offline account writes from daemon startup
// and lifetime. OS locks release on process exit; the lock inode is never removed.
package accountwriterlease

import (
	"errors"
	"os"
	"path/filepath"
)

var ErrBusy = errors.New("backup_core_writer_busy")

type Lease struct{ file *os.File }

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
	return &Lease{file: file}, nil
}
func (l *Lease) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	unlock(l.file)
	e := l.file.Close()
	l.file = nil
	return e
}
