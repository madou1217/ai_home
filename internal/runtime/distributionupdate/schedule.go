package distributionupdate

import (
	"context"
	"crypto/rand"
	"fmt"
	"time"
	_ "time/tzdata" // IANA zones must also work in self-contained Windows packages.
)

// Schedule is an explicit, confirmed restart-to-install command. The HTTP/CLI
// adapter must obtain user confirmation BEFORE invoking it. Automatic checks and
// Run never call Schedule. It freezes the last server-side checked ReleaseInfo;
// later checks cannot change that target. At may be immediate (up to one minute
// of transport delay); timezone must be an IANA location or UTC, never Local.
func (s *Service) Schedule(ctx context.Context, at time.Time, timezone string) (Status, error) {
	ctx, done, err := s.operation(ctx)
	if err != nil {
		return Status{}, err
	}
	defer done()
	if s.current.Source != "distribution" {
		return Status{}, ErrNotDistribution
	}
	if s.options.Download == nil || s.options.Apply == nil {
		return Status{}, fmt.Errorf("download and detached apply callbacks are required")
	}
	location, err := time.LoadLocation(timezone)
	if err != nil || timezone == "" || timezone == "Local" || at.IsZero() || at.Before(s.now().Add(-time.Minute)) {
		return Status{}, ErrInvalidSchedule
	}
	if _, err := s.get(ctx); err != nil {
		return Status{}, err
	}
	return s.transact(ctx, func(state *Status) (bool, error) {
		if state.Schedule != nil && !terminal(state.Schedule.Status) {
			return false, ErrScheduleActive
		}
		if state.Latest == nil || !s.validRelease(*state.Latest, true) {
			return false, ErrNoRelease
		}
		now := s.now()
		next := at.UTC()
		if next.Before(now) {
			next = now
		}
		state.Schedule = &ScheduledUpdate{
			ID: rand.Text(), Version: state.Latest.Version, FixedReleaseInfo: *state.Latest,
			At: at.In(location), Timezone: timezone, NextAttemptAt: next,
			Status: StatusQueued, Confirmed: true, CreatedAt: now, UpdatedAt: now,
		}
		return true, nil
	})
}

// Cancel changes only queued/deferred appointments. Downloading, installer
// handoff, and all terminal states cannot be cancelled or killed by this API.
func (s *Service) Cancel(ctx context.Context) (Status, error) {
	ctx, done, err := s.operation(ctx)
	if err != nil {
		return Status{}, err
	}
	defer done()
	return s.transact(ctx, func(state *Status) (bool, error) {
		if state.Schedule == nil || !pending(state.Schedule.Status) {
			return false, ErrNotCancellable
		}
		state.Schedule.Status, state.Schedule.DeferredReason = StatusCancelled, ""
		state.Schedule.UpdatedAt, state.Schedule.FinishedAt = s.now(), s.now()
		return true, nil
	})
}
