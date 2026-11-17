package distributionupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/madou1217/ai_home/internal/runtime/distributionrelease"
)

// Tick may download or hand off only a due, explicitly confirmed appointment.
// One process-wide OS lease spans download through receipt reconciliation. A
// restarted process may reconcile/mark interrupted, but NEVER repeats an apply.
func (s *Service) Tick(ctx context.Context) (Status, error) {
	ctx, done, err := s.operation(ctx)
	if err != nil {
		return Status{}, err
	}
	defer done()
	if !s.workerMu.TryLock() {
		return Status{}, ErrWorkerBusy
	}
	defer s.workerMu.Unlock()
	if s.handoff != nil {
		state, err := s.transact(ctx, func(state *Status) (bool, error) { return s.reconcile(ctx, state, false, true), nil })
		if err == nil && (state.Schedule == nil || terminal(state.Schedule.Status)) {
			err = s.releaseHandoff()
		}
		return state, err
	}
	lease, err := s.acquire(ctx, "worker.lock", false)
	if errors.Is(err, ErrLocked) {
		return Status{}, ErrWorkerBusy
	}
	if err != nil {
		return Status{}, err
	}
	retainLease := false
	defer func() {
		if !retainLease {
			lease.Close()
		}
	}()
	state, err := s.transact(ctx, func(state *Status) (bool, error) { return s.reconcile(ctx, state, true, false), nil })
	if err != nil {
		return state, err
	}
	appointment := state.Schedule
	if appointment == nil || !pending(appointment.Status) || s.now().Before(appointment.NextAttemptAt) || s.now().Before(appointment.At) {
		return state, nil
	}
	id, fixed := appointment.ID, appointment.FixedReleaseInfo
	busy, reason, busyErr := s.hostBusy(ctx)
	if busy || busyErr != nil {
		return s.deferWork(ctx, id, reason, busyErr)
	}
	state, err = s.changeSchedule(ctx, id, func(schedule *ScheduledUpdate) (bool, error) {
		if !pending(schedule.Status) {
			return false, ErrScheduleActive
		}
		if !s.fixedValid(schedule) {
			failSchedule(schedule, "fixed_target_invalid", s.now())
			return true, nil
		}
		schedule.Status, schedule.Stage, schedule.Error, schedule.DeferredReason = StatusDownloading, StageDownload, "", ""
		schedule.StartedAt, schedule.UpdatedAt, schedule.FinishedAt = s.now(), s.now(), time.Time{}
		return true, nil
	})
	if err != nil || state.Schedule.Status != StatusDownloading {
		return state, err
	}
	if s.options.Download == nil || s.options.Apply == nil {
		return s.failWork(ctx, id, "worker_unavailable", errors.New("download or detached apply callback is unavailable"))
	}
	workCtx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	if root, err := privateRoot(s.downloadDir, true); err != nil {
		return s.failWork(ctx, id, "download_directory_unavailable", err)
	} else {
		root.Close()
	}
	artifact, err := s.options.Download(workCtx, fixed, s.downloadDir)
	if err != nil {
		return s.failWork(ctx, id, "download_failed", err)
	}
	if err := s.verifyDownload(workCtx, artifact, fixed); err != nil {
		return s.failWork(ctx, id, "download_verification_failed", err)
	}
	// Always hand the executor the canonical absolute path, not a downloader
	// callback's alternate spelling of the same file.
	artifact = filepath.Join(s.downloadDir, releaseFile(fixed))
	// Work can become busy during a long download; recheck immediately before
	// irreversible handoff. Unknown activity is never interpreted as idle.
	busy, reason, busyErr = s.hostBusy(workCtx)
	if busy || busyErr != nil {
		return s.deferWork(ctx, id, reason, busyErr)
	}
	state, err = s.changeSchedule(ctx, id, func(schedule *ScheduledUpdate) (bool, error) {
		if schedule.Status != StatusDownloading || !s.fixedValid(schedule) {
			return false, ErrScheduleActive
		}
		schedule.Status, schedule.Stage, schedule.ArtifactPath, schedule.UpdatedAt = StatusInstalling, StageInstall, artifact, s.now()
		return true, nil
	})
	if err != nil {
		return state, err
	}
	if err := workCtx.Err(); err != nil {
		return s.failWork(ctx, id, "installer_handoff_interrupted", err)
	}
	// Persist installing BEFORE the callback. A crash in this uncertainty window
	// becomes interrupted, never an automatic replay of the spawn operation.
	applyCtx, applyCancel := context.WithTimeout(workCtx, 30*time.Second)
	err = s.options.Apply(applyCtx, artifact)
	applyCancel()
	if err != nil {
		return s.failWork(ctx, id, "installer_handoff_failed", err)
	}
	// Keep the OS lease even if the post-spawn state write fails. The independent
	// worker may already be installing; only its durable receipt can settle this.
	s.handoff, s.handoffAt, retainLease = lease, s.now(), true
	persistCtx, persistCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer persistCancel()
	state, err = s.changeSchedule(persistCtx, id, func(schedule *ScheduledUpdate) (bool, error) {
		if terminal(schedule.Status) {
			return false, nil
		}
		if schedule.Status != StatusInstalling {
			return false, ErrInvalidState
		}
		schedule.HandedOffAt, schedule.UpdatedAt = s.handoffAt, s.handoffAt
		return true, nil // still installing; spawn success is not installation success
	})
	if err == nil && terminal(state.Schedule.Status) {
		err = s.releaseHandoff()
	}
	return state, err
}

func (s *Service) changeSchedule(ctx context.Context, id string, update func(*ScheduledUpdate) (bool, error)) (Status, error) {
	return s.transact(ctx, func(state *Status) (bool, error) {
		if state.Schedule == nil || state.Schedule.ID != id {
			return false, ErrInvalidState
		}
		return update(state.Schedule)
	})
}

func (s *Service) failWork(ctx context.Context, id, code string, cause error) (Status, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	state, err := s.changeSchedule(ctx, id, func(schedule *ScheduledUpdate) (bool, error) {
		if terminal(schedule.Status) {
			return false, nil
		}
		failSchedule(schedule, code, s.now())
		return true, nil
	})
	return state, errors.Join(cause, err)
}

func (s *Service) hostBusy(ctx context.Context) (bool, string, error) {
	if s.options.Busy == nil {
		return true, "busy_unknown", ErrBusyUnknown
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	busy, reason, err := s.options.Busy(ctx)
	if err != nil || ctx.Err() != nil {
		return true, "busy_unknown", ErrBusyUnknown
	}
	if busy {
		return true, safeBusyReason(reason), nil
	}
	return false, "", nil
}

func safeBusyReason(reason string) string {
	reason = strings.TrimSpace(reason)
	lower := strings.ToLower(reason)
	for _, sensitive := range []string{"://", "token", "bearer", "password", "secret", "authorization", "cookie", "api_key", "apikey"} {
		if strings.Contains(lower, sensitive) {
			return "busy"
		}
	}
	if reason == "" || len(reason) > 160 || strings.IndexFunc(reason, unicode.IsControl) >= 0 {
		return "busy"
	}
	return "busy: " + reason
}

func (s *Service) deferWork(ctx context.Context, id, reason string, cause error) (Status, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	state, err := s.changeSchedule(ctx, id, func(schedule *ScheduledUpdate) (bool, error) {
		if !pending(schedule.Status) && schedule.Status != StatusDownloading {
			return false, ErrScheduleActive
		}
		schedule.Status, schedule.Stage, schedule.DeferredReason = StatusDeferred, "", reason
		schedule.UpdatedAt, schedule.NextAttemptAt = s.now(), s.now().Add(s.options.DeferInterval)
		if schedule.NextAttemptAt.Before(schedule.At) {
			schedule.NextAttemptAt = schedule.At.UTC()
		}
		return true, nil
	})
	return state, errors.Join(cause, err)
}

func (s *Service) verifyDownload(ctx context.Context, path string, info distributionrelease.ReleaseInfo) error {
	absolute, err := filepath.Abs(path)
	if err != nil || !samePath(absolute, filepath.Join(s.downloadDir, releaseFile(info))) {
		return errors.New("downloader returned a path outside the fixed private artifact location")
	}
	root, err := privateRoot(s.downloadDir, false)
	if err != nil {
		return err
	}
	defer root.Close()
	before, err := root.Lstat(info.Artifact.File)
	if err != nil || !before.Mode().IsRegular() || before.Size() != info.Artifact.Bytes || !privatePermissions(before) {
		return errors.New("downloaded artifact is not a private regular file of the expected size")
	}
	file, err := root.Open(info.Artifact.File)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return errors.New("downloaded artifact changed while opening")
	}
	hash := sha256.New()
	n, err := io.Copy(hash, &ctxReader{ctx: ctx, reader: io.LimitReader(file, info.Artifact.Bytes+1)})
	if err != nil {
		return err
	}
	if n != info.Artifact.Bytes || hex.EncodeToString(hash.Sum(nil)) != info.Artifact.SHA256 {
		return fmt.Errorf("downloaded artifact failed bytes/SHA-256 validation")
	}
	return ctx.Err()
}
