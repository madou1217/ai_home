package webuiterminalapi

import "github.com/madou1217/ai_home/internal/runtime/terminalsession"

// SessionSnapshots exposes read-only terminal state to the remote execution
// ledger. Output is never included.
func (handler *Handler) SessionSnapshots() []terminalsession.Snapshot {
	if handler == nil || handler.sessions == nil {
		return nil
	}
	return handler.sessions.List()
}

// KillSession terminates one terminal by id or session key.
func (handler *Handler) KillSession(ref string) error {
	if handler == nil || handler.sessions == nil {
		return terminalsession.ErrSessionNotFound
	}
	return handler.sessions.Kill(ref)
}
