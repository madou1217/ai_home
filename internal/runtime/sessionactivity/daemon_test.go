package sessionactivity

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDaemonFlushDeduplicationAndLifecycle(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	var now atomic.Int64
	now.Store(1_700_000_000_000)

	var (
		mu        sync.Mutex
		callbacks int
	)
	daemon := NewDaemon(DaemonOptions{
		AIHomeDir:     aiHome,
		HostHomeDir:   hostHome,
		FlushInterval: 20 * time.Millisecond,
		Now:           func() time.Time { return time.UnixMilli(now.Load()) },
		Tmux: &fakeTmuxRunner{
			detect: TmuxDetectResult{Available: false},
		},
		OnSnapshotChanged: func(_ map[string]AccountSnapshot) {
			mu.Lock()
			callbacks++
			mu.Unlock()
		},
	})

	if err := daemon.Start(context.Background()); err != nil {
		t.Fatalf("Daemon Start failed: %v", err)
	}
	// Duplicate Start is idempotent
	if err := daemon.Start(context.Background()); err != nil {
		t.Fatalf("duplicate Daemon Start failed: %v", err)
	}

	// Wait a couple ticks; empty signature must only trigger OnSnapshotChanged once
	time.Sleep(60 * time.Millisecond)
	mu.Lock()
	cbInitial := callbacks
	mu.Unlock()
	if cbInitial != 1 {
		t.Fatalf("expected OnSnapshotChanged once for stable empty snapshot, got %d", cbInitial)
	}

	// Mutate activity; OnSnapshotChanged should fire again
	const ref = "acct_cccccccccccccccccccc"
	daemon.Activity().Begin("codex", ref, "gpt-5")
	time.Sleep(60 * time.Millisecond)

	mu.Lock()
	cbAfter := callbacks
	mu.Unlock()
	if cbAfter != 2 {
		t.Fatalf("expected OnSnapshotChanged second time after Begin, got %d", cbAfter)
	}

	raw, err := os.ReadFile(filepath.Join(aiHome, "run", "account-activity.json"))
	if err != nil {
		t.Fatalf("expected run/account-activity.json written: %v", err)
	}
	var doc ActivityDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("invalid account-activity.json: %v", err)
	}
	if doc.Accounts["codex:"+ref].InFlight != 1 {
		t.Fatalf("expected inFlight=1 in written json, got %+v", doc.Accounts)
	}

	if err := daemon.Close(); err != nil {
		t.Fatalf("Daemon Close failed: %v", err)
	}
	// Idempotent Close
	if err := daemon.Close(); err != nil {
		t.Fatalf("duplicate Daemon Close failed: %v", err)
	}
}
