package accountbrowserview

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

func (s *Service) sessionDir() (string, error) {
	// User data belongs only to this task service, never an ordinary Edge profile.
	root, err := os.OpenRoot(s.home)
	if err != nil {
		return "", surfaceFailure("browser_storage_unavailable")
	}
	defer func() { _ = root.Close() }()
	for index, part := range []string{"run", "account-browser", "live-host"} {
		if err := root.Mkdir(part, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return "", surfaceFailure("browser_storage_unavailable")
		}
		info, err := root.Lstat(part)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (index > 0 && runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
			return "", surfaceFailure("browser_storage_unsafe")
		}
		next, err := root.OpenRoot(part)
		if err != nil {
			return "", surfaceFailure("browser_storage_unsafe")
		}
		opened, err := next.Stat(".")
		if err != nil || !os.SameFile(info, opened) {
			_ = next.Close()
			return "", surfaceFailure("browser_storage_unsafe")
		}
		_ = root.Close()
		root = next
	}
	return filepath.Join(s.home, "run", "account-browser", "live-host"), nil
}

// RetryCleanup only retries a positively owned host; it never clears dirty
// markers or adopts a PID. It is an internal operator action, not HTTP input.
func (s *Service) RetryCleanup(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active {
		return ErrBusy
	}
	if s.pending == nil {
		return nil
	}
	if err := s.pending.Shutdown(ctx); err != nil {
		return err
	}
	s.pending = nil
	s.blocked = false
	return nil
}
