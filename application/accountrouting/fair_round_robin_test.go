package accountrouting

import (
	"sync"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// TestFairRoundRobinSchedulerDistributesSequentialTickets 验证顺序票号均匀覆盖候选。
func TestFairRoundRobinSchedulerDistributesSequentialTickets(t *testing.T) {
	t.Parallel()

	modelID := mustSchedulerModelID(t, "gpt-5.6-sol")
	scheduler := &FairRoundRobinScheduler{}
	counts := make([]int, 3)
	for range 30 {
		counts[scheduler.NextStart("codex", modelID, len(counts))]++
	}
	for index, count := range counts {
		if count != 10 {
			t.Fatalf("candidate=%d count=%d distribution=%v", index, count, counts)
		}
	}
}

// TestFairRoundRobinSchedulerDistributesConcurrentTickets 验证并发票号无丢失或偏置。
func TestFairRoundRobinSchedulerDistributesConcurrentTickets(t *testing.T) {
	t.Parallel()

	const (
		candidateCount = 10
		requestCount   = 1_000
	)
	modelID := mustSchedulerModelID(t, "gpt-5.6-sol")
	scheduler := &FairRoundRobinScheduler{}
	results := make(chan int, requestCount)
	var waitGroup sync.WaitGroup
	waitGroup.Add(requestCount)
	for range requestCount {
		go func() {
			defer waitGroup.Done()
			results <- scheduler.NextStart("codex", modelID, candidateCount)
		}()
	}
	waitGroup.Wait()
	close(results)

	counts := make([]int, candidateCount)
	for start := range results {
		counts[start]++
	}
	for index, count := range counts {
		if count != requestCount/candidateCount {
			t.Fatalf("candidate=%d count=%d distribution=%v", index, count, counts)
		}
	}
}

// TestFairRoundRobinSchedulerKeepsModelTicketsIndependent 验证不同模型从独立票号开始。
func TestFairRoundRobinSchedulerKeepsModelTicketsIndependent(t *testing.T) {
	t.Parallel()

	scheduler := &FairRoundRobinScheduler{}
	firstModel := mustSchedulerModelID(t, "gpt-5.6-sol")
	secondModel := mustSchedulerModelID(t, "gpt-5.4")

	if got := scheduler.NextStart("codex", firstModel, 3); got != 0 {
		t.Fatalf("first model first start = %d, want 0", got)
	}
	if got := scheduler.NextStart("codex", firstModel, 3); got != 1 {
		t.Fatalf("first model second start = %d, want 1", got)
	}
	if got := scheduler.NextStart("codex", secondModel, 3); got != 0 {
		t.Fatalf("second model first start = %d, want 0", got)
	}
}

// BenchmarkFairRoundRobinScheduler 测量稳定模型游标的无锁票号热路径。
func BenchmarkFairRoundRobinScheduler(benchmark *testing.B) {
	modelID := mustSchedulerModelID(benchmark, "gpt-5.6-sol")
	scheduler := &FairRoundRobinScheduler{}
	_ = scheduler.NextStart("codex", modelID, 100_000)
	benchmark.ReportAllocs()
	benchmark.ResetTimer()
	for range benchmark.N {
		_ = scheduler.NextStart("codex", modelID, 100_000)
	}
}

// mustSchedulerModelID 创建测试需要的有效真实模型标识。
func mustSchedulerModelID(t testing.TB, value string) runtimecore.ModelID {
	t.Helper()

	modelID, err := runtimecore.NewModelID(value)
	if err != nil {
		t.Fatalf("NewModelID() error = %v", err)
	}
	return modelID
}
