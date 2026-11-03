// Package persistent stores only the address and recovery metadata for Go
// persistent sessions. Credentials and prompt content never enter this store.
package persistent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalidRegistry = errors.New("persistent session registry entry invalid")
	ErrRegistryIO      = errors.New("persistent session registry I/O failed")
)

var safePart = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
var accountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)

type Entry struct {
	Provider     string    `json:"provider"`
	RuntimeScope string    `json:"runtime_scope"`
	Gateway      bool      `json:"gateway,omitempty"`
	AccountRef   string    `json:"account_ref,omitempty"`
	Socket       string    `json:"socket"`
	Session      string    `json:"session"`
	CWD          string    `json:"cwd,omitempty"`
	Label        string    `json:"label,omitempty"`
	ForwardArgs  []string  `json:"forward_args,omitempty"`
	NativeID     string    `json:"native_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	Secret       string    `json:"-"`
}

type Registry struct {
	dir string
	mu  sync.Mutex
}

func NewRegistry(runDir string) (*Registry, error) {
	if strings.TrimSpace(runDir) == "" || filepath.IsAbs(runDir) == false {
		return nil, ErrInvalidRegistry
	}
	return &Registry{dir: filepath.Join(runDir, "persistent-sessions")}, nil
}

func (registry *Registry) Write(ctx context.Context, entry Entry) error {
	if registry == nil || ctx == nil || ctx.Err() != nil {
		return ErrInvalidRegistry
	}
	now := time.Now().UTC()
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = now
	}
	entry.UpdatedAt = now
	if !validEntry(entry) {
		return ErrInvalidRegistry
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if err := os.MkdirAll(registry.dir, 0o700); err != nil {
		return errors.Join(ErrRegistryIO, err)
	}
	path := registry.entryPath(entry.Socket, entry.Session)
	if path == "" {
		return ErrInvalidRegistry
	}
	payload, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return errors.Join(ErrRegistryIO, err)
	}
	temporary, err := os.CreateTemp(registry.dir, ".session-*.tmp")
	if err != nil {
		return errors.Join(ErrRegistryIO, err)
	}
	tempPath := temporary.Name()
	defer os.Remove(tempPath)
	if err := temporary.Chmod(0o600); err == nil {
		_, err = temporary.Write(append(payload, '\n'))
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.Join(ErrRegistryIO, err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return errors.Join(ErrRegistryIO, err)
	}
	return nil
}

func (registry *Registry) List(ctx context.Context) ([]Entry, error) {
	if registry == nil || ctx == nil || ctx.Err() != nil {
		return nil, ErrInvalidRegistry
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	files, err := os.ReadDir(registry.dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.Join(ErrRegistryIO, err)
	}
	entries := make([]Entry, 0, len(files))
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		payload, readErr := os.ReadFile(filepath.Join(registry.dir, file.Name()))
		if readErr != nil {
			return nil, errors.Join(ErrRegistryIO, readErr)
		}
		var entry Entry
		if json.Unmarshal(payload, &entry) != nil || !validEntry(entry) {
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func (registry *Registry) Remove(ctx context.Context, socket, session string) error {
	if registry == nil || ctx == nil || ctx.Err() != nil {
		return ErrInvalidRegistry
	}
	path := registry.entryPath(socket, session)
	if path == "" {
		return ErrInvalidRegistry
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return errors.Join(ErrRegistryIO, err)
	}
	return nil
}

func (registry *Registry) entryPath(socket, session string) string {
	if !safePart.MatchString(socket) || !safePart.MatchString(session) {
		return ""
	}
	return filepath.Join(registry.dir, socket+"--"+session+".json")
}

func validEntry(entry Entry) bool {
	if entry.Provider == "" || !safePart.MatchString(entry.Provider) ||
		!safePart.MatchString(entry.Socket) || !safePart.MatchString(entry.Session) ||
		entry.CreatedAt.IsZero() || entry.UpdatedAt.IsZero() || entry.Secret != "" {
		return false
	}
	if entry.Gateway {
		return entry.RuntimeScope == "gateway" && entry.AccountRef == ""
	}
	return accountRefPattern.MatchString(entry.AccountRef) && entry.RuntimeScope == entry.AccountRef
}
