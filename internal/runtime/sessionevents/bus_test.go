package sessionevents

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBusSubscribePublishCompatibleSessions(t *testing.T) {
	bus := NewBus(BusOptions{Debounce: 20 * time.Millisecond})
	defer bus.Close()

	chExact, doneExact, unsubExact := bus.Subscribe(Session{
		Provider:       "Claude",
		SessionID:      "sess-1",
		ProjectDirName: "proj-a",
	}, false)
	defer unsubExact()

	chWildcard, doneWild, unsubWild := bus.Subscribe(Session{
		Provider:  "claude",
		SessionID: "sess-1",
	}, false)
	defer unsubWild()

	chOther, _, unsubOther := bus.Subscribe(Session{
		Provider:       "claude",
		SessionID:      "sess-1",
		ProjectDirName: "proj-b",
	}, false)
	defer unsubOther()

	if !bus.Publish(Session{
		Provider:       "claude",
		SessionID:      "sess-1",
		ProjectDirName: "proj-a",
		ProjectPath:    "/tmp/repo-a",
	}, Event{
		Type:      "session:turn-completed",
		Source:    "official-hook",
		EventName: "Stop",
		Phase:     "turn-completed",
		At:        1700000000000,
	}) {
		t.Fatal("Publish 返回 false，期望 true")
	}

	select {
	case got := <-chExact:
		if got.Type != "session:turn-completed" || got.ProjectPath != "/tmp/repo-a" || got.EventName != "Stop" {
			t.Fatalf("chExact 收到意外事件: %+v", got)
		}
	case <-doneExact:
		t.Fatal("chExact 意外关闭")
	case <-time.After(time.Second):
		t.Fatal("chExact 未收到发布事件")
	}

	select {
	case got := <-chWildcard:
		if got.ProjectDirName != "proj-a" || got.Phase != "turn-completed" {
			t.Fatalf("chWildcard 收到意外事件: %+v", got)
		}
	case <-doneWild:
		t.Fatal("chWildcard 意外关闭")
	case <-time.After(time.Second):
		t.Fatal("chWildcard 未收到发布事件")
	}

	select {
	case unexpected := <-chOther:
		t.Fatalf("不兼容的 projectDirName 不应收到事件: %+v", unexpected)
	case <-time.After(50 * time.Millisecond):
	}

	unsubExact()
	unsubWild()
	unsubOther()
	if stats := bus.Stats(); stats.Sessions != 0 || stats.Subscribers != 0 {
		t.Fatalf("退订后应清空统计，got=%+v", stats)
	}
}

func TestBusFsnotifyFileChangeAndCanonicalize(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := t.TempDir()

	claudeProjectDir := filepath.Join(hostHome, ".claude", "projects", "proj-1")
	if err := os.MkdirAll(claudeProjectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(claudeProjectDir, "sess-watch.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"type":"user"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	bus := NewBus(BusOptions{
		HostHomeDir: hostHome,
		AIHomeDir:   aiHome,
		Debounce:    25 * time.Millisecond,
	})
	defer bus.Close()

	ch, done, unsub := bus.Subscribe(Session{
		Provider:       "claude",
		SessionID:      "sess-watch",
		ProjectDirName: "proj-1",
	}, true)
	defer unsub()

	if stats := bus.Stats(); stats.WatchedFiles != 1 {
		t.Fatalf("期望 WatchedFiles=1，got=%+v", stats)
	}

	f, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"type":"assistant"}` + "\n"); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	_ = f.Close()

	select {
	case ev := <-ch:
		if ev.Type != "session:file-changed" || ev.Source != "watcher" || ev.Reason != "file_changed" {
			t.Fatalf("期望 file-changed 事件，got=%+v", ev)
		}
	case <-done:
		t.Fatal("订阅意外关闭")
	case <-time.After(2 * time.Second):
		t.Fatal("fsnotify 未在超时前发出 file-changed")
	}

	projected := filepath.Join(aiHome, "run", "auth-projections", "claude", "acct_1234", ".claude", "projects", "p", "s.jsonl")
	wantHost := filepath.Join(hostHome, ".claude", "projects", "p", "s.jsonl")
	if got := CanonicalizePath(projected, aiHome, hostHome, "claude"); got != wantHost {
		t.Fatalf("CanonicalizePath = %q, want %q", got, wantHost)
	}
	secret := filepath.Join(aiHome, "run", "auth-projections", "claude", "acct_1234", ".claude", ".credentials.json")
	if got := CanonicalizePath(secret, aiHome, hostHome, "claude"); got != secret {
		t.Fatalf("私有凭据路径不应被改写: got %q", got)
	}
}
