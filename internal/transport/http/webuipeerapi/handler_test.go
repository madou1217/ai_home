package webuipeerapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/madou1217/ai_home/internal/runtime/peer"
)

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

type stubWatcher struct {
	events chan fsnotify.Event
	errors chan error
}

func (s *stubWatcher) Add(string) error               { return nil }
func (s *stubWatcher) Events() <-chan fsnotify.Event  { return s.events }
func (s *stubWatcher) Errors() <-chan error           { return s.errors }
func (s *stubWatcher) Close() error                   { return nil }

func TestNewHandlerRejectsNilAuthorizer(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("err = %v, want %v", err, ErrInvalidDependencies)
	}
}

func TestMessagesAuthMethodAndUnavailable(t *testing.T) {
	unauth, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: false}, AIHomeDir: t.TempDir()})
	rec := httptest.NewRecorder()
	unauth.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, MessagesPath, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth code = %d, want 401", rec.Code)
	}

	handler, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: true}, AIHomeDir: t.TempDir()})
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, MessagesPath, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method code = %d, want 405", rec.Code)
	}

	noHome, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: true}, AIHomeDir: ""})
	rec = httptest.NewRecorder()
	noHome.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, MessagesPath, nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("noHome code = %d, want 503", rec.Code)
	}
}

func TestMessagesSuccessPayload(t *testing.T) {
	root := t.TempDir()
	pendingDir := filepath.Join(root, "run", "peer", "pending")
	if err := os.MkdirAll(pendingDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(pendingDir, "pm-abcdef012345.json"), []byte(`{
		"id": "pm-abcdef012345",
		"body": "hello peer",
		"createdAt": 1234
	}`), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	handler, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: true}, AIHomeDir: root})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, MessagesPath+"?state=pending&limit=25", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		OK       bool            `json:"ok"`
		Messages []peer.Message  `json:"messages"`
		Counts   peer.Counts     `json:"counts"`
		Store    peer.StoreSummary `json:"store"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if !payload.OK || len(payload.Messages) != 1 || payload.Counts.Pending != 1 || payload.Store.Limit != 25 {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestWatchStreamsReadyChangedAndHeartbeat(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "run", "peer", "pending"), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	sw := &stubWatcher{events: make(chan fsnotify.Event, 4), errors: make(chan error, 1)}
	handler, _ := NewHandler(Dependencies{
		Authorizer:        stubAuthorizer{allowed: true},
		AIHomeDir:         root,
		HeartbeatInterval: 35 * time.Millisecond,
		WatchDebounce:     15 * time.Millisecond,
		Now:               func() time.Time { return time.UnixMilli(999) },
		NewWatcher:        func() (peer.DirectoryWatcher, error) { return sw, nil },
	})

	server := httptest.NewServer(handler)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+WatchPath, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status=%d ct=%s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	scanner := bufio.NewScanner(resp.Body)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"type":"ready"`) {
		t.Fatalf("first line = %q, err=%v", scanner.Text(), scanner.Err())
	}
	sw.events <- fsnotify.Event{Name: "x.json", Op: fsnotify.Create}

	seenChanged := false
	seenHeartbeat := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, `"type":"peer-changed"`) {
			seenChanged = true
		}
		if line == ": heartbeat" {
			seenHeartbeat = true
		}
		if seenChanged && seenHeartbeat {
			break
		}
	}
	if !seenChanged || !seenHeartbeat {
		t.Fatalf("seenChanged=%v seenHeartbeat=%v", seenChanged, seenHeartbeat)
	}
}
