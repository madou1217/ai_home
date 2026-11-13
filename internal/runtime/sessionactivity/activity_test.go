package sessionactivity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAccountActivityLifecycleAndSnapshotShape(t *testing.T) {
	var now atomic.Int64
	now.Store(1_700_000_000_000)

	act := NewAccountActivity(AccountActivityOptions{
		Window:            10 * time.Second,
		SessionTurnTTL:    5 * time.Second,
		SessionRuntimeTTL: 4 * time.Second,
		Now:               func() time.Time { return time.UnixMilli(now.Load()) },
	})

	const ref = "acct_0123456789abcdef0123"
	act.Begin("codex", ref, "gpt-5")
	act.Begin("codex", ref, "gpt-5")
	act.Begin("codex", ref, "gpt-4.1")
	act.MarkRuntime("codex", ref, 2, 1, 0)
	act.MarkSessionTurn("codex", ref, 0)

	snap := act.Snapshot()
	entry, ok := snap["codex:"+ref]
	if !ok {
		t.Fatalf("expected snapshot entry, got %#v", snap)
	}
	if entry.InFlight != 4 || entry.Rate != 3 || entry.RuntimeSessions != 2 || entry.RuntimeAttached != 1 {
		t.Fatalf("unexpected counts: %+v", entry)
	}
	if !entry.RuntimeActive || !entry.SessionTurnActive || !entry.RuntimeServing {
		t.Fatalf("expected runtimeActive/sessionTurnActive/runtimeServing true: %+v", entry)
	}
	if len(entry.ActiveModels) != 2 || entry.ActiveModels[0] != "gpt-4.1" || entry.ActiveModels[1] != "gpt-5" {
		t.Fatalf("unexpected active models: %#v", entry.ActiveModels)
	}

	load := act.SelectionLoad("codex", ref, "gpt-5")
	if load.InFlight != 3 || load.ModelInFlight != 2 || load.Rate != 3 || load.WindowMS != 10000 {
		t.Fatalf("unexpected selection load: %+v", load)
	}

	act.End("codex", ref, "gpt-5")
	act.End("codex", ref, "gpt-5")
	act.End("codex", ref, "gpt-4.1")
	loadAfterEnd := act.SelectionLoad("codex", ref, "gpt-5")
	if loadAfterEnd.InFlight != 0 || loadAfterEnd.ModelInFlight != 0 || loadAfterEnd.Rate != 3 {
		t.Fatalf("expected 0 inflight and rate=3 after End, got %+v", loadAfterEnd)
	}

	// TTL 过期后 sessionTurn / runtimeActive 应自动熄灭，rate 随窗口滑动归零
	now.Add(11_000)
	expired := act.Snapshot()
	expEntry, exists := expired["codex:"+ref]
	if !exists {
		t.Fatalf("expected entry with lastActivityAt retained until ResetAccount")
	}
	if expEntry.InFlight != 0 || expEntry.SessionTurnActive || expEntry.RuntimeActive || expEntry.RuntimeServing || expEntry.Rate != 0 || expEntry.LastActivityAt != 1_700_000_000_000 {
		t.Fatalf("expected expired fields zeroed/false while retaining lastActivityAt, got %+v", expEntry)
	}

	// ResetAccount 清除所有计数
	act.Begin("codex", ref, "gpt-5")
	act.MarkRuntime("codex", ref, 1, 1, 0)
	if !act.ResetAccount("codex", ref) {
		t.Fatalf("expected ResetAccount to return true")
	}
	if len(act.Snapshot()) != 0 {
		t.Fatalf("expected empty snapshot after reset")
	}
}

func TestAccountActivitySignatureAndAtomicWrite(t *testing.T) {
	dir := t.TempDir()
	act := NewAccountActivity(AccountActivityOptions{
		Now: func() time.Time { return time.UnixMilli(1_700_000_000_500) },
	})
	const ref = "acct_aaaaaaaaaaaaaaaaaaaa"
	act.MarkRuntime("claude", ref, 1, 1, 10*time.Second)

	snap1 := act.Snapshot()
	sig1 := ComputeSignature(snap1)
	sig2 := ComputeSignature(act.Snapshot())
	if sig1 == "" || sig1 != sig2 {
		t.Fatalf("expected stable signature, got %q vs %q", sig1, sig2)
	}

	act.MarkSessionTurn("claude", ref, 10*time.Second)
	sig3 := ComputeSignature(act.Snapshot())
	if sig3 == sig1 {
		t.Fatalf("expected signature change when sessionTurnActive flips")
	}

	if err := WriteActivitySnapshotAtomic(dir, act.Snapshot(), 1_700_000_001_000); err != nil {
		t.Fatalf("WriteActivitySnapshotAtomic failed: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "run", "account-activity.json"))
	if err != nil {
		t.Fatalf("read written snapshot failed: %v", err)
	}
	var doc ActivityDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal snapshot failed: %v", err)
	}
	if doc.UpdatedAt != 1_700_000_001_000 {
		t.Fatalf("unexpected updatedAt: %d", doc.UpdatedAt)
	}
	item, ok := doc.Accounts["claude:"+ref]
	if !ok || !item.RuntimeServing || !item.SessionTurnActive {
		t.Fatalf("unexpected written account snapshot: %+v", doc.Accounts)
	}
}

func TestAccountActivityConcurrentAccess(t *testing.T) {
	act := NewAccountActivity(AccountActivityOptions{})
	const ref = "acct_bbbbbbbbbbbbbbbbbbbb"
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				act.Begin("codex", ref, "gpt-5")
				act.MarkSessionTurn("codex", ref, 5*time.Second)
				act.MarkRuntime("codex", ref, 1, 1, 5*time.Second)
				_ = act.Snapshot()
				_ = act.SelectionLoad("codex", ref, "gpt-5")
				act.End("codex", ref, "gpt-5")
			}
		}()
	}
	wg.Wait()
	if load := act.SelectionLoad("codex", ref, "gpt-5"); load.InFlight != 0 {
		t.Fatalf("expected balanced inFlight=0 after goroutines finished, got %d", load.InFlight)
	}
}
