package accountbrowserhost

import (
	"context"
	"time"
)

// Shutdown signals only the positively owned dedicated process group. It never
// deletes browser data. Cancellation/uncertain cleanup retains ownership and
// the active marker; callers can retry Shutdown, not start another host.
func (s *Supervisor) Shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer func() { <-s.gate }()
	p := s.current
	if p == nil {
		if s.stranded != nil {
			if err := s.stranded.release(true); err != nil {
				return err
			}
			s.stranded = nil
		}
		return nil
	}
	status := s.Status()
	s.state("stopping", status.PID, status.Browser)
	select {
	case <-p.done:
	default:
		if err := p.identity.signal(false); err != nil {
			s.state("failed", status.PID, status.Browser)
			return err
		}
	}
	grace := time.NewTimer(3 * time.Second)
	defer grace.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-p.done:
	case <-grace.C:
		if err := p.identity.signal(true); err != nil {
			s.state("failed", status.PID, status.Browser)
			return err
		}
		select {
		case <-p.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	// Helpers may take a little longer than the root to leave its group. Once
	// root identity disappears, do not signal a possibly reused group number.
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		if p.family == nil {
			s.state("failed", status.PID, status.Browser)
			return ErrRecoveryRequired
		}
		empty, err := p.family.empty()
		if err != nil {
			s.state("failed", status.PID, status.Browser)
			return err
		}
		if empty {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			s.state("failed", status.PID, status.Browser)
			return ErrRecoveryRequired
		case <-ticker.C:
		}
	}
	if err := p.storage.release(true); err != nil {
		s.state("failed", status.PID, status.Browser)
		return err
	}
	p.family.close()
	s.current = nil
	s.state("stopped", 0, status.Browser)
	return nil
}
