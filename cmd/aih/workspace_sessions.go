package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const workspaceSessionVersion = 1

// workspaceSession is the local reconnect credential for one Server profile and
// one selected root. The token is stored with 0600 permissions and never
// printed by any command.
type workspaceSession struct {
	ServerProfileID string `json:"serverProfileId"`
	Endpoint        string `json:"endpoint"`
	Root            string `json:"root"`
	Label           string `json:"label,omitempty"`
	WorkspaceID     string `json:"workspaceId"`
	ConnectorID     string `json:"connectorId"`
	Token           string `json:"token"`
	UpdatedAt       int64  `json:"updatedAt"`
}

type workspaceSessionFile struct {
	Version  int                `json:"version"`
	Sessions []workspaceSession `json:"sessions"`
}

type workspaceSessionStore struct {
	path     string
	mu       sync.Mutex
	sessions []workspaceSession
}

func openWorkspaceSessionStore(aiHome string) (*workspaceSessionStore, error) {
	aiHome = strings.TrimSpace(aiHome)
	if aiHome == "" {
		return nil, errors.New("AIH home is required")
	}
	path := filepath.Join(aiHome, "run", "workspace-connector-sessions.json")
	store := &workspaceSessionStore{path: path}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return store, nil
	}
	var file workspaceSessionFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, errors.New("workspace connector session store is not valid JSON")
	}
	store.sessions = normalizeWorkspaceSessions(file.Sessions)
	return store, nil
}

func (store *workspaceSessionStore) Find(profileID, endpoint, root string) (workspaceSession, bool) {
	if store == nil {
		return workspaceSession{}, false
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	for _, session := range store.sessions {
		if session.ServerProfileID == strings.TrimSpace(profileID) &&
			equalWorkspaceEndpoint(session.Endpoint, endpoint) &&
			session.Root == strings.TrimSpace(root) &&
			session.Token != "" {
			return session, true
		}
	}
	return workspaceSession{}, false
}

func (store *workspaceSessionStore) Save(session workspaceSession) error {
	if store == nil {
		return errors.New("workspace session store is unavailable")
	}
	session.ServerProfileID = strings.TrimSpace(session.ServerProfileID)
	session.Endpoint = strings.TrimRight(strings.TrimSpace(session.Endpoint), "/")
	session.Root = strings.TrimSpace(session.Root)
	session.Token = strings.TrimSpace(session.Token)
	if session.ServerProfileID == "" || session.Root == "" || session.WorkspaceID == "" || session.Token == "" {
		return errors.New("workspace session is incomplete")
	}
	if session.UpdatedAt == 0 {
		session.UpdatedAt = time.Now().UnixMilli()
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	next := make([]workspaceSession, 0, len(store.sessions)+1)
	next = append(next, session)
	for _, existing := range store.sessions {
		if existing.ServerProfileID == session.ServerProfileID &&
			equalWorkspaceEndpoint(existing.Endpoint, session.Endpoint) &&
			existing.Root == session.Root {
			continue
		}
		next = append(next, existing)
	}
	store.sessions = normalizeWorkspaceSessions(next)
	return store.persistLocked()
}

func (store *workspaceSessionStore) RemoveByWorkspaceID(workspaceID string) (bool, error) {
	if store == nil {
		return false, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	store.mu.Lock()
	defer store.mu.Unlock()
	next := make([]workspaceSession, 0, len(store.sessions))
	removed := false
	for _, session := range store.sessions {
		if session.WorkspaceID == workspaceID {
			removed = true
			continue
		}
		next = append(next, session)
	}
	if !removed {
		return false, nil
	}
	store.sessions = next
	return true, store.persistLocked()
}

func (store *workspaceSessionStore) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
		return err
	}
	file := workspaceSessionFile{Version: workspaceSessionVersion, Sessions: store.sessions}
	encoded, err := json.Marshal(file)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(store.path), ".workspace-sessions-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(encoded); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, store.path)
}

func normalizeWorkspaceSessions(sessions []workspaceSession) []workspaceSession {
	result := make([]workspaceSession, 0, len(sessions))
	for _, session := range sessions {
		if strings.TrimSpace(session.Token) == "" || strings.TrimSpace(session.Root) == "" {
			continue
		}
		result = append(result, session)
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].UpdatedAt > result[right].UpdatedAt
	})
	if len(result) > 32 {
		result = result[:32]
	}
	return result
}

func equalWorkspaceEndpoint(left, right string) bool {
	return strings.TrimRight(strings.TrimSpace(left), "/") == strings.TrimRight(strings.TrimSpace(right), "/")
}
