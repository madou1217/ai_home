package writerlifecycle

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testWriter 模拟 agy 暖机子进程：Node 侧 writer 只要有 pid，存活由 pidAlive 判定。
type testWriter struct {
	pid   int
	alive atomic.Bool
}

func newTestWriter(pid int) *testWriter {
	writer := &testWriter{pid: pid}
	writer.alive.Store(true)
	return writer
}

type termination struct {
	pid    int
	reason string
}

// recorder 记录终止调用与轮询次数，避免测试真睡。
type recorder struct {
	mu           sync.Mutex
	terminations []termination
	polls        int
}

func (r *recorder) terminate(writer any, reason string) {
	target, ok := writer.(*testWriter)
	if !ok {
		return
	}
	r.mu.Lock()
	r.terminations = append(r.terminations, termination{pid: target.pid, reason: reason})
	r.mu.Unlock()
	target.alive.Store(false)
}

func (r *recorder) poll(time.Duration) {
	r.mu.Lock()
	r.polls++
	r.mu.Unlock()
}

func (r *recorder) terminationsCopy() []termination {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]termination(nil), r.terminations...)
}

func (r *recorder) pollCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.polls
}

// newCoordinator 对应 agy-warm-ls-pool 的接线：alive 看 pid，terminate 直接 kill。
func newCoordinator(rec *recorder) *Coordinator {
	return New(Options{
		IsWriterAlive: func(writer any) bool {
			target, ok := writer.(*testWriter)
			return ok && target.alive.Load()
		},
		TerminateWriter: rec.terminate,
		WaitForPoll:     rec.poll,
		PollInterval:    time.Millisecond,
	})
}

func waitForClose(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("quiescence did not complete within 2s")
	}
}

func requireClosed(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	default:
		t.Fatal("expected quiescence to be already complete")
	}
}

func mustReserve(t *testing.T, coordinator *Coordinator, accountRef string) *Lease {
	t.Helper()
	lease, err := coordinator.Reserve(accountRef)
	if err != nil {
		t.Fatalf("Reserve(%q) error = %v", accountRef, err)
	}
	return lease
}

func TestReserveRequiresAccountRef(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	for _, accountRef := range []string{"", "   ", "\t\n"} {
		if _, err := coordinator.Reserve(accountRef); !errors.Is(err, ErrAccountRefRequired) {
			t.Fatalf("Reserve(%q) error = %v, want %v", accountRef, err, ErrAccountRefRequired)
		}
	}
	// 空引用不留下账号状态：随后正常预留仍是第 1 代。
	if lease := mustReserve(t, coordinator, "acct"); lease.Generation() != 1 {
		t.Fatalf("generation = %d, want 1", lease.Generation())
	}
}

func TestLeaseNormalizesAccountRef(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	lease := mustReserve(t, coordinator, "  acct-1 \t")
	if lease.AccountRef() != "acct-1" {
		t.Fatalf("account ref = %q, want %q", lease.AccountRef(), "acct-1")
	}
	if !coordinator.HasWriter("acct-1") || !coordinator.HasWriter(" acct-1 ") {
		t.Fatal("normalized account ref must address the same state")
	}
}

func TestReserveGenerationPerAccount(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	if first := mustReserve(t, coordinator, "a"); first.Generation() != 1 {
		t.Fatalf("a generation = %d, want 1", first.Generation())
	}
	if second := mustReserve(t, coordinator, "a"); second.Generation() != 2 {
		t.Fatalf("a generation = %d, want 2", second.Generation())
	}
	if other := mustReserve(t, coordinator, "b"); other.Generation() != 1 {
		t.Fatalf("b generation = %d, want 1", other.Generation())
	}
}

func TestActivateBindsWriter(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	lease := mustReserve(t, coordinator, "acct")

	if coordinator.Activate(nil, newTestWriter(1)) {
		t.Fatal("Activate(nil) = true, want false")
	}
	if coordinator.Activate(&Lease{accountRef: "acct"}, newTestWriter(1)) {
		t.Fatal("Activate(unknown lease) = true, want false")
	}
	if coordinator.Activate(lease, nil) {
		t.Fatal("Activate(nil writer) = true, want false")
	}
	var typedNil *testWriter
	if coordinator.Activate(lease, typedNil) {
		t.Fatal("Activate(typed nil writer) = true, want false")
	}

	first := newTestWriter(1)
	if !coordinator.Activate(lease, first) {
		t.Fatal("Activate(pending lease) = false, want true")
	}
	first.alive.Store(false)
	if coordinator.HasWriter("acct") {
		t.Fatal("dead live writer must not count as writer")
	}
	// 重复 activate 覆盖 writer（Node 同分支直接赋值）。
	second := newTestWriter(2)
	if !coordinator.Activate(lease, second) {
		t.Fatal("Activate(live lease) = false, want true")
	}
	if !coordinator.HasWriter("acct") {
		t.Fatal("re-activated live writer must count as writer")
	}
}

func TestReleaseUnknownLease(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	lease := mustReserve(t, coordinator, "acct")

	if coordinator.Release(nil) {
		t.Fatal("Release(nil) = true, want false")
	}
	if coordinator.Release(&Lease{}) {
		t.Fatal("Release(zero lease) = true, want false")
	}
	foreign := newCoordinator(&recorder{})
	if foreign.Release(lease) {
		t.Fatal("Release(foreign lease) = true, want false")
	}
	if !coordinator.HasWriter("acct") {
		t.Fatal("foreign release must not touch this coordinator state")
	}
	if coordinator.Activate(lease, newTestWriter(1)); !coordinator.Release(lease) {
		t.Fatal("Release(live lease) = false, want true")
	}
	if coordinator.Activate(lease, newTestWriter(2)) {
		t.Fatal("Activate(released lease) = true, want false")
	}
}

func TestReleaseReportsFinalWriterOnce(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	lease := mustReserve(t, coordinator, "acct")
	if !coordinator.Release(lease) {
		t.Fatal("first Release = false, want true")
	}
	if coordinator.Release(lease) {
		t.Fatal("second Release = true, want false")
	}
}

func TestReleaseNotFinalWhenNewerWriterPending(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	older := mustReserve(t, coordinator, "acct")
	newer := mustReserve(t, coordinator, "acct")
	if coordinator.Release(older) {
		t.Fatal("release of older lease with newer record = true, want false")
	}
	if !coordinator.Release(newer) {
		t.Fatal("release of newest lease = false, want true")
	}
}

func TestReleaseNotFinalWhileAnotherWriterAlive(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	live := mustReserve(t, coordinator, "acct")
	if !coordinator.Activate(live, newTestWriter(1)) {
		t.Fatal("Activate() = false, want true")
	}
	released := mustReserve(t, coordinator, "acct")
	releasedWriter := newTestWriter(2)
	releasedWriter.alive.Store(false)
	if !coordinator.Activate(released, releasedWriter) {
		t.Fatal("Activate() = false, want true")
	}
	if coordinator.Release(released) {
		t.Fatal("release while another live writer exists = true, want false")
	}
	if !coordinator.Release(live) {
		t.Fatal("release of last active writer = false, want true")
	}
}

func TestReleaseTreatsDeadWriterAsInactive(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	dead := mustReserve(t, coordinator, "acct")
	deadWriter := newTestWriter(1)
	deadWriter.alive.Store(false)
	coordinator.Activate(dead, deadWriter)
	newest := mustReserve(t, coordinator, "acct")
	if !coordinator.Release(newest) {
		t.Fatal("release with only dead live writer = false, want true")
	}
	if coordinator.Release(dead) {
		t.Fatal("older release after coordinated generation = true, want false")
	}
}

func TestReleaseCoordinatedGenerationOnlyMovesForward(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	first := mustReserve(t, coordinator, "acct")
	firstWriter := newTestWriter(1)
	firstWriter.alive.Store(false)
	coordinator.Activate(first, firstWriter)
	second := mustReserve(t, coordinator, "acct")
	secondWriter := newTestWriter(2)
	secondWriter.alive.Store(false)
	coordinator.Activate(second, secondWriter)

	if !coordinator.Release(second) {
		t.Fatal("release of newest = false, want true")
	}
	if coordinator.Release(first) {
		t.Fatal("older release after newer coordinated = true, want false")
	}
}

func TestHasWriter(t *testing.T) {
	coordinator := newCoordinator(&recorder{})
	if coordinator.HasWriter("acct") {
		t.Fatal("unknown account must not have writer")
	}
	pending := mustReserve(t, coordinator, "acct")
	if !coordinator.HasWriter("acct") {
		t.Fatal("pending lease must count as writer")
	}
	coordinator.Activate(pending, newTestWriter(1))
	if !coordinator.HasWriter("acct") {
		t.Fatal("live writer must count as writer")
	}
	coordinator.Release(pending)
	if coordinator.HasWriter("acct") {
		t.Fatal("released writer must not count as writer")
	}
}

func TestCanReconcileBeforeSpawn(t *testing.T) {
	t.Run("unknown lease", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		if coordinator.CanReconcileBeforeSpawn(nil) {
			t.Fatal("nil lease = true, want false")
		}
		if coordinator.CanReconcileBeforeSpawn(&Lease{}) {
			t.Fatal("unknown lease = true, want false")
		}
	})

	t.Run("released lease", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		lease := mustReserve(t, coordinator, "acct")
		coordinator.Release(lease)
		if coordinator.CanReconcileBeforeSpawn(lease) {
			t.Fatal("released lease = true, want false")
		}
	})

	t.Run("live lease", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		lease := mustReserve(t, coordinator, "acct")
		coordinator.Activate(lease, newTestWriter(1))
		if coordinator.CanReconcileBeforeSpawn(lease) {
			t.Fatal("live lease = true, want false")
		}
	})

	t.Run("sole pending lease", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		lease := mustReserve(t, coordinator, "acct")
		if !coordinator.CanReconcileBeforeSpawn(lease) {
			t.Fatal("sole pending lease = false, want true")
		}
	})

	t.Run("older pending blocks", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		mustReserve(t, coordinator, "acct")
		newer := mustReserve(t, coordinator, "acct")
		if coordinator.CanReconcileBeforeSpawn(newer) {
			t.Fatal("older pending record = true, want false")
		}
	})

	t.Run("newer pending does not block", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		older := mustReserve(t, coordinator, "acct")
		mustReserve(t, coordinator, "acct")
		if !coordinator.CanReconcileBeforeSpawn(older) {
			t.Fatal("newer pending record = false, want true")
		}
	})

	t.Run("live writer blocks", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		live := mustReserve(t, coordinator, "acct")
		coordinator.Activate(live, newTestWriter(1))
		pending := mustReserve(t, coordinator, "acct")
		if coordinator.CanReconcileBeforeSpawn(pending) {
			t.Fatal("live writer present = true, want false")
		}
	})

	t.Run("dead live writer does not block", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		live := mustReserve(t, coordinator, "acct")
		dead := newTestWriter(1)
		dead.alive.Store(false)
		coordinator.Activate(live, dead)
		pending := mustReserve(t, coordinator, "acct")
		if !coordinator.CanReconcileBeforeSpawn(pending) {
			t.Fatal("dead live writer = false, want true")
		}
	})

	t.Run("quiescing blocks", func(t *testing.T) {
		gate := make(chan struct{})
		coordinator := New(Options{
			IsWriterAlive:   func(writer any) bool { return writer.(*testWriter).alive.Load() },
			TerminateWriter: func(any, string) {},
			WaitForPoll:     func(time.Duration) { <-gate },
			PollInterval:    time.Millisecond,
		})
		live := mustReserve(t, coordinator, "acct")
		writer := newTestWriter(1)
		coordinator.Activate(live, writer)
		done := coordinator.Quiesce("acct", QuiesceOptions{Reason: "idle"})
		pending := mustReserve(t, coordinator, "acct")
		if coordinator.CanReconcileBeforeSpawn(pending) {
			t.Fatal("quiescing account = true, want false")
		}
		writer.alive.Store(false)
		close(gate)
		waitForClose(t, done)
	})
}

func TestQuiesceWithoutWriterCompletesImmediately(t *testing.T) {
	t.Run("empty account ref", func(t *testing.T) {
		coordinator := newCoordinator(&recorder{})
		requireClosed(t, coordinator.Quiesce("   ", QuiesceOptions{}))
	})

	t.Run("pending record without writer", func(t *testing.T) {
		rec := &recorder{}
		coordinator := newCoordinator(rec)
		lease := mustReserve(t, coordinator, "acct")
		requireClosed(t, coordinator.Quiesce("acct", QuiesceOptions{Lease: lease}))
		if len(rec.terminationsCopy()) != 0 {
			t.Fatal("pending record without writer must not be terminated")
		}
		// cleanState 保留 pending 记录，账号状态与 generation 继续存在。
		if !coordinator.HasWriter("acct") {
			t.Fatal("pending record must keep the account state")
		}
		if next := mustReserve(t, coordinator, "acct"); next.Generation() != 2 {
			t.Fatalf("generation = %d, want 2", next.Generation())
		}
	})

	t.Run("already dead writer", func(t *testing.T) {
		rec := &recorder{}
		coordinator := newCoordinator(rec)
		lease := mustReserve(t, coordinator, "acct")
		dead := newTestWriter(1)
		dead.alive.Store(false)
		coordinator.Activate(lease, dead)
		requireClosed(t, coordinator.Quiesce("acct", QuiesceOptions{Lease: lease}))
		if len(rec.terminationsCopy()) != 0 {
			t.Fatal("dead writer must not be terminated")
		}
		if coordinator.HasWriter("acct") {
			t.Fatal("dead live writer must not count as writer")
		}
	})
}

func TestQuiesceTerminatesAndWaitsForExit(t *testing.T) {
	rec := &recorder{}
	coordinator := newCoordinator(rec)
	lease := mustReserve(t, coordinator, "acct")
	coordinator.Activate(lease, newTestWriter(7))

	waitForClose(t, coordinator.Quiesce("acct", QuiesceOptions{Lease: lease, Reason: "idle"}))

	terminations := rec.terminationsCopy()
	if len(terminations) != 1 || terminations[0].pid != 7 || terminations[0].reason != "idle" {
		t.Fatalf("terminations = %+v, want one kill of pid 7 with reason idle", terminations)
	}
	if coordinator.IsQuiescing("acct") {
		t.Fatal("quiescing must be cleared after writer exit")
	}
	if coordinator.HasWriter("acct") {
		t.Fatal("dead writer must not count as writer")
	}
	// 静默本身不释放租约（Node 里由 child.onExit 调 releaseWriter），记录仍在。
	if !coordinator.Release(lease) {
		t.Fatal("Release() after writer death = false, want true")
	}
	if next := mustReserve(t, coordinator, "acct"); next.Generation() != 1 {
		t.Fatalf("generation = %d, want 1 after state cleanup", next.Generation())
	}
}

func TestQuiesceUsesDefaultReason(t *testing.T) {
	rec := &recorder{}
	coordinator := newCoordinator(rec)
	lease := mustReserve(t, coordinator, "acct")
	coordinator.Activate(lease, newTestWriter(1))
	waitForClose(t, coordinator.Quiesce("acct", QuiesceOptions{Lease: lease}))
	if reason := rec.terminationsCopy()[0].reason; reason != defaultQuiesceReason {
		t.Fatalf("reason = %q, want %q", reason, defaultQuiesceReason)
	}
}

func TestQuiesceSwallowsTerminatePanic(t *testing.T) {
	var polls atomic.Int32
	writer := newTestWriter(1)
	coordinator := New(Options{
		IsWriterAlive: func(any) bool { return writer.alive.Load() },
		TerminateWriter: func(any, string) {
			panic("kill failed")
		},
		WaitForPoll: func(time.Duration) {
			if polls.Add(1) >= 3 {
				writer.alive.Store(false)
			}
		},
		PollInterval: time.Millisecond,
	})
	lease := mustReserve(t, coordinator, "acct")
	coordinator.Activate(lease, writer)
	waitForClose(t, coordinator.Quiesce("acct", QuiesceOptions{Lease: lease}))
	if polls.Load() < 3 {
		t.Fatalf("polls = %d, want >= 3 (quiescence must survive a failed kill)", polls.Load())
	}
	if coordinator.IsQuiescing("acct") {
		t.Fatal("quiescing must be cleared after the writer finally exits")
	}
}

func TestQuiesceSharesInFlightFlow(t *testing.T) {
	gate := make(chan struct{})
	var terminations atomic.Int32
	writer := newTestWriter(1)
	coordinator := New(Options{
		IsWriterAlive: func(any) bool { return writer.alive.Load() },
		TerminateWriter: func(any, string) {
			terminations.Add(1)
		},
		WaitForPoll:  func(time.Duration) { <-gate },
		PollInterval: time.Millisecond,
	})
	lease := mustReserve(t, coordinator, "acct")
	coordinator.Activate(lease, writer)

	first := coordinator.Quiesce("acct", QuiesceOptions{Lease: lease, Reason: "idle"})
	second := coordinator.Quiesce("acct", QuiesceOptions{Lease: lease, Reason: "replacement"})
	if first != second {
		t.Fatal("repeat Quiesce must reuse the in-flight flow")
	}
	if !coordinator.IsQuiescing("acct") {
		t.Fatal("quiescing must be visible while the writer is still alive")
	}
	if !coordinator.HasWriter("acct") {
		t.Fatal("quiescing account must still report a writer")
	}
	if terminations.Load() != 1 {
		t.Fatalf("terminations = %d, want 1", terminations.Load())
	}

	writer.alive.Store(false)
	close(gate)
	waitForClose(t, first)
	if coordinator.IsQuiescing("acct") {
		t.Fatal("quiescing must be cleared after writer exit")
	}
}

func TestQuiesceUsesRecordWriterWhenWriterOmitted(t *testing.T) {
	rec := &recorder{}
	coordinator := newCoordinator(rec)
	lease := mustReserve(t, coordinator, "acct")
	coordinator.Activate(lease, newTestWriter(11))
	waitForClose(t, coordinator.Quiesce("acct", QuiesceOptions{Lease: lease}))
	if terminations := rec.terminationsCopy(); len(terminations) != 1 || terminations[0].pid != 11 {
		t.Fatalf("terminations = %+v, want the record writer pid 11", terminations)
	}
}

func TestQuiesceExplicitWriterOverridesRecord(t *testing.T) {
	rec := &recorder{}
	coordinator := newCoordinator(rec)
	lease := mustReserve(t, coordinator, "acct")
	coordinator.Activate(lease, newTestWriter(11))
	waitForClose(t, coordinator.Quiesce("acct", QuiesceOptions{
		Lease:  lease,
		Writer: newTestWriter(22),
	}))
	if terminations := rec.terminationsCopy(); len(terminations) != 1 || terminations[0].pid != 22 {
		t.Fatalf("terminations = %+v, want the explicit writer pid 22", terminations)
	}
	// 记录里的 writer 仍存活：显式 writer 静默不影响它。
	if !coordinator.HasWriter("acct") {
		t.Fatal("record writer is still alive and must count as writer")
	}
}

func TestWaitQuiesceTimesOutWithoutStoppingQuiescence(t *testing.T) {
	gate := make(chan struct{})
	writer := newTestWriter(1)
	coordinator := New(Options{
		IsWriterAlive:   func(any) bool { return writer.alive.Load() },
		TerminateWriter: func(any, string) {},
		WaitForPoll:     func(time.Duration) { <-gate },
		PollInterval:    time.Millisecond,
	})
	lease := mustReserve(t, coordinator, "acct")
	coordinator.Activate(lease, writer)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if coordinator.WaitQuiesce(ctx, "acct", QuiesceOptions{Lease: lease}) {
		t.Fatal("WaitQuiesce with canceled context = true, want false")
	}
	if !coordinator.IsQuiescing("acct") {
		t.Fatal("timeout must not stop the background quiescence")
	}

	writer.alive.Store(false)
	close(gate)
	waitForClose(t, coordinator.Quiesce("acct", QuiesceOptions{Lease: lease}))
}

func TestQuiescePreservesAccountWhileWritersRemain(t *testing.T) {
	rec := &recorder{}
	coordinator := newCoordinator(rec)
	live := mustReserve(t, coordinator, "acct")
	coordinator.Activate(live, newTestWriter(1))
	pending := mustReserve(t, coordinator, "acct")

	waitForClose(t, coordinator.Quiesce("acct", QuiesceOptions{Lease: live, Reason: "shutdown"}))

	if !coordinator.HasWriter("acct") {
		t.Fatal("pending record must keep the account state after quiescence")
	}
	// pending 是唯一活跃 writer：释放它就是最终释放。
	if !coordinator.Release(pending) {
		t.Fatal("release of last pending = false, want true")
	}
	// 已退出 writer 的记录仍占着账号状态，generation 继续递增到 3。
	if next := mustReserve(t, coordinator, "acct"); next.Generation() != 3 {
		t.Fatalf("generation = %d, want 3", next.Generation())
	}
}

func TestConcurrentReserveProducesUniqueGenerations(t *testing.T) {
	const writers = 64
	coordinator := newCoordinator(&recorder{})
	generations := make(chan uint64, writers)

	var wait sync.WaitGroup
	for index := 0; index < writers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			lease, err := coordinator.Reserve("acct")
			if err != nil {
				t.Errorf("Reserve() error = %v", err)
				return
			}
			generations <- lease.Generation()
		}()
	}
	wait.Wait()
	close(generations)

	seen := make(map[uint64]bool, writers)
	for generation := range generations {
		if generation == 0 || generation > writers || seen[generation] {
			t.Fatalf("generation = %d out of range or duplicated", generation)
		}
		seen[generation] = true
	}
	if len(seen) != writers {
		t.Fatalf("unique generations = %d, want %d", len(seen), writers)
	}
	if next := mustReserve(t, coordinator, "acct"); next.Generation() != writers+1 {
		t.Fatalf("generation = %d, want %d", next.Generation(), writers+1)
	}
}

func TestLeaseNilAccessors(t *testing.T) {
	var lease *Lease
	if lease.AccountRef() != "" || lease.Generation() != 0 {
		t.Fatal("nil lease accessors must return zero values")
	}
}

func TestWaitQuiesceCompletesBeforeTimeout(t *testing.T) {
	rec := &recorder{}
	coordinator := newCoordinator(rec)
	lease := mustReserve(t, coordinator, "acct")
	coordinator.Activate(lease, newTestWriter(3))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !coordinator.WaitQuiesce(ctx, "acct", QuiesceOptions{Lease: lease}) {
		t.Fatal("WaitQuiesce() = false, want true after writer exit")
	}
	if terminations := rec.terminationsCopy(); len(terminations) != 1 || terminations[0].pid != 3 {
		t.Fatalf("terminations = %+v, want one kill of pid 3", terminations)
	}
}

func TestOptionsNormalization(t *testing.T) {
	tests := []struct {
		name             string
		pollInterval     time.Duration
		wantPollInterval time.Duration
	}{
		{name: "zero falls back to 25ms", pollInterval: 0, wantPollInterval: 25 * time.Millisecond},
		{name: "negative floors at 1ms", pollInterval: -5 * time.Second, wantPollInterval: time.Millisecond},
		{name: "sub-millisecond floors at 1ms", pollInterval: 500 * time.Microsecond, wantPollInterval: time.Millisecond},
		{name: "explicit interval is kept", pollInterval: 40 * time.Millisecond, wantPollInterval: 40 * time.Millisecond},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			coordinator := New(Options{PollInterval: test.pollInterval})
			if coordinator.pollInterval != test.wantPollInterval {
				t.Fatalf("poll interval = %s, want %s", coordinator.pollInterval, test.wantPollInterval)
			}
			if coordinator.isWriterAlive("anything") {
				t.Fatal("default IsWriterAlive must report false")
			}
			coordinator.terminateWriter("anything", "reason")
			coordinator.waitForPoll(0)
			// Node 的 !writer 只排除 null/undefined；非指针值不算空 writer。
			if isNilWriter(42) {
				t.Fatal("scalar writer must not be treated as nil")
			}
			if !isNilWriter((*testWriter)(nil)) {
				t.Fatal("typed nil writer must be treated as nil")
			}
		})
	}
}
