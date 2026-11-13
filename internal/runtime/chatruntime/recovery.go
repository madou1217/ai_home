package chatruntime

import (
	"context"
	"strings"
	"sync"
)

// RecoveryCoordinator 在服务启动阶段并发发现并重新挂接未终结的会话轮次。
type RecoveryCoordinator struct {
	actors *ActorRegistry
	store  *PublishingStore

	mu        sync.Mutex
	bySession map[string]chan struct{}
	allDone   chan struct{}
	results   []*RecoveryState
}

// NewRecoveryCoordinator 构造重启恢复协调器。
func NewRecoveryCoordinator(actors *ActorRegistry, store *PublishingStore) *RecoveryCoordinator {
	ch := make(chan struct{})
	close(ch)
	return &RecoveryCoordinator{
		actors:    actors,
		store:     store,
		bySession: make(map[string]chan struct{}),
		allDone:   ch,
	}
}

// Start 扫描可恢复会话并在并发恢复结束后返回全部会话结果。
func (r *RecoveryCoordinator) Start(ctx context.Context) []*RecoveryState {
	r.StartAsync(ctx)
	_ = r.WaitForAll(ctx)
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*RecoveryState(nil), r.results...)
}

// StartAsync 异步触发扫描恢复并允许通过 WaitForAll / WaitForSession 等待完成。
func (r *RecoveryCoordinator) StartAsync(ctx context.Context) {
	candidates, err := r.store.ListRecoveryCandidates(ctx)
	if err != nil || len(candidates) == 0 {
		ch := make(chan struct{})
		close(ch)
		r.mu.Lock()
		r.bySession = make(map[string]chan struct{})
		r.allDone = ch
		r.results = nil
		r.mu.Unlock()
		return
	}
	allDone := make(chan struct{})
	sessionChs := make(map[string]chan struct{}, len(candidates))
	for _, sess := range candidates {
		sessionChs[sess.SessionID] = make(chan struct{})
	}
	results := make([]*RecoveryState, len(candidates))
	r.mu.Lock()
	r.bySession = sessionChs
	r.allDone = allDone
	r.results = nil
	r.mu.Unlock()

	var wg sync.WaitGroup
	for i, sess := range candidates {
		idx := i
		s := sess
		doneCh := sessionChs[s.SessionID]
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer close(doneCh)
			results[idx] = r.recoverOne(ctx, &s)
		}()
	}
	go func() {
		wg.Wait()
		r.mu.Lock()
		r.results = results
		close(allDone)
		r.mu.Unlock()
	}()
}

// WaitForSession 等待指定会话的重启恢复流程结束。
func (r *RecoveryCoordinator) WaitForSession(ctx context.Context, sessionID string) error {
	r.mu.Lock()
	ch := r.bySession[sessionID]
	r.mu.Unlock()
	if ch == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// WaitForAll 等待全部候选会话完成恢复收敛。
func (r *RecoveryCoordinator) WaitForAll(ctx context.Context) error {
	r.mu.Lock()
	ch := r.allDone
	r.mu.Unlock()
	if ch == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *RecoveryCoordinator) recoverOne(ctx context.Context, sess *Session) *RecoveryState {
	state, err := r.store.BeginRestartRecovery(ctx, sess.SessionID)
	if err != nil {
		r.actors.Dispose(sess.SessionID)
		_, _ = r.store.FailRestartRecovery(ctx, sess.SessionID, err)
		return nil
	}
	if state == nil || !state.Recoverable {
		return state
	}
	if err := requireRecoveryNativeSession(state.Session); err != nil {
		r.actors.Dispose(sess.SessionID)
		_, _ = r.store.FailRestartRecovery(ctx, sess.SessionID, err)
		return nil
	}
	if _, err := r.actors.Acquire(ctx, state.Session, state); err != nil {
		r.actors.Dispose(sess.SessionID)
		_, _ = r.store.FailRestartRecovery(ctx, sess.SessionID, err)
		return nil
	}
	finalState, err := r.store.ReadRestartRecovery(ctx, sess.SessionID)
	if err != nil {
		return state
	}
	return finalState
}

func requireRecoveryNativeSession(sess *Session) error {
	nativeID := ""
	if sess != nil && sess.RuntimeBinding != nil {
		nativeID, _ = sess.RuntimeBinding["nativeSessionId"].(string)
	}
	if strings.TrimSpace(nativeID) == "" {
		return NewError("chat_native_session_missing_during_recovery", 409, nil)
	}
	return nil
}
