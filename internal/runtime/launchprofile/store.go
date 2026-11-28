// Package launchprofile remembers the last launch configuration for one
// logical target (provider + surface + account + instance slot).
//
// Profiles deliberately store a ProxySpec (selector or URL) instead of only a
// resolved entry: a remembered region must be re-resolved on the next launch,
// and a temporary port must not be reused after the server restarts. No
// credential is stored here.
package launchprofile

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/netguard"
)

// Profile is the durable launch configuration for one target.
type Profile struct {
	Target      netguard.Target `json:"target"`
	Policy      netguard.Policy `json:"policy"`
	LastProxy   string          `json:"lastProxy,omitempty"`
	LastExitIP  string          `json:"lastExitIP,omitempty"`
	LastRegion  string          `json:"lastRegion,omitempty"`
	LastSuccess int64           `json:"lastSuccess,omitempty"`
	UpdatedAt   int64           `json:"updatedAt,omitempty"`
}

// Store persists profiles under <aiHome>/run/launch-profiles.json.
type Store struct {
	path string

	mu       sync.Mutex
	loaded   bool
	profiles map[string]Profile
}

// New creates a store rooted at the AIH home directory.
func New(aiHomeDir string) *Store {
	return &Store{
		path:     filepath.Join(aiHomeDir, "run", "launch-profiles.json"),
		profiles: make(map[string]Profile),
	}
}

func key(target netguard.Target) string {
	return strings.Join([]string{
		strings.TrimSpace(target.Provider),
		strings.TrimSpace(target.Surface),
		strings.TrimSpace(target.AccountRef),
		strings.TrimSpace(target.InstanceSlot),
	}, "\x1f")
}

// NormalizeTarget trims the target fields and rejects an empty provider.
func NormalizeTarget(target netguard.Target) (netguard.Target, error) {
	target.Provider = strings.TrimSpace(target.Provider)
	target.Surface = strings.TrimSpace(target.Surface)
	target.AccountRef = strings.TrimSpace(target.AccountRef)
	target.InstanceSlot = strings.TrimSpace(target.InstanceSlot)
	if target.Provider == "" {
		return netguard.Target{}, errors.New("launch profile 需要 provider")
	}
	if target.Surface == "" {
		target.Surface = "desktop"
	}
	return target, nil
}

func (store *Store) loadLocked() error {
	if store.loaded {
		return nil
	}
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		store.loaded = true
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) == 0 {
		store.loaded = true
		return nil
	}
	var profiles map[string]Profile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return fmt.Errorf("解析 %s 失败: %w", store.path, err)
	}
	if profiles != nil {
		store.profiles = profiles
	}
	store.loaded = true
	return nil
}

// Get returns the profile for a target.
func (store *Store) Get(target netguard.Target) (Profile, bool, error) {
	target, err := NormalizeTarget(target)
	if err != nil {
		return Profile{}, false, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return Profile{}, false, err
	}
	profile, ok := store.profiles[key(target)]
	return profile, ok, nil
}

// Put inserts or replaces a profile and persists the whole map atomically.
func (store *Store) Put(profile Profile) (Profile, error) {
	target, err := NormalizeTarget(profile.Target)
	if err != nil {
		return Profile{}, err
	}
	profile.Target = target
	now := time.Now().UnixMilli()
	profile.UpdatedAt = now
	if profile.LastSuccess == 0 {
		profile.LastSuccess = now
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return Profile{}, err
	}
	store.profiles[key(target)] = profile
	if err := store.saveLocked(); err != nil {
		return Profile{}, err
	}
	return profile, nil
}

// Delete removes one profile.
func (store *Store) Delete(target netguard.Target) error {
	target, err := NormalizeTarget(target)
	if err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return err
	}
	delete(store.profiles, key(target))
	return store.saveLocked()
}

// List returns all profiles ordered by most recent update first.
func (store *Store) List() ([]Profile, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return nil, err
	}
	profiles := make([]Profile, 0, len(store.profiles))
	for _, profile := range store.profiles {
		profiles = append(profiles, profile)
	}
	sort.Slice(profiles, func(i, j int) bool {
		return profiles[i].UpdatedAt > profiles[j].UpdatedAt
	})
	return profiles, nil
}

func (store *Store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(store.profiles, "", "  ")
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(store.path), ".launch-profiles-*.json")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}
	if err := temp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, store.path); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}
