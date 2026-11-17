package chatruntime

import (
	"context"
	"errors"
	"strings"
	"time"
)

// InspectAccountRunsForDeletion verifies native exit and capture observations
// before the shared deletion coordinator releases any other owner.
func (s *Service) InspectAccountRunsForDeletion(ctx context.Context, provider, ref string) ([]ActiveRunSummary, error) {
	runs, err := s.ListActiveRuns(ctx, ListActiveRunsFilter{Provider: provider})
	if err != nil {
		return nil, err
	}
	out := []ActiveRunSummary{}
	for _, run := range runs {
		if run.AccountRef != ref {
			continue
		}
		if run.Mode == "native-session" {
			reg := s.getActiveRun(run.RunID)
			if reg == nil || reg.Quiesced == nil || reg.CleanupError == nil {
				return nil, errors.New("native_run_exit_unverifiable")
			}
		}
		out = append(out, run)
	}
	return out, nil
}

// AccountRunObservation retains owner signals for one deletion request. A run
// disappearing from registries cannot erase its pending/failed Capture result.
type AccountRunObservation struct {
	Run          ActiveRunSummary
	Quiesced     <-chan struct{}
	CleanupError func() error
}

func (s *Service) ObserveAccountRunsForDeletion(ctx context.Context, provider, ref string) ([]AccountRunObservation, error) {
	runs, err := s.InspectAccountRunsForDeletion(ctx, provider, ref)
	if err != nil {
		return nil, err
	}
	out := make([]AccountRunObservation, 0, len(runs))
	for _, run := range runs {
		observation := AccountRunObservation{Run: run}
		if run.Mode == "native-session" {
			reg := s.getActiveRun(run.RunID)
			if reg == nil || reg.Quiesced == nil || reg.CleanupError == nil {
				return nil, errors.New("native_run_exit_unverifiable")
			}
			observation.Quiesced = reg.Quiesced
			observation.CleanupError = reg.CleanupError
		}
		out = append(out, observation)
	}
	return out, nil
}

// AbortAccountRuns retains actual owner completion handles before AbortRun can
// remove registry entries. Unregistering a run is not process-exit evidence.
func (s *Service) AbortAccountRuns(ctx context.Context, provider, accountRef string) error {
	if s == nil || ctx == nil || strings.TrimSpace(accountRef) == "" {
		return errors.New("account_runtime_unverifiable")
	}
	runs, err := s.InspectAccountRunsForDeletion(ctx, provider, accountRef)
	if err != nil {
		return err
	}
	var targets []ActiveRunSummary
	quiescence := map[string]<-chan struct{}{}
	cleanupResults := map[string]func() error{}
	for _, run := range runs {
		if run.AccountRef != accountRef {
			continue
		}
		if run.Mode == "native-session" {
			registration := s.getActiveRun(run.RunID)
			if registration == nil || registration.Quiesced == nil || registration.CleanupError == nil {
				return errors.New("native_run_exit_unverifiable")
			}
			quiescence[run.RunID] = registration.Quiesced
			cleanupResults[run.RunID] = registration.CleanupError
		}
		targets = append(targets, run)
	}
	op, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	for _, run := range targets {
		if _, err := s.AbortRun(op, run.RunID); err != nil {
			return err
		}
	}
	for _, done := range quiescence {
		select {
		case <-done:
		case <-op.Done():
			return op.Err()
		}
	}
	for _, readResult := range cleanupResults {
		if err := readResult(); err != nil {
			return errors.Join(errors.New("native_capture_failed"), err)
		}
	}
	for {
		current, err := s.ListActiveRuns(op, ListActiveRunsFilter{Provider: provider})
		if err != nil {
			return err
		}
		busy := false
		for _, run := range current {
			if run.AccountRef == accountRef {
				busy = true
				break
			}
		}
		if !busy {
			return nil
		}
		select {
		case <-op.Done():
			return op.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}
