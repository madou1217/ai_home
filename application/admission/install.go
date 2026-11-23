package admission

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

var (
	legacyMu       sync.Mutex
	legacyLimits   map[string]int
	legacyQueueMax int
)

// SetLegacyDefaults 记录旧环境变量提供的 Provider 默认并发与队列上限。
//
// server 配置里出现 concurrency 对象时以 server 配置为准；这里只是启动前的兜底。
func SetLegacyDefaults(providerLimits map[string]int, queueLimit int) {
	legacyMu.Lock()
	defer legacyMu.Unlock()
	legacyLimits = make(map[string]int, len(providerLimits))
	for provider, limit := range providerLimits {
		if limit > 0 {
			legacyLimits[provider] = limit
		}
	}
	legacyQueueMax = queueLimit
}

// LegacyDefaults 返回旧环境变量的默认值快照。
func LegacyDefaults() (map[string]int, int) {
	legacyMu.Lock()
	defer legacyMu.Unlock()
	copied := make(map[string]int, len(legacyLimits))
	for provider, limit := range legacyLimits {
		copied[provider] = limit
	}
	return copied, legacyQueueMax
}

// currentController 是进程内安装的准入控制器；未安装时所有准入都是无操作。
var currentController atomic.Pointer[Controller]

// Install 安装进程级控制器（组合根调用一次）。
func Install(controller *Controller) {
	if controller == nil {
		return
	}
	currentController.Store(controller)
}

// Current 返回进程内控制器；未安装时为 nil。
func Current() *Controller { return currentController.Load() }

// Acquire 用进程级控制器获取一个在途名额；未安装时返回空租约。
func Acquire(ctx context.Context, request Request) (*Lease, error) {
	if controller := currentController.Load(); controller != nil {
		return controller.Acquire(ctx, request)
	}
	return noopLease(), nil
}

// TryAcquire 用进程级控制器做一次立即判定；未安装时总是允许。
func TryAcquire(ctx context.Context, request Request) (*Lease, error) {
	if controller := currentController.Load(); controller != nil {
		return controller.TryAcquire(ctx, request)
	}
	return noopLease(), nil
}

// Observe 用进程级控制器读取运行态；未安装时返回零值。
func Observe(provider, accountRef, model string) Observation {
	if controller := currentController.Load(); controller != nil {
		return controller.Observe(provider, accountRef, model)
	}
	return Observation{}
}

// Observer 是读取进程级控制器的端口实现（晚绑定，构造顺序无关）。
type Observer struct{}

// Observe 返回某个账号/模型的在途并发观察。
func (Observer) Observe(provider, accountRef, model string) Observation {
	return Observe(provider, accountRef, model)
}

// RefreshAccountLimits 读取一次账号覆盖并原子应用。
func (controller *Controller) RefreshAccountLimits(ctx context.Context, source AccountLimitSource) error {
	if controller == nil || source == nil {
		return nil
	}
	limits, err := source.ListAccountConcurrencyLimits(ctx)
	if err != nil {
		return err
	}
	controller.SetAccountLimits(limits)
	return nil
}

// RefreshAccountLimitsLoop 周期刷新账号覆盖，直到 ctx 结束。
//
// 管理写路径与 CLI 都可能改覆盖；周期刷新让所有进程在数秒内收敛，不需要额外广播。
func (controller *Controller) RefreshAccountLimitsLoop(
	ctx context.Context,
	source AccountLimitSource,
	interval time.Duration,
) {
	if controller == nil || source == nil {
		return
	}
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	_ = controller.RefreshAccountLimits(ctx, source)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = controller.RefreshAccountLimits(ctx, source)
		}
	}
}
