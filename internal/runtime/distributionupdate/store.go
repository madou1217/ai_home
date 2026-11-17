package distributionupdate

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/distributionupdate/platform"
)

const maxStateBytes = 128 << 10

type fileLease struct{ file *os.File }

func (l *fileLease) Close() error {
	unlockErr := platform.Unlock(l.file)
	return errors.Join(unlockErr, l.file.Close())
}

// OS locks are separate stable inodes, never removed or renamed. Process death
// releases them automatically; JSON atomic replacement does not release a lock.
func (s *Service) acquire(ctx context.Context, name string, wait bool) (*fileLease, error) {
	root, err := privateRoot(s.directory, false)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	file, err := root.OpenFile(name, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	before, err := root.Lstat(name)
	opened, statErr := file.Stat()
	if err != nil || statErr != nil || !before.Mode().IsRegular() || !os.SameFile(before, opened) || !privatePermissions(opened) {
		file.Close()
		return nil, fmt.Errorf("%w: unsafe update lock file", ErrInvalidState)
	}
	for {
		if err := ctx.Err(); err != nil {
			file.Close()
			return nil, err
		}
		err := platform.Lock(file)
		if err == nil {
			return &fileLease{file}, nil
		}
		if !platform.Contended(err) {
			file.Close()
			return nil, fmt.Errorf("acquire update OS lock: %w", err)
		}
		if !wait {
			file.Close()
			return nil, ErrLocked
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			file.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func privatePermissions(info os.FileInfo) bool {
	// Windows composition must provide a caller-only ACL for Home. Unix modes
	// are enforced here without changing permissions on any preexisting files.
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o077 == 0
}

func privateRoot(directory string, create bool) (*os.Root, error) {
	if create {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, err
		}
	}
	before, err := os.Lstat(directory)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || !privatePermissions(before) {
		return nil, fmt.Errorf("%w: update directory must be private and not a symlink", ErrInvalidState)
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(before, opened) {
		root.Close()
		return nil, fmt.Errorf("%w: update directory changed", ErrInvalidState)
	}
	return root, nil
}

func readJSON(root *os.Root, name string, limit int64, output any, private bool) error {
	before, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() > limit || (private && !privatePermissions(before)) {
		return fmt.Errorf("%w: unsafe or oversized JSON file", ErrInvalidState)
	}
	file, err := root.Open(name)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return fmt.Errorf("%w: JSON file changed", ErrInvalidState)
	}
	body, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return err
	}
	if int64(len(body)) > limit {
		return fmt.Errorf("%w: oversized JSON", ErrInvalidState)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if decoder.Decode(output) != nil || decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("%w: malformed JSON", ErrInvalidState)
	}
	return nil
}

func atomicState(root *os.Root, state Status) error {
	body, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(body) > maxStateBytes {
		return fmt.Errorf("%w: oversized state", ErrInvalidState)
	}
	partial := ".state-" + rand.Text() + ".partial"
	file, err := root.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	ownsPartial := true
	defer func() {
		file.Close()
		if ownsPartial {
			root.Remove(partial)
		}
	}()
	if _, err := file.Write(body); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := root.Rename(partial, "state.json"); err != nil {
		return err
	}
	ownsPartial = false
	if runtime.GOOS != "windows" {
		directory, err := root.Open(".")
		if err != nil {
			return err
		}
		defer directory.Close()
		return directory.Sync()
	}
	return nil
}

func (s *Service) transact(ctx context.Context, update func(*Status) (bool, error)) (Status, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	lease, err := s.acquire(ctx, "state.lock", true)
	if err != nil {
		return Status{}, err
	}
	defer lease.Close()
	root, err := privateRoot(s.directory, false)
	if err != nil {
		return Status{}, err
	}
	defer root.Close()
	var state Status
	err = readJSON(root, "state.json", maxStateBytes, &state, true)
	created := errors.Is(err, os.ErrNotExist)
	if err != nil && !created {
		return Status{}, err
	}
	if created {
		state.SchemaVersion = 1
	}
	if state.SchemaVersion != 1 || (state.Schedule != nil && !validStoredSchedule(state.Schedule)) {
		return Status{}, ErrInvalidState
	}
	state.Current = s.currentSnapshot()
	changed := false
	if state.Latest != nil && !s.validRelease(*state.Latest, false) {
		state.Latest = nil // installed version/build changed; never reuse stale hints
		changed = true
	}
	if update != nil {
		dirty, err := update(&state)
		if err != nil {
			return state, err
		}
		changed = changed || dirty
	}
	if created || changed {
		if err := atomicState(root, state); err != nil {
			return state, err
		}
	}
	return state, nil
}
