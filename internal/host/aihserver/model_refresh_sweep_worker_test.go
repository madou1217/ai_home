package aihserver

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// TestModelRefreshSweepWorkerRepeatsUntilClosed 验证 worker 延迟后周期重扫，Close 后不再执行。
func TestModelRefreshSweepWorkerRepeatsUntilClosed(t *testing.T) {
	t.Parallel()

	sweeper := &countingModelRefreshSweeper{calls: make(chan struct{}, 8)}
	worker, err := startModelRefreshSweepWorker(
		context.Background(),
		sweeper,
		time.Millisecond,
		time.Millisecond,
		nil,
	)
	if err != nil {
		t.Fatalf("startModelRefreshSweepWorker() error = %v", err)
	}
	for range 2 {
		select {
		case <-sweeper.calls:
		case <-time.After(5 * time.Second):
			t.Fatal("周期重扫未执行")
		}
	}
	if err := worker.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	closedAt := sweeper.count.Load()
	time.Sleep(20 * time.Millisecond)
	if sweeper.count.Load() != closedAt {
		t.Fatal("Close 后仍在重扫")
	}
}

// TestModelRefreshSweepWorkerRejectsInvalidSchedule 验证无界或缺失依赖不能启动。
func TestModelRefreshSweepWorkerRejectsInvalidSchedule(t *testing.T) {
	t.Parallel()

	sweeper := &countingModelRefreshSweeper{calls: make(chan struct{}, 1)}
	if _, err := startModelRefreshSweepWorker(context.Background(), sweeper, 0, time.Hour, nil); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("zero delay error = %v", err)
	}
	if _, err := startModelRefreshSweepWorker(context.Background(), nil, time.Minute, time.Hour, nil); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("nil sweeper error = %v", err)
	}
}

type countingModelRefreshSweeper struct {
	count atomic.Int64
	calls chan struct{}
}

func (sweeper *countingModelRefreshSweeper) Sweep(context.Context) error {
	sweeper.count.Add(1)
	select {
	case sweeper.calls <- struct{}{}:
	default:
	}
	return nil
}
