package peer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	dispatchWatchdog = 60 * time.Second
	dispatchDebounce = 150 * time.Millisecond
)

// Only Start owns watchers/timers. Manual Tick and the deterministic test clock
// keep their old semantics. Events request a normal, fenced Tick, never a send.
func (d *DispatchDaemon) loopDispatchWakeups(ctx context.Context) {
	var watcher *fsnotify.Watcher
	var events <-chan fsnotify.Event
	var watchErrors <-chan error
	var inputs map[string]os.FileInfo
	closeWatch := func(err error) {
		if watcher != nil {
			_ = watcher.Close()
			watcher = nil
		}
		events, watchErrors = nil, nil
		d.mu.Lock()
		d.watching = false
		if err != nil {
			// Keep the last watcher failure observable even after recovery.
			d.watchError = err.Error()
		}
		d.mu.Unlock()
	}
	defer func() { closeWatch(nil) }()
	openWatch := func() {
		if watcher != nil || ctx.Err() != nil {
			return
		}
		var err error
		watcher, err = d.newDispatchWatcher()
		if err != nil {
			closeWatch(err)
			return
		}
		events, watchErrors = watcher.Events, watcher.Errors
		d.mu.Lock()
		d.watching = true
		d.mu.Unlock()
	}
	openWatch()

	timer := time.NewTimer(0) // One startup Tick, only on the real Start path.
	defer timer.Stop()
	var debounce *time.Timer
	var debounceC <-chan time.Time
	stopDebounce := func() {
		if debounce != nil {
			debounce.Stop()
		}
		debounce, debounceC = nil, nil
	}
	defer stopDebounce()
	reason := "startup"
	d.setDispatchWake(d.now().UnixMilli(), reason)
	queueEvent := func() {
		// A bounded window, not an endlessly reset trailing-edge debounce.
		if debounce == nil {
			debounce = time.NewTimer(dispatchDebounce)
			debounceC = debounce.C
			at := d.now().Add(dispatchDebounce).UnixMilli()
			d.mu.Lock()
			if d.nextWakeAt == 0 || at < d.nextWakeAt {
				d.nextWakeAt, d.wakeupReason = at, "filesystem"
			}
			d.mu.Unlock()
		}
	}
	run := func(wakeReason string) {
		stopDebounce()
		if ctx.Err() != nil {
			return
		}
		d.setDispatchWake(0, wakeReason)
		openWatch()        // Retry unavailable/replaced watches on the next real wake.
		_, _ = d.Tick(ctx) // Tick records errors and excludes concurrent owners.
		if ctx.Err() != nil {
			return
		}
		// Snapshot after the write-producing Tick, before planning. Buffered
		// notifications for these exact file versions are our own echoes. A
		// later external replacement/write still differs and requests a Tick.
		var snapshotErr error
		inputs, snapshotErr = d.dispatchInputSnapshot(ctx)
		delay, nextReason, err := d.nextDispatchDelay(ctx)
		err = errors.Join(snapshotErr, err)
		d.mu.Lock()
		d.wakeupError = ""
		if err != nil {
			d.wakeupError = err.Error()
		}
		d.mu.Unlock()
		reason = nextReason
		// Stop also discards an already elapsed old deadline before resetting.
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(delay)
		d.setDispatchWake(d.now().Add(delay).UnixMilli(), reason)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				closeWatch(errors.New("peer_dispatch_watch_closed"))
				queueEvent()
				continue
			}
			relevant, topology := d.dispatchWatchEvent(event)
			if topology {
				closeWatch(fmt.Errorf("peer_dispatch_watch_replaced: %s", event.Name))
			}
			if relevant && (topology || dispatchInputChanged(event.Name, inputs)) {
				queueEvent()
			}
		case err, ok := <-watchErrors:
			if !ok {
				err = errors.New("peer_dispatch_watch_errors_closed")
			}
			closeWatch(fmt.Errorf("peer_dispatch_watch: %w", err))
			queueEvent() // Full reconciliation after overflow; watchdog if Add fails.
		case <-debounceC:
			run("filesystem")
		case <-timer.C:
			run(reason)
		}
	}
}

func (d *DispatchDaemon) setDispatchWake(at int64, reason string) {
	d.mu.Lock()
	d.nextWakeAt, d.wakeupReason = at, reason
	d.mu.Unlock()
}

func (d *DispatchDaemon) dispatchWatchPaths() []string {
	root := d.store.Root()
	return []string{root, filepath.Join(root, "pending"), filepath.Join(root, "inflight"),
		filepath.Join(root, "receipts"), filepath.Join(root, "targets")}
}

func (d *DispatchDaemon) newDispatchWatcher() (*fsnotify.Watcher, error) {
	if err := d.store.EnsureLayout(); err != nil {
		return nil, fmt.Errorf("peer_dispatch_watch_layout: %w", err)
	}
	// Buffered events let a batch finish without losing its atomic rename events.
	watcher, err := fsnotify.NewBufferedWatcher(4096)
	if err != nil {
		return nil, fmt.Errorf("peer_dispatch_watch_open: %w", err)
	}
	for _, dir := range d.dispatchWatchPaths() {
		if err := watcher.Add(dir); err != nil {
			_ = watcher.Close()
			return nil, fmt.Errorf("peer_dispatch_watch_add %s: %w", dir, err)
		}
	}
	return watcher, nil
}

func (d *DispatchDaemon) dispatchWatchEvent(event fsnotify.Event) (relevant, topology bool) {
	// Ignore chmod, reads and atomic-write scratch files: they are not new work.
	if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) == 0 {
		return false, false
	}
	name := filepath.Clean(event.Name)
	for i, dir := range d.dispatchWatchPaths() {
		if name == dir {
			return true, event.Op&(fsnotify.Create|fsnotify.Remove|fsnotify.Rename) != 0
		}
		if i > 0 && filepath.Dir(name) == dir && strings.HasSuffix(name, ".json") {
			return true, false
		}
	}
	return false, false
}

// Compare file versions, not event counters: an atomic self rewrite can emit
// several late events. Ignoring versions already reconciled by Tick prevents
// them from draining a ready backlog faster than the configured batch interval.
func dispatchInputChanged(name string, inputs map[string]os.FileInfo) bool {
	if inputs == nil {
		return true
	}
	previous, existed := inputs[filepath.Clean(name)]
	current, err := os.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return existed
	}
	return err != nil || !existed || !os.SameFile(previous, current) ||
		previous.Size() != current.Size() || previous.Mode() != current.Mode() ||
		!previous.ModTime().Equal(current.ModTime())
}

func (d *DispatchDaemon) dispatchInputSnapshot(ctx context.Context) (map[string]os.FileInfo, error) {
	inputs := make(map[string]os.FileInfo)
	for _, dir := range d.dispatchWatchPaths()[1:] {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			info, err := entry.Info()
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			inputs[filepath.Join(dir, entry.Name())] = info
		}
	}
	return inputs, nil
}

// Planning reads pending/inflight only, never archive. The idle loop does no
// directory scans at all until an event/deadline or the 60s recovery watchdog.
func (d *DispatchDaemon) nextDispatchDelay(ctx context.Context) (time.Duration, string, error) {
	now := d.now()
	at, reason := now.Add(dispatchWatchdog).UnixMilli(), "watchdog"
	consider := func(candidate int64, why string) {
		if candidate > 0 && candidate < at {
			at, reason = candidate, why
		}
	}
	pending, err := d.store.ListPending()
	if err != nil {
		return dispatchWatchdog, "watchdog", err
	}
	inflight := make(map[string]int64)
	entries, err := os.ReadDir(filepath.Join(d.store.Root(), "inflight"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return dispatchWatchdog, "watchdog", err
	}
	for _, entry := range entries {
		if ctx.Err() != nil {
			return dispatchWatchdog, "watchdog", ctx.Err()
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		rec, err := d.store.readStoredRecord("inflight", strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			return dispatchWatchdog, "watchdog", err
		}
		var born int64
		if rec.Claim != nil {
			born = rec.Claim.ClaimedAt
		} else {
			info, err := entry.Info()
			if err != nil {
				return dispatchWatchdog, "watchdog", err
			}
			born = info.ModTime().UnixMilli()
		}
		if born <= 0 {
			return dispatchWatchdog, "watchdog", fmt.Errorf("peer_dispatch_inflight_time_invalid: %s", rec.ID)
		}
		due := born + d.store.inflightStale.Milliseconds()
		if due <= now.UnixMilli() {
			// Tick just tried orphan recovery. A still-stale generation (for
			// example an unreadable receipt) must not cause a 3s scan loop.
			due = now.Add(dispatchWatchdog).UnixMilli()
		}
		key := TargetKey(rec.To)
		if due > inflight[key] {
			inflight[key] = due
		}
		consider(due, "inflight_recovery")
	}
	for _, rec := range pending {
		if ctx.Err() != nil {
			return dispatchWatchdog, "watchdog", ctx.Err()
		}
		if rec.NotificationState != "ready" && rec.NotificationState != "waiting" {
			continue
		}
		gate, err := d.store.readTargetGate(rec.To)
		if err != nil {
			return dispatchWatchdog, "watchdog", err
		}
		due := max(rec.NextAttemptAt, gate.NextProbeAt, inflight[TargetKey(rec.To)])
		why := "target_deadline"
		if due <= now.UnixMilli() {
			// Remaining ready targets drain in fair bounded batches, not a burst.
			due, why = now.Add(d.interval).UnixMilli(), "ready_backlog"
		}
		consider(due, why)
		for _, deadline := range []int64{autoDeadline(rec), rec.ExpiresAt} {
			if deadline > now.UnixMilli() {
				consider(deadline, "message_deadline")
			}
		}
	}
	// Planning a large queue can itself take time. Subtract the current clock,
	// not the pre-scan clock, so reading 600 records cannot extend a deadline.
	delay := time.Duration(at-d.now().UnixMilli()) * time.Millisecond
	if delay < time.Millisecond {
		delay = time.Millisecond
	}
	return delay, reason, nil
}
