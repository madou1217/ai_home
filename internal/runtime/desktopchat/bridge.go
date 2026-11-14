package desktopchat

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"time"
)

func New(options Options) (*Bridge, error) {
	if options.Client == nil || options.ResolveTarget == nil || options.Emit == nil {
		return nil, failure("chat_bridge_invalid_options")
	}
	value := reflect.ValueOf(options.Client)
	if value.Kind() == reflect.Pointer && value.IsNil() {
		return nil, failure("chat_bridge_invalid_options")
	}
	if options.MaxSessions == 0 {
		options.MaxSessions = 32
	}
	if options.MaxBufferedEvents == 0 {
		options.MaxBufferedEvents = 512
	}
	if options.MaxBufferedBytes == 0 {
		options.MaxBufferedBytes = 4 << 20
	}
	if options.MaxSessions < 1 || options.MaxSessions > 256 || options.MaxBufferedEvents < 1 || options.MaxBufferedEvents > 4096 || options.MaxBufferedBytes < 1024 || options.MaxBufferedBytes > 32<<20 {
		return nil, failure("chat_bridge_invalid_options")
	}
	if options.OperationTimeout == 0 {
		options.OperationTimeout = 30 * time.Second
	}
	if options.CleanupTimeout == 0 {
		options.CleanupTimeout = 5 * time.Second
	}
	if options.OperationTimeout < 0 || options.CleanupTimeout < 0 {
		return nil, failure("chat_bridge_invalid_options")
	}
	temp := options.TempDir
	if temp == "" {
		temp = os.TempDir()
	}
	temp, err := filepath.Abs(temp)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	bridge := &Bridge{client: options.Client, resolve: options.ResolveTarget, emit: options.Emit, tempDir: temp, maxSessions: options.MaxSessions, maxEvents: options.MaxBufferedEvents, maxBytes: options.MaxBufferedBytes, operationTimeout: options.OperationTimeout, cleanupTimeout: options.CleanupTimeout, ctx: ctx, cancel: cancel, requests: map[string]*requestState{}, sessions: map[string]*sessionState{}, closeDone: make(chan struct{}), operations: make(chan struct{}, options.MaxSessions), outputWake: make(chan struct{}, 1), outputDone: make(chan struct{}), inflight: make(map[*requestState]struct{})}
	go bridge.deliver()
	return bridge, nil
}

// Handle accepts only the desktop command protocol. Errors are both returned
// and emitted once as sanitized chat.error envelopes; no raw runtime errors/keys.
func (bridge *Bridge) Handle(ctx context.Context, input map[string]any) error {
	if bridge == nil {
		return failure("chat_bridge_closed")
	}
	if ctx == nil {
		return failure("chat_context_required")
	}
	m, err := normalize(input)
	if err != nil {
		bridge.emitError(nil, m, err)
		return err
	}
	bridge.mu.Lock()
	closed := bridge.closed || bridge.ctx.Err() != nil
	bridge.mu.Unlock()
	if closed {
		return failure("chat_bridge_closed")
	}
	bridge.mu.Lock()
	requestBinding := bridge.requests[m.requestID]
	bridge.mu.Unlock()
	switch m.typ {
	case "chat.open":
		// The shared open call emits its own single failure, not once per waiter.
		return bridge.open(ctx, m)
	case "chat.submit":
		err = bridge.submit(ctx, m)
	case "chat.stop":
		err = bridge.stop(ctx, m)
	case "chat.close":
		err = bridge.closeRequest(m.requestID)
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		bridge.emitError(requestBinding, m, err)
	}
	return err
}
func (bridge *Bridge) operation(ctx, parent context.Context) (context.Context, func(), error) {
	select {
	case bridge.operations <- struct{}{}:
	default:
		return nil, nil, failure("chat_bridge_busy")
	}
	if parent == nil {
		parent = bridge.ctx
	}
	if parent.Err() != nil || ctx.Err() != nil {
		<-bridge.operations
		return nil, nil, context.Canceled
	}
	op, cancel := context.WithTimeout(parent, bridge.operationTimeout)
	stop := context.AfterFunc(ctx, cancel)
	return op, func() { stop(); cancel(); <-bridge.operations }, nil
}
func (bridge *Bridge) session(m message) (*sessionState, error) {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	entry := bridge.sessions[m.sessionID]
	if entry == nil || entry.request.requestID != m.requestID {
		return nil, failure("chat_session_identity_mismatch")
	}
	return entry, nil
}
func notify(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// Close cancels bridge-local work and unsubscribes, exactly like Node chat.close.
// Every created canonical session, including a late open, belongs to the shared
// Service and remains persisted. Only an explicit chat.stop may interrupt a turn.
// Emit must return promptly; Close never forcibly terminates a host callback.
func (bridge *Bridge) Close() error {
	if bridge == nil {
		return nil
	}
	bridge.mu.Lock()
	if bridge.closed {
		done := bridge.closeDone
		bridge.mu.Unlock()
		<-done
		return bridge.closeErr
	}
	bridge.closed = true
	bridge.cancel()
	entries := make([]*sessionState, 0, len(bridge.sessions))
	requests := make([]*requestState, 0, len(bridge.inflight))
	for request := range bridge.inflight {
		request.suppressed = true
		request.cancel()
		requests = append(requests, request)
	}
	for _, request := range bridge.requests {
		request.suppressed = true
		request.cancel()
	}
	for _, entry := range bridge.sessions {
		entries = append(entries, entry)
	}
	bridge.requests = map[string]*requestState{}
	bridge.sessions = map[string]*sessionState{}
	bridge.mu.Unlock()
	bridge.outputMu.Lock()
	bridge.output = nil
	bridge.outputBytes = 0
	bridge.outputMu.Unlock()
	for _, entry := range entries {
		bridge.detach(entry)
	}
	ctx, cancel := context.WithTimeout(context.Background(), bridge.cleanupTimeout)
	defer cancel()
	var waitErr error
	for _, request := range requests {
		select {
		case <-request.done:
		case <-ctx.Done():
			waitErr = ctx.Err()
		}
	}
	bridge.closeErr = waitErr
	close(bridge.closeDone)
	return waitErr
}
func (bridge *Bridge) closeRequest(requestID string) error {
	bridge.mu.Lock()
	request := bridge.requests[requestID]
	var entry *sessionState
	if request != nil {
		request.suppressed = true
		request.cancel()
		delete(bridge.requests, requestID)
		entry = request.entry
		if entry != nil {
			delete(bridge.sessions, entry.session.SessionID)
		}
	}
	bridge.mu.Unlock()
	if entry != nil {
		bridge.detach(entry)
	}
	return nil
}
func (bridge *Bridge) detach(entry *sessionState) {
	entry.cancel()
	entry.mu.Lock()
	entry.closed = true
	entry.queue = nil
	entry.queueBytes = 0
	entry.active = nil
	entry.pending = nil
	unsub := entry.unsubscribe
	entry.unsubscribe = nil
	entry.mu.Unlock()
	if unsub != nil {
		unsub()
	}
	notify(entry.wake)
}
