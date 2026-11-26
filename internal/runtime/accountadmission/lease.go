// Package accountadmission excludes new managed launches while an account is
// being deleted. OS locks release after a crash; lock files are never removed.
package accountadmission

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

var ErrBusy = errors.New("account_runtime_active: account deletion in progress")
var validProvider = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)
var validRef = regexp.MustCompile(`^acct_[0-9a-f]{20}$`)

type Lease struct {
	file *os.File
	once sync.Once
}

func (l *Lease) Close() error {
	var err error
	if l != nil {
		l.once.Do(func() { unlock(l.file); err = l.file.Close() })
	}
	return err
}

func lockFile(home, provider, ref, suffix string, exclusive bool) (*Lease, error) {
	if !filepath.IsAbs(home) || !validProvider.MatchString(provider) || !validRef.MatchString(ref) {
		return nil, errors.New("account_admission_invalid")
	}
	root, err := filepath.EvalSymlinks(home)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, "run", "account-admission")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil || real != dir {
		return nil, errors.New("account_admission_path_untrusted")
	}
	path := filepath.Join(dir, provider+"-"+ref+suffix)
	if info, e := os.Lstat(path); e == nil && !info.Mode().IsRegular() {
		return nil, errors.New("account_admission_file_untrusted")
	} else if e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	seen, err := os.Lstat(path)
	opened, e := file.Stat()
	if err != nil || e != nil || !seen.Mode().IsRegular() || !os.SameFile(seen, opened) {
		file.Close()
		return nil, errors.New("account_admission_changed")
	}
	if err = lock(file, exclusive); err != nil {
		file.Close()
		return nil, ErrBusy
	}
	return &Lease{file: file}, nil
}

// Active reports whether another process currently holds the shared launch
// lease for this account. It is a non-blocking probe for CLI account selection:
// a busy writer means an existing native session is still attached.
func Active(home, provider, ref string) bool {
	lease, err := lockFile(home, provider, ref, ".writers", true)
	if errors.Is(err, ErrBusy) {
		return true
	}
	if err != nil {
		return false
	}
	_ = lease.Close()
	return false
}

// Launch retains a shared activity lease through process exit and capture. It
// briefly checks the deletion intent gate before/after acquiring the lease.
func Launch(home, provider, ref string) (*Lease, error) {
	gate, err := lockFile(home, provider, ref, ".intent", false)
	if err != nil {
		return nil, err
	}
	defer gate.Close()
	return lockFile(home, provider, ref, ".writers", false)
}

// Deleting holds the intent gate while owners are inspected and quiesced. It
// does not need the activity lock until Prepare, so force can close old writers.
func Deleting(home, provider, ref string) (*Lease, error) {
	return lockFile(home, provider, ref, ".intent", true)
}
func Quiesced(home, provider, ref string) (*Lease, error) {
	return lockFile(home, provider, ref, ".writers", true)
}
