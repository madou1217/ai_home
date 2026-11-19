package managementops

import (
	"context"
	"runtime"
	"sync"
	"weak"
)

type rollupCoordinator struct {
	sem chan struct{}

	mu                  sync.Mutex
	readOnly            bool
	hasCachedForkDigest bool
	cachedForkRev       int64
	cachedForkDigest    int64
	cachedForks         []forkDescriptor
}

var rollupCoordRegistry = struct {
	mu    sync.Mutex
	items map[weak.Pointer[UsageStore]]*rollupCoordinator
}{
	items: make(map[weak.Pointer[UsageStore]]*rollupCoordinator),
}

func getRollupCoordinator(s *UsageStore) *rollupCoordinator {
	wp := weak.Make(s)
	rollupCoordRegistry.mu.Lock()
	if coord, ok := rollupCoordRegistry.items[wp]; ok {
		rollupCoordRegistry.mu.Unlock()
		return coord
	}
	coord := &rollupCoordinator{
		sem: make(chan struct{}, 1),
	}
	rollupCoordRegistry.items[wp] = coord
	rollupCoordRegistry.mu.Unlock()

	runtime.AddCleanup(s, func(k weak.Pointer[UsageStore]) {
		rollupCoordRegistry.mu.Lock()
		delete(rollupCoordRegistry.items, k)
		rollupCoordRegistry.mu.Unlock()
	}, wp)
	return coord
}

func (c *rollupCoordinator) acquireSync(ctx context.Context) error {
	if ctx == nil {
		c.sem <- struct{}{}
		return nil
	}
	select {
	case c.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *rollupCoordinator) releaseSync() {
	<-c.sem
}

func (c *rollupCoordinator) isReadOnly() bool {
	c.mu.Lock()
	ro := c.readOnly
	c.mu.Unlock()
	return ro
}

func (c *rollupCoordinator) invalidateForkCache() {
	c.mu.Lock()
	c.hasCachedForkDigest = false
	c.cachedForks = nil
	c.mu.Unlock()
}
