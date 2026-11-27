package appsessions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/proxyregion"
)

const (
	storeVersion = 1
	// maxEntries bounds the on-disk history; a desk keeps recent launches only.
	maxEntries = 200
	// exitedRetention keeps exited rows visible for a day so users can see what
	// just closed without accumulating a permanent process graveyard.
	exitedRetention = 24 * time.Hour
)

// ErrNotFound is returned when an instance id no longer exists.
var ErrNotFound = errors.New("app_instance_not_found")

// Store persists launch records under <AIH_HOME>/run/app-instances.json.
type Store struct {
	path string
	mu   sync.Mutex
}

type storeDocument struct {
	Version   int        `json:"version"`
	Instances []Instance `json:"instances"`
}

// New returns a store rooted at the supplied AIH home.
func New(aiHomeDir string) *Store {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		home, _ = os.UserHomeDir()
		home = filepath.Join(home, ".ai_home")
	}
	return &Store{path: filepath.Join(home, "run", "app-instances.json")}
}

// Path returns the backing file (for diagnostics).
func (store *Store) Path() string {
	if store == nil {
		return ""
	}
	return store.path
}

// Add appends one launch record and resolves its process immediately.
func (store *Store) lockDocument() (func(), error) {
	if store == nil || store.path == "" {
		return func() {}, nil
	}
	lockPath := store.path + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = fmt.Fprintf(file, "%d\n", os.Getpid())
			_ = file.Close()
			return func() { _ = os.Remove(lockPath) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(lockPath); statErr == nil &&
			time.Since(info.ModTime()) > 10*time.Second {
			_ = os.Remove(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			// A stuck writer must not block launches forever; the atomic rename
			// still prevents corrupt JSON, so proceed without the lock.
			return func() {}, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (store *Store) Add(ctx context.Context, instance Instance) (Instance, error) {
	if store == nil {
		return Instance{}, errors.New("app_sessions_store_unavailable")
	}
	if instance.ID == "" {
		instance.ID = randomID()
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	release, err := store.lockDocument()
	if err != nil {
		return Instance{}, err
	}
	defer release()
	document, err := store.loadLocked()
	if err != nil {
		return Instance{}, err
	}
	// Refresh before deduplicating: a repeated Chromium launch with the same
	// proxy URL reuses one profile, and Chrome hands the new window to that
	// existing process. Appending another record would make the desk show the
	// same live PID two or three times.
	if _, refreshErr := store.refreshLocked(document, time.Now()); refreshErr == nil && instance.ProfileDir != "" {
		for index := range document.Instances {
			existing := &document.Instances[index]
			if existing.ProfileDir != instance.ProfileDir || !existing.ActiveNow() {
				continue
			}
			existing.Proxied = instance.Proxied
			existing.ProxyURL = instance.ProxyURL
			existing.ProxyMode = instance.ProxyMode
			existing.ProxyCountry = instance.ProxyCountry
			existing.ProxyCity = instance.ProxyCity
			existing.ProxyRegion = instance.ProxyRegion
			if err := store.saveLocked(document); err != nil {
				return Instance{}, err
			}
			return *existing, nil
		}
	}
	document.Instances = append(document.Instances, instance)
	document.Instances = prune(document.Instances, time.Now())
	if err := store.saveLocked(document); err != nil {
		return Instance{}, err
	}
	// The window between `open` returning and the application process spawning
	// is short; resolve now and let the dashboard refresh later.
	_, _ = store.refreshLocked(document, time.Now())
	_ = store.saveLocked(document)
	for _, current := range document.Instances {
		if current.ID == instance.ID {
			return current, nil
		}
	}
	return instance, nil
}

// List refreshes process state and returns instances newest-first.
func (store *Store) List(ctx context.Context) ([]Instance, error) {
	if store == nil {
		return nil, errors.New("app_sessions_store_unavailable")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	release, err := store.lockDocument()
	if err != nil {
		return nil, err
	}
	defer release()
	document, err := store.loadLocked()
	if err != nil {
		return nil, err
	}
	changed, err := store.refreshLocked(document, time.Now())
	if err != nil {
		return nil, err
	}
	document.Instances = prune(document.Instances, time.Now())
	if changed {
		_ = store.saveLocked(document)
	}
	result := append([]Instance(nil), document.Instances...)
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].StartedAtMs > result[j].StartedAtMs
	})
	return result, nil
}

// Kill terminates the selected instances (or every live instance when ids is empty).
func (store *Store) Kill(ctx context.Context, ids []string) ([]KillResult, error) {
	if store == nil {
		return nil, errors.New("app_sessions_store_unavailable")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	release, lockErr := store.lockDocument()
	if lockErr != nil {
		return nil, lockErr
	}
	defer release()
	document, err := store.loadLocked()
	if err != nil {
		return nil, err
	}
	if _, err := store.refreshLocked(document, time.Now()); err != nil {
		return nil, err
	}
	selected := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			selected[trimmed] = struct{}{}
		}
	}
	var results []KillResult
	now := time.Now()
	for index := range document.Instances {
		instance := &document.Instances[index]
		if len(selected) > 0 {
			if _, wanted := selected[instance.ID]; !wanted {
				continue
			}
		} else if !instance.Live {
			continue
		}
		if !instance.Live || len(instance.PIDs) == 0 {
			results = append(results, KillResult{ID: instance.ID, Name: instance.Name, Message: "进程已退出"})
			continue
		}
		pids, killErr := terminateProcesses(ctx, instance.PIDs)
		if killErr != nil {
			results = append(results, KillResult{ID: instance.ID, Name: instance.Name, PIDs: pids, Message: killErr.Error()})
			continue
		}
		instance.Live = false
		instance.Status = StatusExited
		instance.ExitedAtMs = now.UnixMilli()
		instance.PIDs = nil
		results = append(results, KillResult{ID: instance.ID, Name: instance.Name, PIDs: pids, Killed: true})
	}
	if err := store.saveLocked(document); err != nil {
		return results, err
	}
	return results, nil
}

// SetProxyEntry updates one instance's proxy endpoint after a manual reconnect.
// The app process is untouched; only the endpoint/PID/geo fields change.
func (store *Store) SetProxyEntry(ctx context.Context, id string, entry ProxyEntry) error {
	if store == nil {
		return errors.New("app_sessions_store_unavailable")
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return ErrNotFound
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	release, lockErr := store.lockDocument()
	if lockErr != nil {
		return lockErr
	}
	defer release()
	document, err := store.loadLocked()
	if err != nil {
		return err
	}
	for index := range document.Instances {
		instance := &document.Instances[index]
		if instance.ID != id {
			continue
		}
		instance.Proxied = entry.URL != ""
		instance.ProxyURL = entry.URL
		instance.ProxySelector = strings.TrimSpace(entry.Selector)
		instance.ProxyCountry = proxyregion.NormalizeCountry(entry.Country)
		instance.ProxyCity = strings.ToUpper(strings.TrimSpace(entry.City))
		instance.ProxyRegion = strings.TrimSpace(entry.Region)
		instance.ProxyPID = entry.PID
		instance.ProxyHealth = ""
		instance.ProxyHealthDetail = ""
		return store.saveLocked(document)
	}
	return ErrNotFound
}

// History refreshes state and returns exited rows newest-first.
//
// The live desk only shows ActiveNow rows; this is the explicit history view
// so ended launches do not accumulate in the running list.
func (store *Store) History(ctx context.Context) ([]Instance, error) {
	instances, err := store.List(ctx)
	if err != nil {
		return nil, err
	}
	_, history := SplitActive(instances)
	return history, nil
}

// RemoveHistory deletes exited records without touching processes (use Kill to
// stop live ones). Live rows are always kept; empty ids clears all history.
func (store *Store) RemoveHistory(ctx context.Context, ids []string) (int, error) {
	if store == nil {
		return 0, errors.New("app_sessions_store_unavailable")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	release, lockErr := store.lockDocument()
	if lockErr != nil {
		return 0, lockErr
	}
	defer release()
	document, err := store.loadLocked()
	if err != nil {
		return 0, err
	}
	if _, refreshErr := store.refreshLocked(document, time.Now()); refreshErr != nil {
		return 0, refreshErr
	}
	selected := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			selected[trimmed] = struct{}{}
		}
	}
	kept := document.Instances[:0]
	removed := 0
	for _, instance := range document.Instances {
		if instance.ActiveNow() {
			kept = append(kept, instance)
			continue
		}
		if len(selected) > 0 {
			if _, drop := selected[instance.ID]; !drop {
				kept = append(kept, instance)
				continue
			}
		}
		removed++
	}
	document.Instances = kept
	if removed == 0 {
		return 0, nil
	}
	if err := store.saveLocked(document); err != nil {
		return 0, err
	}
	return removed, nil
}

func (store *Store) refreshLocked(document *storeDocument, now time.Time) (bool, error) {
	processes, err := listProcesses(context.Background())
	if err != nil {
		// Process enumeration is best-effort; keep previous state when it fails
		// rather than marking every app as exited.
		return false, nil
	}
	changed := false
	for index := range document.Instances {
		instance := &document.Instances[index]
		resolved, adopted, _ := matchPIDs(*instance, processes, now)
		if resolved == nil {
			resolved = []int{}
		}
		if adopted != instance.Adopted {
			instance.Adopted = adopted
			changed = true
		}
		if !samePIDs(instance.PIDs, resolved) {
			instance.PIDs = resolved
			changed = true
		}
		live := len(resolved) > 0
		if live != instance.Live {
			instance.Live = live
			changed = true
		}
		switch {
		case live:
			if instance.Status != StatusRunning {
				instance.Status = StatusRunning
				instance.ExitedAtMs = 0
				changed = true
			}
		case instance.Status == StatusExited:
			// keep exited
		case now.Sub(time.UnixMilli(instance.StartedAtMs)) < 3*time.Second:
			if instance.Status != StatusStarting {
				instance.Status = StatusStarting
				changed = true
			}
		case instance.Live || instance.Status == StatusRunning:
			instance.Status = StatusExited
			instance.ExitedAtMs = now.UnixMilli()
			changed = true
		default:
			instance.Status = StatusUnknown
		}
	}
	return changed, nil
}

func (store *Store) loadLocked() (*storeDocument, error) {
	document := &storeDocument{Version: storeVersion}
	raw, err := os.ReadFile(store.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return document, nil
		}
		return nil, err
	}
	if json.Unmarshal(raw, document) != nil || document.Version != storeVersion {
		// A stale/corrupt desk must not block launches; start a new document.
		return &storeDocument{Version: storeVersion}, nil
	}
	return document, nil
}

func (store *Store) saveLocked(document *storeDocument) error {
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(document)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".app-instances-*.json")
	if err != nil {
		return err
	}
	name := temporary.Name()
	if _, err := temporary.Write(raw); err != nil {
		_ = temporary.Close()
		_ = os.Remove(name)
		return err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	_ = os.Chmod(name, 0o600)
	if err := os.Rename(name, store.path); err != nil {
		_ = os.Remove(name)
		return err
	}
	return nil
}

func prune(instances []Instance, now time.Time) []Instance {
	cutoff := now.Add(-exitedRetention).UnixMilli()
	kept := make([]Instance, 0, len(instances))
	for _, instance := range instances {
		if !instance.Live && instance.ExitedAtMs > 0 && instance.ExitedAtMs < cutoff {
			continue
		}
		kept = append(kept, instance)
	}
	if len(kept) > maxEntries {
		kept = kept[len(kept)-maxEntries:]
	}
	return kept
}

func samePIDs(left, right []int) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[int]struct{}, len(left))
	for _, pid := range left {
		seen[pid] = struct{}{}
	}
	for _, pid := range right {
		if _, ok := seen[pid]; !ok {
			return false
		}
	}
	return true
}

func randomID() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format("150405.000000000")))
	}
	return hex.EncodeToString(buffer)
}
