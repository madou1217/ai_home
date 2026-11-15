// Package configsnapshot owns bounded native-config snapshots and guarded file
// publication. Symlinks and permissions are retained; displaced external edits
// are preserved rather than overwritten. It is not an OS filesystem sandbox.
package configsnapshot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/runtime/fileexchange"
)

const MaxBytes = 2 * 1024 * 1024

var ErrChanged = errors.New("native_config_changed_retry")
var ErrRecovery = errors.New("native_config_recovery_required")

type Snapshot struct {
	Path    string
	Content []byte
	Exists  bool
	Mode    os.FileMode
	info    os.FileInfo
}
type Journal struct {
	Version int    `json:"version"`
	Target  string `json:"target"`
	Stage   string `json:"stage"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Remove  bool   `json:"remove"`
	Existed bool   `json:"existed"`
}

func digest(value []byte) string { s := sha256.Sum256(value); return hex.EncodeToString(s[:]) }
func targetPath(requested string) (string, error) {
	absolute, err := filepath.Abs(requested)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return resolved, nil
	}
	if info, e := os.Lstat(absolute); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("native_config_broken_link")
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(absolute)
	tail := []string{filepath.Base(absolute)}
	for {
		resolved, e := filepath.EvalSymlinks(parent)
		if e == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, tail[i])
			}
			return resolved, nil
		}
		if !errors.Is(e, os.ErrNotExist) {
			return "", e
		}
		next := filepath.Dir(parent)
		if next == parent {
			return "", err
		}
		tail = append(tail, filepath.Base(parent))
		parent = next
	}
}
func Read(requested string) (Snapshot, error) {
	target, err := targetPath(requested)
	if err != nil {
		return Snapshot{}, err
	}
	if _, err := os.Lstat(target + ".aih-config-transaction.json"); err == nil {
		return Snapshot{}, ErrRecovery
	} else if !errors.Is(err, os.ErrNotExist) {
		return Snapshot{}, err
	}
	return readAt(target)
}
func readAt(target string) (Snapshot, error) {
	out := Snapshot{Path: target, Mode: 0600}
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if !info.Mode().IsRegular() {
		return out, errors.New("native_config_not_regular")
	}
	if info.Size() > MaxBytes {
		return out, errors.New("native_config_too_large")
	}
	file, err := os.Open(target)
	if err != nil {
		return out, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return out, ErrChanged
	}
	content, err := io.ReadAll(io.LimitReader(file, MaxBytes+1))
	if err != nil {
		return out, err
	}
	if len(content) > MaxBytes {
		return out, errors.New("native_config_too_large")
	}
	after, err := file.Stat()
	if err != nil || opened.Size() != after.Size() || !opened.ModTime().Equal(after.ModTime()) {
		return out, ErrChanged
	}
	out.Content = content
	out.Exists = true
	out.Mode = info.Mode().Perm()
	out.info = opened
	return out, nil
}
func same(a, b Snapshot) bool {
	return a.Exists == b.Exists && bytes.Equal(a.Content, b.Content) && (!a.Exists || os.SameFile(a.info, b.info) && a.Mode == b.Mode)
}

// Update serializes cooperating writers and rechecks the observed snapshot.
// nil next + remove=false means no change. transform must not perform I/O.
func Update(requested string, transform func(Snapshot) (next []byte, remove bool, err error)) (changed bool, resultErr error) {
	target, err := targetPath(requested)
	if err != nil {
		return false, err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return false, err
	}
	lockPath := target + ".aih-config.lock"
	if info, e := os.Lstat(lockPath); e == nil && !info.Mode().IsRegular() {
		return false, errors.New("native_config_lock_invalid")
	}
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	opened, err := lock.Stat()
	if err != nil {
		return false, err
	}
	observed, err := os.Lstat(lockPath)
	if err != nil || !observed.Mode().IsRegular() || !os.SameFile(opened, observed) {
		return false, ErrChanged
	}
	if err = lockExclusive(lock); err != nil {
		return false, errors.New("native_config_busy")
	}
	defer unlockExclusive(lock)
	if err = recoverPublication(target); err != nil {
		return false, err
	}
	before, err := readAt(target)
	if err != nil {
		return false, err
	}
	next, remove, err := transform(before)
	if err != nil {
		return false, err
	}
	if !remove && (next == nil || bytes.Equal(before.Content, next)) {
		return false, nil
	}
	if remove && !before.Exists {
		return false, nil
	}
	if len(next) > MaxBytes {
		return false, errors.New("native_config_too_large")
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".aih-config-stage-")
	if err != nil {
		return false, err
	}
	stage := temp.Name()
	owned := true
	defer func() {
		temp.Close()
		if owned {
			_ = os.Remove(stage)
		}
	}()
	if err = temp.Chmod(before.Mode); err != nil {
		return false, err
	}
	if _, err = temp.Write(next); err != nil {
		return false, err
	}
	if err = temp.Sync(); err != nil {
		return false, err
	}
	if err = temp.Close(); err != nil {
		return false, err
	}
	resolved, err := targetPath(requested)
	if err != nil || resolved != target {
		return false, ErrChanged
	}
	current, err := readAt(target)
	if err != nil {
		return false, err
	}
	if !same(before, current) {
		return false, ErrChanged
	}
	journal := Journal{Version: 1, Target: target, Stage: stage, Before: digest(before.Content), After: digest(next), Remove: remove, Existed: before.Exists}
	if err = writeJournal(target, journal); err != nil {
		return false, err
	}
	owned = false // durable recovery owns artifacts now
	if remove {
		if err = os.Remove(stage); err != nil {
			return false, ErrRecovery
		} // our empty stage
		if err = fileexchange.MoveAside(target, stage); err != nil {
			return false, ErrRecovery
		}
	} else if !before.Exists {
		if err = fileexchange.MoveAside(stage, target); err != nil {
			return false, ErrRecovery
		}
	} else {
		displaced, exchangeErr := fileexchange.Exchange(stage, target)
		if exchangeErr != nil || displaced == "" {
			return false, ErrRecovery
		}
	}
	if err = finishPublication(target, journal, before); err != nil {
		return true, err
	}
	return true, nil
}
func writeJournal(target string, value Journal) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(target), ".aih-config-journal-")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	defer file.Close()
	if _, err = file.Write(raw); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = fileexchange.MoveAside(name, target+".aih-config-transaction.json"); err != nil {
		return ErrRecovery
	}
	return nil
}
