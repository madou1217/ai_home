// Package launcherstore persists AIH Launch application usage statistics as an atomic JSON file.
package launcherstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
)

const (
	lockRetryInterval = 50 * time.Millisecond
	lockAcquireLimit  = 2 * time.Second
	staleLockAge      = 30 * time.Second
	renameRetryCount  = 3
	renameRetryDelay  = 50 * time.Millisecond
)

// Store manages ~/.ai_home/run/launcher/usage.json with atomic temp-file renames.
type Store struct {
	path string
	mu   sync.Mutex
}

// New creates a usage store rooted under aiHomeDir/run/launcher/usage.json.
func New(aiHomeDir string) (*Store, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, errors.New("launcher_store_ai_home_required")
	}
	return &Store{
		path: filepath.Join(root, "run", "launcher", "usage.json"),
	}, nil
}

// Path returns the full path to usage.json.
func (s *Store) Path() string {
	if s == nil {
		return ""
	}
	return s.path
}

// Load reads the persisted usage snapshot. Missing files yield an empty snapshot without error.
func (s *Store) Load(_ context.Context) (launcher.UsageSnapshot, error) {
	if s == nil || s.path == "" {
		return emptyUsageSnapshot(), errors.New("launcher_store_uninitialized")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

// RecordOpen increments count and updates openedAtMs for appID, retaining the 500 most recent entries.
func (s *Store) RecordOpen(ctx context.Context, appID string, openedAtMs int64) error {
	if s == nil || s.path == "" {
		return errors.New("launcher_store_uninitialized")
	}
	id := strings.TrimSpace(appID)
	if id == "" {
		return launcher.ErrInvalidInput
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	release, err := s.acquireFileLock(ctx)
	if err != nil {
		return err
	}
	defer release()

	snap, err := s.readLocked()
	if err != nil {
		// Recover from a corrupted usage file rather than permanently breaking opens.
		snap = emptyUsageSnapshot()
	}
	entry := snap.Apps[id]
	entry.Count++
	entry.OpenedAtMs = openedAtMs
	snap.Apps[id] = entry

	pruneUsage(&snap, launcher.MaxUsageEntries)
	return s.writeAtomicLocked(snap)
}

func (s *Store) acquireFileLock(ctx context.Context) (func(), error) {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	lockPath := s.path + ".lock"
	deadline := time.Now().Add(lockAcquireLimit)
	for {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = f.WriteString(strconv.Itoa(os.Getpid()) + "\n")
			_ = f.Close()
			return func() { _ = os.Remove(lockPath) }, nil
		}
		if !os.IsExist(err) {
			return nil, err
		}
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > staleLockAge {
			_ = os.Remove(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("acquire usage lock %s timed out after %s", lockPath, lockAcquireLimit)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(lockRetryInterval):
		}
	}
}

func (s *Store) readLocked() (launcher.UsageSnapshot, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return emptyUsageSnapshot(), nil
		}
		return emptyUsageSnapshot(), err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return emptyUsageSnapshot(), nil
	}
	var snap launcher.UsageSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return emptyUsageSnapshot(), err
	}
	if snap.Apps == nil {
		snap.Apps = map[string]launcher.UsageEntry{}
	}
	snap.Version = launcher.UsageVersion
	return snap, nil
}

func (s *Store) writeAtomicLocked(snap launcher.UsageSnapshot) error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	snap.Version = launcher.UsageVersion
	if snap.Apps == nil {
		snap.Apps = map[string]launcher.UsageEntry{}
	}
	payload, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	tmp, err := os.CreateTemp(dir, ".usage-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := renameWithRetry(tmpPath, s.path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func renameWithRetry(src, dst string) error {
	attempts := 1
	if runtime.GOOS == "windows" {
		attempts = renameRetryCount
	}
	var lastErr error
	for i := 0; i < attempts; i++ {
		if err := os.Rename(src, dst); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if i+1 < attempts {
			time.Sleep(renameRetryDelay)
		}
	}
	return lastErr
}

func emptyUsageSnapshot() launcher.UsageSnapshot {
	return launcher.UsageSnapshot{
		Version: launcher.UsageVersion,
		Apps:    map[string]launcher.UsageEntry{},
	}
}

func pruneUsage(snap *launcher.UsageSnapshot, maxEntries int) {
	if snap == nil || len(snap.Apps) <= maxEntries || maxEntries <= 0 {
		return
	}
	type pair struct {
		id    string
		entry launcher.UsageEntry
	}
	items := make([]pair, 0, len(snap.Apps))
	for id, entry := range snap.Apps {
		items = append(items, pair{id: id, entry: entry})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].entry.OpenedAtMs != items[j].entry.OpenedAtMs {
			return items[i].entry.OpenedAtMs > items[j].entry.OpenedAtMs
		}
		return items[i].id < items[j].id
	})
	kept := make(map[string]launcher.UsageEntry, maxEntries)
	for _, item := range items[:maxEntries] {
		kept[item.id] = item.entry
	}
	snap.Apps = kept
}

var _ launcher.UsageStore = (*Store)(nil)
