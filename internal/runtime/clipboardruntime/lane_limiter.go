package clipboardruntime

import (
	"context"
	"sync"
	"time"
)

// LaneLimiter bounds the total number of chunk requests across every active
// package. Capacity is adjustable from WebUI settings without restarting a
// transfer already in flight.
type LaneLimiter struct {
	mu       sync.Mutex
	capacity int
	active   int
}

func NewLaneLimiter(capacity int) *LaneLimiter {
	if capacity < 1 {
		capacity = 1
	}
	return &LaneLimiter{capacity: capacity}
}

func (l *LaneLimiter) SetCapacity(capacity int) {
	if l == nil || capacity < 1 {
		return
	}
	l.mu.Lock()
	l.capacity = capacity
	l.mu.Unlock()
}

func (l *LaneLimiter) Acquire(ctx context.Context) error {
	if l == nil {
		return nil
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		l.mu.Lock()
		if l.active < l.capacity {
			l.active++
			l.mu.Unlock()
			return nil
		}
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (l *LaneLimiter) Release() {
	if l == nil {
		return
	}
	l.mu.Lock()
	if l.active > 0 {
		l.active--
	}
	l.mu.Unlock()
}
