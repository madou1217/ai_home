package chatruntime

import (
	"context"
	"errors"
	"net/http"
	"os/exec"
	"time"
)

const (
	codexReconnectAttempts = 8
	codexReconnectDelay    = 500 * time.Millisecond
)

type codexRecoveryDialKey struct{}

type codexReconnectFlight struct {
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	previous *codexRPCDispatch
	err      error
}

func newCodexReconnectFlight(previous *codexRPCDispatch) *codexReconnectFlight {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	return &codexReconnectFlight{ctx: ctx, cancel: cancel, done: make(chan struct{}), previous: previous}
}

// WaitForRecovery never resends the failed request. Only future requests wait for restored bindings.
func (c *CodexAppServerClient) WaitForRecovery(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	c.mu.Lock()
	flight := c.recovery
	closed := c.closed || c.retiring
	c.mu.Unlock()
	if closed {
		return NewError("codex_app_server_closed", http.StatusGone, nil)
	}
	if flight == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-flight.done:
		return flight.err
	}
}

func codexRecoverableDisconnect(err error) bool {
	var failure *Error
	if errors.As(err, &failure) {
		return failure.Code == "codex_app_server_disconnected" || failure.Code == "codex_app_server_initialize_failed"
	}
	return false
}

// runReconnect is one bounded owner per client, not one task per binding/message.
// Previously accepted callbacks drain before a replacement connection publishes any event.
func (c *CodexAppServerClient) runReconnect(flight *codexReconnectFlight, initial error) {
	finalErr := initial
	defer func() {
		flight.cancel()
		c.mu.Lock()
		if c.recovery != flight {
			c.mu.Unlock()
			return
		}
		if len(c.bindings) == 0 && !c.closed && !c.retiring {
			finalErr = nil
		}
		flight.err = finalErr
		c.recovery = nil
		var failed []*codexTurnRegistration
		if finalErr != nil {
			for id, binding := range c.bindings {
				delete(c.bindings, id)
				failed = append(failed, binding)
			}
		}
		close(flight.done)
		idle := c.idleObserverLocked()
		c.mu.Unlock()
		for _, binding := range failed {
			if binding.active.Swap(false) && binding.binding.OnDisconnected != nil {
				binding.binding.OnDisconnected(finalErr)
			}
		}
		if idle != nil {
			idle()
		}
	}()
	if flight.previous != nil {
		select {
		case <-flight.ctx.Done():
			finalErr = flight.ctx.Err()
			return
		case <-flight.previous.done:
		}
	}
	for attempt := 1; attempt <= codexReconnectAttempts; attempt++ {
		c.mu.Lock()
		hasBindings := len(c.bindings) > 0
		closed := c.closed || c.retiring
		c.mu.Unlock()
		if !hasBindings {
			finalErr = nil
			return
		}
		if closed {
			finalErr = NewError("codex_app_server_closed", http.StatusGone, nil)
			return
		}
		timer := time.NewTimer(time.Duration(attempt) * codexReconnectDelay)
		select {
		case <-flight.ctx.Done():
			timer.Stop()
			finalErr = flight.ctx.Err()
			return
		case <-timer.C:
		}
		if c.opts.DiagnosticSink != nil {
			c.opts.DiagnosticSink(map[string]any{"code": "codex_reconnect_attempt", "attempt": attempt})
		}
		ctx, cancel := context.WithTimeout(context.WithValue(flight.ctx, codexRecoveryDialKey{}, true), c.requestTimeout)
		err := c.EnsureConnected(ctx)
		c.mu.Lock()
		target := c.cmd
		c.mu.Unlock()
		if err == nil {
			err = c.restoreReconnectBindings(ctx, flight)
		}
		if err == nil && c.commitReconnect(flight, target) {
			cancel()
			finalErr = nil
			return
		}
		cancel()
		if err == nil {
			err = NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
		}
		finalErr = err
		c.mu.Lock()
		cmd, dispatcher := c.cmd, c.dispatch
		c.mu.Unlock()
		if cmd != nil {
			_ = c.disconnectConnection(cmd, err, false)
		}
		if dispatcher != nil {
			select {
			case <-dispatcher.done:
			case <-flight.ctx.Done():
				finalErr = flight.ctx.Err()
				return
			}
		}
	}
}

func (c *CodexAppServerClient) restoreReconnectBindings(ctx context.Context, flight *codexReconnectFlight) error {
	c.mu.Lock()
	cmd, dispatcher := c.cmd, c.dispatch
	bindings := make(map[string]*codexTurnRegistration, len(c.bindings))
	for id, binding := range c.bindings {
		bindings[id] = binding
	}
	c.mu.Unlock()
	for threadID, binding := range bindings {
		if !c.currentRecoveryBinding(cmd, threadID, binding) {
			continue
		}
		if binding.binding.OnReconnectStart != nil {
			if err := binding.binding.OnReconnectStart(ctx); err != nil {
				c.failRecoveryBinding(threadID, binding, err)
				continue
			}
		}
		params := CloneMap(binding.binding.ResumeParams)
		if params == nil {
			params = map[string]any{"approvalPolicy": "untrusted", "sandbox": "workspace-write"}
		}
		params["threadId"] = threadID
		params["excludeTurns"] = false
		response, err := c.requestConnected(ctx, cmd, "thread/resume", params)
		if err != nil {
			return err
		}
		if !c.currentRecoveryBinding(cmd, threadID, binding) {
			continue
		}
		history := newCodexRecoveryHistory(c, cmd, threadID, binding, ctx)
		if binding.binding.RecoverHistory != nil {
			err = binding.binding.RecoverHistory(history.ctx, response, history)
		} else if binding.binding.OnReconnectResume != nil {
			binding.binding.OnReconnectResume(response, history)
		}
		history.expire()
		if err != nil {
			if !c.currentConnection(cmd) {
				return err
			}
			c.failRecoveryBinding(threadID, binding, err)
		}
	}
	if !c.currentConnection(cmd) {
		return NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	// Replay events can now progress. Ready callbacks may wait for interactions without blocking reader/worker.
	dispatcher.releaseGate()
	for threadID, binding := range bindings {
		if c.currentRecoveryBinding(cmd, threadID, binding) && binding.binding.OnReconnectReady != nil {
			if err := binding.binding.OnReconnectReady(ctx); err != nil {
				if !c.currentConnection(cmd) {
					return err
				}
				c.failRecoveryBinding(threadID, binding, err)
			}
		}
	}
	if !c.currentConnection(cmd) {
		return NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	return nil
}

func (c *CodexAppServerClient) currentConnection(cmd *exec.Cmd) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cmd == cmd && c.connected && c.ready && !c.closed
}
func (c *CodexAppServerClient) currentRecoveryBinding(cmd *exec.Cmd, id string, binding *codexTurnRegistration) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cmd == cmd && c.connected && c.bindings[id] == binding && binding.active.Load() && !c.closed
}
func (c *CodexAppServerClient) failRecoveryBinding(id string, binding *codexTurnRegistration, err error) {
	c.mu.Lock()
	same := c.bindings[id] == binding
	if same {
		delete(c.bindings, id)
	}
	c.mu.Unlock()
	if same && binding.active.Swap(false) && binding.binding.OnDisconnected != nil {
		binding.binding.OnDisconnected(err)
	}
}

func (d *codexRPCDispatch) releaseGate() {
	d.mu.Lock()
	d.gated = false
	d.ready.Signal()
	d.mu.Unlock()
}

// commitReconnect linearizes ready publication with disconnect; EOF either precedes this
// commit (same owner retries) or follows it (starts a new recovery), never an ownerless gap.
func (c *CodexAppServerClient) commitReconnect(flight *codexReconnectFlight, cmd *exec.Cmd) bool {
	c.mu.Lock()
	if c.recovery != flight || c.cmd != cmd || cmd == nil || !c.connected || !c.ready || c.closed || c.retiring || flight.ctx.Err() != nil {
		c.mu.Unlock()
		return false
	}
	c.recovery = nil
	flight.err = nil
	close(flight.done)
	idle := c.idleObserverLocked()
	c.mu.Unlock()
	if idle != nil {
		idle()
	}
	return true
}
