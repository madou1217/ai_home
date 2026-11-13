package codexhooks

import (
	"context"
	"errors"
	"sync"
	"time"
)

const (
	// DefaultSelfHealInterval 是自愈循环默认轮询周期。
	DefaultSelfHealInterval = 15 * time.Second
	// DefaultSelfHealMaxBackoff 是自愈失败退避的上限。
	DefaultSelfHealMaxBackoff = 15 * time.Minute
)

// ErrSelfHealCallbackRequired 表示启动自愈循环时未提供 EnsureInstalled 回调。
var ErrSelfHealCallbackRequired = errors.New("自愈循环缺少 ensureInstalled 回调")

// SelfHealResult 描述单轮 hook 校验或修复的结果。
type SelfHealResult struct {
	OK               bool
	Repaired         bool
	Retryable        *bool
	TargetBinaryPath string
	Reason           string
	ErrorCode        string
	Extra            any
}

// SelfHealFailure 在触发告警抑制条件或不可重试暂停时通知上层。
type SelfHealFailure struct {
	Result              *SelfHealResult
	Err                 error
	Suspended           bool
	ConsecutiveFailures int
	NextAttemptAt       time.Time
}

// SelfHealState 暴露自愈循环当前运行态（供诊断与测试读取）。
type SelfHealState struct {
	Repairing           bool
	Stopped             bool
	Suspended           bool
	ConsecutiveFailures int
	NextAttemptAt       time.Time
}

// SelfHealOptions 配置自愈循环。
type SelfHealOptions struct {
	Interval        time.Duration
	MaxBackoff      time.Duration
	Now             func() time.Time
	EnsureInstalled func(ctx context.Context) (SelfHealResult, error)
	OnRepaired      func(SelfHealResult)
	OnFailure       func(SelfHealFailure)
}

// SelfHealLoop 管理周期性 hook 核对、指数退避与幂等停止语义。
type SelfHealLoop struct {
	interval        time.Duration
	maxBackoff      time.Duration
	now             func() time.Time
	ensureInstalled func(ctx context.Context) (SelfHealResult, error)
	onRepaired      func(SelfHealResult)
	onFailure       func(SelfHealFailure)

	cancel context.CancelFunc
	done   chan struct{}

	mu                  sync.Mutex
	repairing           bool
	stopped             bool
	suspended           bool
	consecutiveFailures int
	nextAttemptAt       time.Time
	stopOnce            sync.Once
}

// ShouldReportFailure 使用 2 的幂（1, 2, 4, 8...）抑制连续失败告警。
func ShouldReportFailure(count int) bool {
	return count == 1 || (count > 0 && (count&(count-1)) == 0)
}

// StartSelfHealLoop 启动后台自愈协程，并在 ctx 取消或调用 Stop 时优雅退出。
func StartSelfHealLoop(ctx context.Context, opts SelfHealOptions) (*SelfHealLoop, error) {
	if opts.EnsureInstalled == nil {
		return nil, ErrSelfHealCallbackRequired
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = DefaultSelfHealInterval
	}
	maxBackoff := opts.MaxBackoff
	if maxBackoff <= 0 {
		maxBackoff = DefaultSelfHealMaxBackoff
	}
	if maxBackoff < interval {
		maxBackoff = interval
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	if ctx == nil {
		ctx = context.Background()
	}
	loopCtx, cancel := context.WithCancel(ctx)
	loop := &SelfHealLoop{
		interval:        interval,
		maxBackoff:      maxBackoff,
		now:             nowFn,
		ensureInstalled: opts.EnsureInstalled,
		onRepaired:      opts.OnRepaired,
		onFailure:       opts.OnFailure,
		cancel:          cancel,
		done:            make(chan struct{}),
	}

	go loop.run(loopCtx)
	return loop, nil
}

func (loop *SelfHealLoop) run(ctx context.Context) {
	defer close(loop.done)
	ticker := time.NewTicker(loop.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			loop.mu.Lock()
			loop.stopped = true
			loop.mu.Unlock()
			return
		case <-ticker.C:
			loop.Tick(ctx)
		}
	}
}

// Tick 执行单轮检查；若已停止、正在修复、已挂起或仍在退避期内则直接返回 nil。
func (loop *SelfHealLoop) Tick(ctx context.Context) *SelfHealResult {
	if loop == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	currentTime := loop.now()
	loop.mu.Lock()
	if loop.stopped || loop.repairing || loop.suspended || (!loop.nextAttemptAt.IsZero() && currentTime.Before(loop.nextAttemptAt)) {
		loop.mu.Unlock()
		return nil
	}
	loop.repairing = true
	loop.mu.Unlock()

	defer func() {
		loop.mu.Lock()
		loop.repairing = false
		loop.mu.Unlock()
	}()

	res, err := loop.ensureInstalled(ctx)
	if err != nil {
		return loop.recordFailure(nil, err)
	}
	if !res.OK {
		return loop.recordFailure(&res, nil)
	}

	loop.mu.Lock()
	loop.consecutiveFailures = 0
	loop.nextAttemptAt = time.Time{}
	loop.mu.Unlock()

	if res.Repaired && loop.onRepaired != nil {
		loop.onRepaired(res)
	}
	return &res
}

func (loop *SelfHealLoop) recordFailure(result *SelfHealResult, err error) *SelfHealResult {
	suspended := result != nil && result.Retryable != nil && !*result.Retryable
	nowTime := loop.now()

	loop.mu.Lock()
	loop.consecutiveFailures++
	failures := loop.consecutiveFailures
	loop.suspended = suspended
	var nextAttempt time.Time
	if !suspended {
		exponent := failures - 1
		if exponent > 30 {
			exponent = 30
		}
		delay := loop.interval
		for i := 0; i < exponent; i++ {
			if delay >= loop.maxBackoff/2 {
				delay = loop.maxBackoff
				break
			}
			delay *= 2
		}
		if delay > loop.maxBackoff {
			delay = loop.maxBackoff
		}
		nextAttempt = nowTime.Add(delay)
		loop.nextAttemptAt = nextAttempt
	} else {
		nextAttempt = loop.nextAttemptAt
	}
	loop.mu.Unlock()

	if (suspended || ShouldReportFailure(failures)) && loop.onFailure != nil {
		loop.onFailure(SelfHealFailure{
			Result:              result,
			Err:                 err,
			Suspended:           suspended,
			ConsecutiveFailures: failures,
			NextAttemptAt:       nextAttempt,
		})
	}
	return result
}

// State 返回当前自愈循环状态快照。
func (loop *SelfHealLoop) State() SelfHealState {
	if loop == nil {
		return SelfHealState{Stopped: true}
	}
	loop.mu.Lock()
	defer loop.mu.Unlock()
	return SelfHealState{
		Repairing:           loop.repairing,
		Stopped:             loop.stopped,
		Suspended:           loop.suspended,
		ConsecutiveFailures: loop.consecutiveFailures,
		NextAttemptAt:       loop.nextAttemptAt,
	}
}

// Stop 幂等停止自愈循环，并等待后台 goroutine 退出。
func (loop *SelfHealLoop) Stop() {
	if loop == nil {
		return
	}
	loop.stopOnce.Do(func() {
		loop.mu.Lock()
		loop.stopped = true
		loop.mu.Unlock()
		if loop.cancel != nil {
			loop.cancel()
		}
		if loop.done != nil {
			<-loop.done
		}
	})
}
