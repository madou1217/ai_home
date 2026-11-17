package distributionupdate

import (
	"context"
	"errors"
	"log"
	"time"
)

// Run checks after 30 seconds, then every 6 hours, and ticks every minute by
// default. It never implicitly calls Schedule. Cancellation closes this service,
// retaining queued/deferred appointments for restart recovery.
func (s *Service) Run(ctx context.Context) error {
	ctx, done, err := s.operation(ctx)
	if err != nil {
		return err
	}
	defer done()
	if !s.runMu.TryLock() {
		return errors.New("distribution update background loop is already running")
	}
	defer s.runMu.Unlock()
	defer s.Close()
	if _, err := s.transact(ctx, func(state *Status) (bool, error) {
		state.NextCheckAt = s.now().Add(s.options.StartupDelay)
		return true, nil
	}); err != nil {
		return err
	}
	checks := time.NewTimer(s.options.StartupDelay)
	defer checks.Stop()
	ticks := time.NewTicker(s.options.TickInterval)
	defer ticks.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-checks.C:
			if _, err := s.Check(ctx); err != nil && !errors.Is(err, ErrCheckInProgress) {
				s.backgroundError("check", err)
			}
			checks.Reset(s.options.CheckInterval)
		case <-ticks.C:
			if _, err := s.Tick(ctx); err != nil && !errors.Is(err, ErrWorkerBusy) && !errors.Is(err, ErrBusyUnknown) {
				s.backgroundError("tick", err)
			}
		}
	}
}

func (s *Service) backgroundError(operation string, err error) {
	if s.options.OnError != nil {
		s.options.OnError(err)
		return
	}
	// Error details from injected callbacks may contain credentials; durable state
	// carries bounded failure codes and the fallback log deliberately omits them.
	log.Printf("distribution update %s failed; inspect update status", operation)
}
