package admission

import (
	"time"

	"github.com/madou1217/ai_home/core/concurrency"
)

// resolveLocked 在锁内把配置与账号覆盖解析成一次准入的全部天花板。
//
// 解析顺序：systemMax 全局 → Key 上限 → (账号,模型) 覆盖 → 账号总量 →
// Provider 默认 → 全局账号默认。systemMax 是独立全局上限，不并进账号/模型上限：
// 否则 systemMax 较小时会把「系统排队」误判成「该账号自身饱和」。
func (controller *Controller) resolveLocked(request Request, keyID string) resolved {
	config := controller.config
	accountLimit := config.AccountTotal(request.Provider, request.AccountRef, controller.limits)
	modelLimit := config.AccountModelConcurrency(request.AccountRef, request.Model, controller.limits)
	keyLimit := 0
	if controller.keyLim != nil && keyID != "" {
		keyLimit = config.ClampToSystem(controller.keyLim(keyID))
	}
	return resolved{
		provider:     request.Provider,
		accountRef:   request.AccountRef,
		model:        request.Model,
		keyID:        keyID,
		keyLimit:     keyLimit,
		accountLimit: accountLimit,
		modelLimit:   modelLimit,
		systemMax:    config.SystemMax,
		queueLimit:   config.QueueLimit,
		retryAfter:   time.Duration(config.RetryAfterSeconds) * time.Second,
		waitTimeout:  time.Duration(config.QueueWaitTimeoutMS) * time.Millisecond,
	}
}

// Observation 是路由需要的一份运行态观察。
type Observation struct {
	AccountInFlight int
	AccountLimit    int
	ModelInFlight   int
	ModelLimit      int
	KeyInFlight     int
	KeyLimit        int
	SystemInFlight  int
	SystemMax       int
}

// Observe 返回某个 provider/账号/模型的在途计数与生效上限。
func (controller *Controller) Observe(provider, accountRef, model string) Observation {
	if controller == nil {
		return Observation{}
	}
	request := normalizeRequest(Request{Provider: provider, AccountRef: accountRef, Model: model})
	controller.mu.Lock()
	defer controller.mu.Unlock()
	item := controller.resolveLocked(request, "")
	observation := Observation{
		AccountInFlight: controller.byAccount[item.accountRef],
		AccountLimit:    item.accountLimit,
		ModelLimit:      item.modelLimit,
		SystemInFlight:  controller.running,
		SystemMax:       item.systemMax,
	}
	if key := item.accountModelKey(); key != "" {
		observation.ModelInFlight = controller.byAccountModel[key]
	}
	return observation
}

// Snapshot 是给管理面/诊断用的队列快照。
type Snapshot struct {
	Running      int                         `json:"running"`
	Queued       int                         `json:"queued"`
	Granted      int64                       `json:"granted"`
	Rejected     int64                       `json:"rejected"`
	TimedOut     int64                       `json:"timedOut"`
	QueueFull    int64                       `json:"queueFull"`
	AccountRejct int64                       `json:"accountRejected"`
	SystemMax    int                         `json:"systemMax"`
	QueueLimit   int                         `json:"queueLimit"`
	Providers    map[string]ProviderSnapshot `json:"providers"`
}

// ProviderSnapshot 是单 Provider 的运行态快照。
type ProviderSnapshot struct {
	Running        int
	MaxConcurrency int
	QueueLimit     int
	TotalScheduled int64
	TotalRejected  int64
}

// Stats 返回当前进程的队列快照。
func (controller *Controller) Stats() Snapshot {
	if controller == nil {
		return Snapshot{Providers: map[string]ProviderSnapshot{}}
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	snapshot := Snapshot{
		Running:      controller.running,
		Queued:       len(controller.queue),
		Granted:      controller.stats.granted,
		Rejected:     controller.stats.rejected,
		TimedOut:     controller.stats.timedOut,
		QueueFull:    controller.stats.queueFull,
		AccountRejct: controller.stats.accountRejct,
		SystemMax:    controller.config.SystemMax,
		QueueLimit:   controller.config.QueueLimit,
		Providers:    map[string]ProviderSnapshot{},
	}
	providers := map[string]struct{}{}
	for provider := range controller.config.ProviderDefaults {
		providers[provider] = struct{}{}
	}
	for provider := range controller.byProvider {
		providers[provider] = struct{}{}
	}
	for provider := range providers {
		snapshot.Providers[provider] = ProviderSnapshot{
			Running:        controller.byProvider[provider],
			MaxConcurrency: controller.config.AccountTotal(provider, "", controller.limits),
			QueueLimit:     controller.config.QueueLimit,
			TotalScheduled: controller.stats.granted,
			TotalRejected:  controller.stats.rejected,
		}
	}
	return snapshot
}

// DefaultConfig 返回内置默认配置（供未安装控制器时构造）。
func DefaultConfig() concurrency.Config { return concurrency.Default() }
