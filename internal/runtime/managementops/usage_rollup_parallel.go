package managementops

import (
	"context"
	"sync"
)

type rollupChunkResult struct {
	hours []int64
	err   error
}

// materializeGapChunks joins all request-owned workers before returning. Each
// worker has its own strict pricing slot; only the database write phase is
// serialized by the existing store writer lock.
func (s *UsageStore) materializeGapChunks(ctx context.Context, startHour, endHour, chunkMS int64) ([]int64, error) {
	if endHour-startHour <= chunkMS {
		var cache rollupSyncPricingCache
		return s.materializeHourRange(ctx, startHour, endHour, nil, true, &cache)
	}
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	const workers = 3
	tasks := make(chan hourRange)
	results := make(chan rollupChunkResult, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var cache rollupSyncPricingCache
			for span := range tasks {
				if workerCtx.Err() != nil {
					return
				}
				hours, err := s.materializeHourRange(workerCtx, span.StartHour, span.EndHour, nil, true, &cache)
				select {
				case results <- rollupChunkResult{hours, err}:
				case <-workerCtx.Done():
					return
				}
				if err != nil {
					cancel()
					return
				}
			}
		}()
	}
	producerDone := make(chan struct{})
	go func() {
		defer close(producerDone)
		defer close(tasks)
		for h := startHour; h < endHour; h += chunkMS {
			next := min(endHour, h+chunkMS)
			select {
			case tasks <- hourRange{StartHour: h, EndHour: next}:
			case <-workerCtx.Done():
				return
			}
		}
	}()
	go func() { wg.Wait(); close(results) }()
	var invalidated []int64
	var firstErr error
	for result := range results {
		invalidated = append(invalidated, result.hours...)
		if firstErr == nil && result.err != nil {
			firstErr = result.err
		}
	}
	cancel()
	<-producerDone
	if firstErr != nil {
		return invalidated, firstErr
	}
	if err := ctx.Err(); err != nil {
		return invalidated, err
	}
	return invalidated, nil
}
