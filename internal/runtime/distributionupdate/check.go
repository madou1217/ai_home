package distributionupdate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/distributionrelease"
)

// Check updates only release hints; it never creates or changes an appointment.
// Source checkouts can use this even though Schedule refuses installation.
func (s *Service) Check(ctx context.Context) (Status, error) {
	ctx, done, err := s.operation(ctx)
	if err != nil {
		return Status{}, err
	}
	defer done()
	lease, err := s.acquire(ctx, "check.lock", false)
	if errors.Is(err, ErrLocked) {
		return Status{}, ErrCheckInProgress
	}
	if err != nil {
		return Status{}, err
	}
	defer lease.Close()
	checkCtx, cancel := context.WithTimeout(ctx, time.Minute)
	var info distributionrelease.ReleaseInfo
	code := ""
	if s.options.Check == nil {
		err, code = errors.New("release checker is not configured"), "check_unavailable"
	} else {
		info, err = s.options.Check(checkCtx)
		if err != nil {
			code = "check_failed"
		} else if !s.validRelease(info, false) {
			err, code = errors.New("release checker returned an invalid selection"), "invalid_release"
		}
	}
	if err == nil && checkCtx.Err() != nil {
		err, code = checkCtx.Err(), "check_failed"
	}
	cancel()
	// Record a cancelled/failed check without persisting arbitrary error text.
	persistCtx, persistCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer persistCancel()
	state, persistErr := s.transact(persistCtx, func(state *Status) (bool, error) {
		state.CheckedAt, state.NextCheckAt, state.CheckError = s.now(), s.now().Add(s.options.CheckInterval), code
		if err == nil {
			copy := info
			state.Latest = &copy
		}
		return true, nil
	})
	if persistErr != nil {
		return state, errors.Join(err, fmt.Errorf("persist release check: %w", persistErr))
	}
	return state, err
}
