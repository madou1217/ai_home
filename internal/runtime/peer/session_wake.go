package peer

import (
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

// WakeSession is the host hook bridge port. The host validates normalized
// top-level completion before calling; this method never declares a target
// idle and never injects. Each subsequent delivery still performs live probes.
func (s *DispatchStore) WakeSession(provider, sessionID string) (int, error) {
	return s.wakeSession(provider, sessionID, 0)
}

func (s *DispatchStore) wakeSession(provider, sessionID string, eventAt int64) (int, error) {
	provider, sessionID = strings.TrimSpace(provider), strings.TrimSpace(sessionID)
	if provider == "" || sessionID == "" {
		return 0, ErrIdentityMismatch
	}
	pending, err := s.ListPending()
	if err != nil {
		return 0, err
	}
	seen := make(map[string]bool)
	count := 0
	for _, rec := range pending {
		if !strings.EqualFold(strings.TrimSpace(rec.To.Provider), provider) || strings.TrimSpace(rec.To.SessionID) != sessionID {
			continue
		}
		key := TargetKey(rec.To)
		if seen[key] {
			continue
		}
		seen[key] = true
		gate, err := s.readTargetGate(rec.To)
		if err != nil {
			return count, err
		}
		if eventAt > 0 && eventAt <= gate.LastProbeAt {
			continue
		}
		woke, err := s.wakeTarget(rec.To, "idle", eventAt)
		if err != nil {
			return count, err
		}
		if woke {
			count++
		}
	}
	return count, nil
}

// HandleSessionEvent accepts only explicit, identity-matched parent completion.
// Generic file changes, notLoaded/unknown and child SubagentStop cannot wake it.
func (s *DispatchStore) HandleSessionEvent(session sessionevents.Session, event sessionevents.Event) (int, error) {
	session = sessionevents.NormalizeSession(session)
	if session.Provider == "" || session.SessionID == "" {
		return 0, nil
	}
	if event.Provider != "" && !strings.EqualFold(event.Provider, session.Provider) {
		return 0, nil
	}
	if event.SessionID != "" && strings.TrimSpace(event.SessionID) != session.SessionID {
		return 0, nil
	}
	name, typ, phase := strings.ToLower(strings.TrimSpace(event.EventName)), strings.ToLower(strings.TrimSpace(event.Type)), strings.ToLower(strings.TrimSpace(event.Phase))
	for _, marker := range []string{name, typ, phase, strings.ToLower(strings.TrimSpace(event.Reason))} {
		if strings.Contains(marker, "subagent") || strings.Contains(marker, "sub-agent") ||
			strings.Contains(marker, "notloaded") || strings.Contains(marker, "not_loaded") || marker == "unknown" {
			return 0, nil
		}
	}
	completion := typ == "turn-completed" || typ == "session:turn-completed"
	topLevel := name == "stop" || name == "appserverturncompleted" || name == "afteragent"
	if !completion || !topLevel || event.At <= 0 {
		return 0, nil
	}
	return s.wakeSession(session.Provider, session.SessionID, event.At)
}

func (d *DispatchDaemon) HandleSessionEvent(session sessionevents.Session, event sessionevents.Event) (int, error) {
	if d == nil || d.store == nil {
		return 0, ErrStoreUnavailable
	}
	return d.store.HandleSessionEvent(session, event)
}
