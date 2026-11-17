package distributionupdate

import (
	"context"
	"errors"
	"time"
)

// Get reads shared state and reconciles actual installer/runtime receipts.
// It never checks the release source, downloads, or invokes Apply.
func (s *Service) Get(ctx context.Context) (Status, error) { return s.get(ctx) }

// Snapshot is suitable for the shared CLI/WebUI status endpoint. It reconciles
// actual installer receipts, but never checks the network or initiates work.
// Storage/lock failures are explicit in Status.Error, not an empty healthy state.
func (s *Service) Snapshot() Status {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	state, err := s.get(ctx)
	if err != nil {
		state.Current = s.currentSnapshot()
		state.Error = "state_unavailable"
		if errors.Is(err, ErrClosed) {
			state.Error = "service_closed"
		}
	}
	return state
}

func (s *Service) get(ctx context.Context) (Status, error) {
	ctx, done, err := s.operation(ctx)
	if err != nil {
		return Status{}, err
	}
	defer done()
	// A concurrent downloader owns the execution lock. Reads and cancellation
	// remain responsive via the separate, short-lived state transaction lock.
	if !s.workerMu.TryLock() {
		return s.transact(ctx, func(state *Status) (bool, error) { return s.reconcile(ctx, state, false, false), nil })
	}
	defer s.workerMu.Unlock()
	recoverAbandoned := false
	if s.handoff == nil {
		lease, lockErr := s.acquire(ctx, "worker.lock", false)
		if lockErr == nil {
			recoverAbandoned = true
			defer lease.Close()
		} else if !errors.Is(lockErr, ErrLocked) {
			return Status{}, lockErr
		}
	}
	state, err := s.transact(ctx, func(state *Status) (bool, error) {
		return s.reconcile(ctx, state, recoverAbandoned, s.handoff != nil), nil
	})
	if err == nil && s.handoff != nil && (state.Schedule == nil || terminal(state.Schedule.Status)) {
		err = s.releaseHandoff()
	}
	return state, err
}

func (s *Service) reconcile(ctx context.Context, state *Status, recoverAbandoned, ownsHandoff bool) bool {
	schedule := state.Schedule
	if schedule == nil {
		return false
	}
	// A delayed receipt can resolve a previously interrupted handoff; never
	// resolve it by spawning again. Download failures/cancelled work are excluded.
	if schedule.Stage == StageInstall && (running(schedule.Status) || schedule.Status == StatusFailed) {
		receiptCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		receipt, receiptErr := s.options.ReadReceipt(receiptCtx)
		matches := receiptErr == nil && receipt.State == "installed" && receipt.ReleaseVersion == schedule.Version &&
			receipt.Target == schedule.FixedReleaseInfo.Target && samePath(receipt.Home, s.options.Home) &&
			!schedule.StartedAt.IsZero() && !receipt.InstalledAt.Before(schedule.StartedAt)
		verified := matches && s.options.VerifyRuntime(receiptCtx, receipt) == nil
		cancel()
		if verified {
			schedule.Status, schedule.Error, schedule.DeferredReason = StatusSucceeded, "", ""
			schedule.UpdatedAt, schedule.FinishedAt = s.now(), s.now()
			return true
		}
		if running(schedule.Status) && recoverAbandoned {
			code := "interrupted_receipt_missing"
			if matches {
				code = "interrupted_runtime_unverified"
			}
			failSchedule(schedule, code, s.now())
			return true
		}
		if running(schedule.Status) && ownsHandoff {
			handoffAt := schedule.HandedOffAt
			if handoffAt.IsZero() {
				handoffAt = s.handoffAt
			}
			if !handoffAt.IsZero() && s.now().Sub(handoffAt) >= s.options.ReceiptTimeout {
				failSchedule(schedule, "installer_receipt_timeout", s.now())
				return true
			}
		}
	}
	if schedule.Status == StatusDownloading && recoverAbandoned {
		failSchedule(schedule, "interrupted_download", s.now())
		return true
	}
	if pending(schedule.Status) && !s.fixedValid(schedule) {
		failSchedule(schedule, "fixed_target_invalid_or_current_build_changed", s.now())
		return true
	}
	return false
}

func failSchedule(schedule *ScheduledUpdate, code string, now time.Time) {
	schedule.Status, schedule.Error, schedule.DeferredReason = StatusFailed, code, ""
	schedule.UpdatedAt, schedule.FinishedAt = now, now
}
