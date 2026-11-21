package codexmodelcatalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

const maxContextCatalogBytes = 4 << 20

var errContextCatalogUnavailable = errors.New("codex_context_catalog_unavailable")

// ContextReader reads the installed CLI's bundled catalog without refreshing,
// credentials or a thread. Cache identity includes the resolved binary version.
type ContextReader struct {
	mu         sync.Mutex
	signature  string
	expires    time.Time
	windows    map[string]modelmetadata.ContextWindow
	failure    error
	refreshing chan struct{}
}

var _ modelmetadata.ContextWindowReader = (*ContextReader)(nil)

func NewContextReader() *ContextReader { return &ContextReader{} }

func (reader *ContextReader) ReadContextWindows(ctx context.Context) (map[string]modelmetadata.ContextWindow, error) {
	if reader == nil || ctx == nil {
		return nil, errContextCatalogUnavailable
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		binary, signature, err := contextCatalogBinary()
		if err != nil {
			return nil, errContextCatalogUnavailable
		}
		reader.mu.Lock()
		if reader.signature == signature && time.Now().Before(reader.expires) {
			snapshot, failure := copyContextWindows(reader.windows), reader.failure
			reader.mu.Unlock()
			return snapshot, failure
		}
		if pending := reader.refreshing; pending != nil {
			reader.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-pending:
				continue
			}
		}
		pending := make(chan struct{})
		reader.refreshing = pending
		reader.mu.Unlock()
		windows, err := readBundledContextWindows(ctx, binary)
		if err == nil {
			_, currentSignature, identityErr := contextCatalogBinary()
			if identityErr != nil || currentSignature != signature {
				err = errContextCatalogUnavailable
			}
		}
		reader.mu.Lock()
		if err == nil {
			reader.signature, reader.windows, reader.failure = signature, windows, nil
			reader.expires = time.Now().Add(time.Hour)
		} else if ctx.Err() == nil {
			// Unknown/stale limits must not be silently republished after a failed
			// refresh. The HTTP owner exposes unavailability without guessing.
			reader.windows = nil
			reader.signature, reader.failure = signature, errContextCatalogUnavailable
			reader.expires = time.Now().Add(time.Minute)
		}
		reader.refreshing = nil
		close(pending)
		snapshot := copyContextWindows(reader.windows)
		reader.mu.Unlock()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err != nil {
			return snapshot, errContextCatalogUnavailable
		}
		return snapshot, nil
	}
}

func contextCatalogBinary() (string, string, error) {
	binary, err := providercli.ResolveBinary("codex", "codex")
	if err != nil {
		return "", "", err
	}
	binary, err = resolveContextNativeBinary(binary)
	if err != nil {
		return "", "", err
	}
	info, err := os.Stat(binary)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", errContextCatalogUnavailable
	}
	signature := binary + "/" + strconv.FormatInt(info.Size(), 10) + "/" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
	return binary, signature, nil
}

func readBundledContextWindows(parent context.Context, binary string) (map[string]modelmetadata.ContextWindow, error) {
	home, err := os.MkdirTemp("", "aih-codex-context-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(home)
	codexHome := filepath.Join(home, providerroot.ConfigDir("codex"))
	if err := os.Mkdir(codexHome, 0700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "debug", "models", "--bundled")
	command.Dir = home
	command.Env = privateContextCatalogEnv(home, codexHome)
	command.Stderr = io.Discard
	command.WaitDelay = 500 * time.Millisecond
	output := &contextCatalogOutput{remaining: maxContextCatalogBytes}
	command.Stdout = output
	if err := command.Run(); err != nil {
		return nil, err
	}
	var catalog struct {
		Models []struct {
			Slug        string `json:"slug"`
			Context     int64  `json:"context_window"`
			Maximum     int64  `json:"max_context_window"`
			AutoCompact int64  `json:"auto_compact_token_limit"`
		} `json:"models"`
	}
	if err := json.Unmarshal(output.buffer.Bytes(), &catalog); err != nil {
		return nil, err
	}
	windows := make(map[string]modelmetadata.ContextWindow)
	seen := make(map[string]bool)
	for _, model := range catalog.Models {
		id := strings.TrimSpace(model.Slug)
		window := modelmetadata.ContextWindow{Tokens: model.Context, MaximumTokens: model.Maximum, AutoCompactTokens: model.AutoCompact}
		if id == "" || id != model.Slug || seen[id] {
			return nil, errContextCatalogUnavailable
		}
		seen[id] = true
		if window.IsValid() {
			windows[id] = window
		}
	}
	if len(windows) == 0 {
		return nil, errContextCatalogUnavailable
	}
	return windows, nil
}

func privateContextCatalogEnv(home, codexHome string) []string {
	env := make([]string, 0, 12)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL":
			env = append(env, entry)
		}
	}
	return append(env, "HOME="+home, "USERPROFILE="+home, "CODEX_HOME="+codexHome)
}

type contextCatalogOutput struct {
	buffer    bytes.Buffer
	remaining int
}

func (output *contextCatalogOutput) Write(data []byte) (int, error) {
	if len(data) > output.remaining {
		return 0, errContextCatalogUnavailable
	}
	output.remaining -= len(data)
	return output.buffer.Write(data)
}

func copyContextWindows(source map[string]modelmetadata.ContextWindow) map[string]modelmetadata.ContextWindow {
	snapshot := make(map[string]modelmetadata.ContextWindow, len(source))
	for id, window := range source {
		snapshot[id] = window
	}
	return snapshot
}
