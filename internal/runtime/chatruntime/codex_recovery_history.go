package chatruntime

import (
	"context"
	"net/http"
	"os/exec"
	"sync/atomic"
)

// CodexHistoryClient deliberately exposes no turn mutation, binding or process lifecycle operations.
type CodexHistoryClient interface {
	Request(context.Context, string, any) (map[string]any, error)
}

type codexRecoveryHistory struct {
	owner    *CodexAppServerClient
	cmd      *exec.Cmd
	threadID string
	binding  *codexTurnRegistration
	ctx      context.Context
	cancel   context.CancelFunc
	active   atomic.Bool
}

func newCodexRecoveryHistory(owner *CodexAppServerClient, cmd *exec.Cmd, id string, binding *codexTurnRegistration, ctx context.Context) *codexRecoveryHistory {
	ctx, cancel := context.WithCancel(context.WithValue(ctx, codexRPCConnectionKey{}, cmd))
	h := &codexRecoveryHistory{owner: owner, cmd: cmd, threadID: id, binding: binding, ctx: ctx, cancel: cancel}
	h.active.Store(true)
	return h
}
func (h *codexRecoveryHistory) expire() { h.active.Store(false); h.cancel() }
func (h *codexRecoveryHistory) Request(ctx context.Context, method string, params any) (map[string]any, error) {
	if !h.active.Load() || !h.owner.currentRecoveryBinding(h.cmd, h.threadID, h.binding) {
		return nil, NewError("codex_recovery_port_expired", http.StatusConflict, nil)
	}
	if method != "thread/turns/list" && method != "thread/items/list" && method != "thread/goal/get" {
		return nil, NewError("codex_recovery_request_invalid", http.StatusForbidden, nil)
	}
	object, ok := params.(map[string]any)
	if !ok || asString(object["threadId"]) != h.threadID {
		return nil, NewError("codex_recovery_request_invalid", http.StatusForbidden, nil)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	call, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(h.ctx, cancel)
	defer stop()
	if err := h.ctx.Err(); err != nil {
		return nil, err
	}
	return h.owner.requestConnected(call, h.cmd, method, params)
}

// Legacy callback compatibility is fail-closed; new callbacks only receive CodexHistoryClient.
func (h *codexRecoveryHistory) EnsureConnected(context.Context) error {
	return NewError("codex_recovery_request_invalid", http.StatusForbidden, nil)
}
func (h *codexRecoveryHistory) Respond(context.Context, any, any) error {
	return NewError("codex_recovery_request_invalid", http.StatusForbidden, nil)
}
func (h *codexRecoveryHistory) RespondError(context.Context, any, int, string) error {
	return NewError("codex_recovery_request_invalid", http.StatusForbidden, nil)
}
func (h *codexRecoveryHistory) BindTurn(string, CodexTurnBinding) {}
func (h *codexRecoveryHistory) UnbindTurn(string)                 {}
func (h *codexRecoveryHistory) ReleaseThread(context.Context, string) error {
	return NewError("codex_recovery_request_invalid", http.StatusForbidden, nil)
}
func (h *codexRecoveryHistory) GetVerifiedAccountIdentity() *CodexVerifiedIdentity { return nil }
func (h *codexRecoveryHistory) GetVerifiedRuntimeHome() (CodexRuntimeHome, bool) {
	return CodexRuntimeHome{}, false
}
func (h *codexRecoveryHistory) Close() error {
	return NewError("codex_recovery_request_invalid", http.StatusForbidden, nil)
}
