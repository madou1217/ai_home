package peer

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

type fakeWatcher struct {
	added  []string
	events chan fsnotify.Event
	errors chan error
}

func newFakeWatcher() *fakeWatcher {
	return &fakeWatcher{
		events: make(chan fsnotify.Event, 8),
		errors: make(chan error, 4),
	}
}

func (f *fakeWatcher) Add(path string) error {
	f.added = append(f.added, path)
	return nil
}

func (f *fakeWatcher) Events() <-chan fsnotify.Event { return f.events }
func (f *fakeWatcher) Errors() <-chan error          { return f.errors }
func (f *fakeWatcher) Close() error                  { return nil }

func writePeerFile(t *testing.T, root, dirName, id, content string) {
	t.Helper()
	dir := filepath.Join(root, "run", "peer", dirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
}

func TestListMessagesRequiresAIHomeDir(t *testing.T) {
	if _, err := ListMessages("", "all", 500); err != ErrStoreUnavailable {
		t.Fatalf("err = %v, want %v", err, ErrStoreUnavailable)
	}
}

func TestListMessagesProjectsNormalizesAndReverses(t *testing.T) {
	root := t.TempDir()
	writePeerFile(t, root, "pending", "pm-111122223333", `{
		"id": "pm-111122223333",
		"from": {"channel":"tmux","name":" alpha "},
		"to": {"channel":"codex","sessionId":"s-1"},
		"body": "first",
		"state": "delivered",
		"createdAt": 1000,
		"attemptCount": 2,
		"attempts": [{"ok": false, "error": "timeout"}]
	}`)
	writePeerFile(t, root, "inflight", "pm-222233334444", `{
		"id": "pm-222233334444",
		"replyTo": "pm-111122223333",
		"body": "inflight-msg",
		"state": "delivered",
		"createdAt": 2000
	}`)
	writePeerFile(t, root, "archive", "pm-333344445555", `{
		"id": "pm-333344445555",
		"body": "archived-unknown-state",
		"state": "custom",
		"createdAt": 3000,
		"deliveredAt": 3100
	}`)
	writePeerFile(t, root, "archive", "pm-444455556666", `{
		"id": "pm-444455556666",
		"body": "failed-msg",
		"state": "failed",
		"createdAt": 4000,
		"error": "permanent"
	}`)

	all, err := ListMessages(root, "unknown", 2000)
	if err != nil {
		t.Fatalf("ListMessages() error = %v", err)
	}
	if all.Store.State != "all" || all.Store.Limit != MaxLimit {
		t.Fatalf("store = %+v", all.Store)
	}
	if all.Counts != (Counts{Total: 4, Pending: 2, Delivered: 1, Read: 0, Failed: 1}) {
		t.Fatalf("counts = %+v", all.Counts)
	}
	if len(all.Messages) != 4 || all.Messages[0].ID != "pm-444455556666" || all.Messages[3].ID != "pm-111122223333" {
		t.Fatalf("order mismatch: %+v", all.Messages)
	}
	if all.Messages[3].ShortID != "pm-11112222" || all.Messages[3].LastAttemptError != "timeout" || all.Messages[3].From.Name != "alpha" {
		t.Fatalf("projection mismatch: %+v", all.Messages[3])
	}
	if all.Messages[2].State != "pending" || all.Messages[2].ReplyToShort != "pm-11112222" {
		t.Fatalf("inflight projection mismatch: %+v", all.Messages[2])
	}
	if all.Messages[1].State != "delivered" {
		t.Fatalf("archive state fallback mismatch: %+v", all.Messages[1])
	}

	onlyPending, err := ListMessages(root, "pending", 10)
	if err != nil {
		t.Fatalf("ListMessages(pending) error = %v", err)
	}
	if len(onlyPending.Messages) != 2 || onlyPending.Counts.Pending != 2 {
		t.Fatalf("pending filter mismatch: %+v", onlyPending)
	}

	onlyFailed, err := ListMessages(root, "failed", 10)
	if err != nil {
		t.Fatalf("ListMessages(failed) error = %v", err)
	}
	if len(onlyFailed.Messages) != 1 || onlyFailed.Messages[0].Error != "permanent" {
		t.Fatalf("failed filter mismatch: %+v", onlyFailed)
	}
}

func TestWatchUnavailableWhenPeerDirsMissing(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := Watch(ctx, t.TempDir(), WatchOptions{})
	if err != nil {
		t.Fatalf("Watch() error = %v", err)
	}
	ev := <-events
	if ev.Type != "peer-unavailable" {
		t.Fatalf("first event = %+v, want peer-unavailable", ev)
	}
	cancel()
	if _, ok := <-events; ok {
		t.Fatalf("expected closed channel after cancel")
	}
}

func TestWatchReadyAndDebouncedChange(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"pending", "archive"} {
		if err := os.MkdirAll(filepath.Join(root, "run", "peer", d), 0o755); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
	}
	fw := newFakeWatcher()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := Watch(ctx, root, WatchOptions{
		Debounce: 20 * time.Millisecond,
		Now:      func() time.Time { return time.UnixMilli(12345) },
		NewWatcher: func() (DirectoryWatcher, error) {
			return fw, nil
		},
	})
	if err != nil {
		t.Fatalf("Watch() error = %v", err)
	}
	if got := <-events; got.Type != "ready" || got.At != 12345 {
		t.Fatalf("ready event = %+v", got)
	}
	if len(fw.added) != 2 {
		t.Fatalf("watched %d dirs, want 2", len(fw.added))
	}
	fw.events <- fsnotify.Event{Name: "a.json", Op: fsnotify.Create}
	fw.events <- fsnotify.Event{Name: "b.json", Op: fsnotify.Write}
	select {
	case got := <-events:
		if got.Type != "peer-changed" || got.At != 12345 {
			t.Fatalf("changed event = %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for peer-changed")
	}
}
