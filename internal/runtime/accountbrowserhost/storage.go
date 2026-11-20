package accountbrowserhost

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

const (
	lockFileName         = "host.lock"
	activeMarkerFileName = "host.active"
	userDataDirName      = "user-data"
	activeMarkerContent  = "aih-stable-host-v1\n"
	privateDirPerm       = os.FileMode(0o700)
	privateFilePerm      = os.FileMode(0o600)
)

// hostStorage owns the exclusive host.lock flock, pinned session root, and
// lifecycle host.active marker for one shared browser host instance.
type hostStorage struct {
	dir             string
	root            *os.Root
	rootInfo        fs.FileInfo
	lockFile        *os.File
	lockInfo        fs.FileInfo
	markerOwned     bool
	markerNeedsSync bool
	markerInfo      fs.FileInfo
	released        bool
}

// validateSessionDir validates an already-existing clean absolute private
// session directory without creating directories or repairing permissions.
func validateSessionDir(dir string) error {
	root, _, err := openValidatedSessionRoot(dir)
	if err != nil {
		return err
	}
	_ = root.Close()
	return nil
}

// acquireStorage pins dir, acquires the exclusive nonblocking host.lock flock,
// and fails closed if host.active already exists without altering dirty state.
func acquireStorage(dir string) (*hostStorage, error) {
	root, rootInfo, err := openValidatedSessionRoot(dir)
	if err != nil {
		return nil, err
	}
	lf, lockInfo, err := openLockFile(root)
	if err != nil {
		_ = root.Close()
		return nil, err
	}
	if err := lockFile(lf); err != nil {
		_ = lf.Close()
		_ = root.Close()
		if errors.Is(err, ErrBusy) {
			return nil, err
		}
		return nil, stripPathErr("lock host file", err)
	}
	s := &hostStorage{dir: dir, root: root, rootInfo: rootInfo, lockFile: lf, lockInfo: lockInfo}
	if err := s.verifyHandles(); err != nil {
		_ = s.closeHandles()
		return nil, err
	}
	if err := checkNoActiveMarker(root); err != nil {
		_ = s.closeHandles()
		return nil, err
	}
	return s, nil
}

// prepare creates or validates the private user-data directory under the pinned
// session root and returns its validated absolute path internally.
func (s *hostStorage) prepare() (string, error) {
	if err := s.verifyHandles(); err != nil {
		return "", err
	}
	if err := s.root.Mkdir(userDataDirName, privateDirPerm); err != nil && !errors.Is(err, os.ErrExist) {
		return "", stripPathErr("create user-data directory", err)
	}
	lstatInfo, err := s.root.Lstat(userDataDirName)
	if err != nil || !isSafePrivateDir(lstatInfo) {
		return "", fmt.Errorf("user-data directory unsafe: %w", ErrUnsafePath)
	}
	childRoot, err := s.root.OpenRoot(userDataDirName)
	if err != nil {
		return "", stripPathErr("open user-data root", err)
	}
	defer childRoot.Close()
	openedInfo, err := childRoot.Stat(".")
	if err != nil || !isSafePrivateDir(openedInfo) || !os.SameFile(lstatInfo, openedInfo) {
		return "", fmt.Errorf("user-data directory identity mismatch: %w", ErrUnsafePath)
	}
	dataDir := filepath.Join(s.dir, userDataDirName)
	absInfo, err := os.Lstat(dataDir)
	if err != nil || !isSafePrivateDir(absInfo) || !os.SameFile(openedInfo, absInfo) {
		return "", fmt.Errorf("absolute user-data directory mismatch: %w", ErrUnsafePath)
	}
	return dataDir, nil
}

// markActive exclusively creates and syncs host.active before launch,
// preserving any pre-existing or suspicious marker untouched on error.
func (s *hostStorage) markActive() error {
	if err := s.verifyHandles(); err != nil {
		return err
	}
	if err := checkNoActiveMarker(s.root); err != nil {
		return err
	}
	f, err := s.root.OpenFile(activeMarkerFileName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, privateFilePerm)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			if markerErr := checkNoActiveMarker(s.root); markerErr != nil {
				return markerErr
			}
			return fmt.Errorf("active marker already exists: %w", ErrRecoveryRequired)
		}
		return stripPathErr("create active marker", err)
	}
	fstatInfo, err := verifyRegularFD(s.root, activeMarkerFileName, f, nil)
	if err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.WriteString(activeMarkerContent); err != nil {
		_ = f.Close()
		return stripPathErr("write active marker", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return stripPathErr("sync active marker", err)
	}
	if err := f.Close(); err != nil {
		return stripPathErr("close active marker", err)
	}
	if err := syncRoot(s.root); err != nil {
		return err
	}
	s.markerOwned, s.markerInfo = true, fstatInfo
	return nil
}

// release removes only an owned host.active when clean is true, syncs the root,
// and releases handles. Marker suspicion or removal/sync failures keep the lock
// held so callers can fail closed or retry. Repeated calls are safe.
func (s *hostStorage) release(clean bool) error {
	if s == nil || s.released {
		return nil
	}
	if clean && s.markerOwned {
		if err := s.verifyHandles(); err != nil {
			return err
		}
		curInfo, err := s.root.Lstat(activeMarkerFileName)
		if err != nil || !isSafePrivateRegular(curInfo) || s.markerInfo == nil || !os.SameFile(s.markerInfo, curInfo) {
			return fmt.Errorf("active marker missing or replaced: %w", ErrUnsafePath)
		}
		if err := s.root.Remove(activeMarkerFileName); err != nil {
			return stripPathErr("remove active marker", err)
		}
		s.markerOwned, s.markerInfo, s.markerNeedsSync = false, nil, true
	}
	if clean && s.markerNeedsSync {
		if err := syncRoot(s.root); err != nil {
			return err
		}
		s.markerNeedsSync = false
	}
	return s.closeHandles()
}

func (s *hostStorage) closeHandles() error {
	var errs []error
	if s.lockFile != nil {
		if err := unlockFile(s.lockFile); err != nil {
			errs = append(errs, stripPathErr("unlock host lock", err))
		}
		if err := s.lockFile.Close(); err != nil {
			errs = append(errs, stripPathErr("close host lock", err))
		}
		s.lockFile, s.lockInfo = nil, nil
	}
	if s.root != nil {
		if err := s.root.Close(); err != nil {
			errs = append(errs, stripPathErr("close session root", err))
		}
		s.root = nil
	}
	s.released = true
	return errors.Join(errs...)
}

func (s *hostStorage) verifyHandles() error {
	if s == nil || s.released || s.root == nil || s.lockFile == nil {
		return fmt.Errorf("host storage unavailable: %w", ErrUnsafePath)
	}
	curDir, dErr := os.Lstat(s.dir)
	curRoot, rErr := s.root.Stat(".")
	if dErr != nil || rErr != nil || !isSafePrivateDir(curDir) || !isSafePrivateDir(curRoot) ||
		!os.SameFile(s.rootInfo, curDir) || !os.SameFile(s.rootInfo, curRoot) {
		return fmt.Errorf("session directory identity changed: %w", ErrUnsafePath)
	}
	if _, err := verifyRegularFD(s.root, lockFileName, s.lockFile, s.lockInfo); err != nil {
		return err
	}
	return nil
}
