// Package accountscheduling 把"账号能否被调度"收敛成 Provider 策略端口 + 编排器。
//
// 分工：
//   - 适配层负责取证（运行态、额度快照、模型目录、凭据、限流观察），产出 Evidence；
//   - Provider 策略（Policy）只做纯判定：账号级能不能调度、这个模型能不能调度、
//     该账号这次该花哪一档额度；
//   - 编排器只负责顺序（账号级 -> 模型级 -> 额度档位）与结果透传，不写任何
//     Provider 专属分支。
package accountscheduling

import (
	"sort"
	"strings"
	"time"

	schedcore "github.com/madou1217/ai_home/core/accountscheduling"
)

// AccountFacts 是账号维度的静态与派生态事实。
type AccountFacts struct {
	Enabled           bool
	Configured        bool
	APIKeyMode        bool
	RemainingPct      *float64
	QuotaStatus       string
	SchedulableStatus string
}

// ModelFacts 是这个账号与目标模型的静态事实（来自该账号自己的模型目录与收窄）。
type ModelFacts struct {
	// CatalogKnown 表示该账号确实有可信模型目录；false 时不得据此判定"模型不存在"。
	CatalogKnown bool
	// InCatalog 表示目录里确实有这个模型。
	InCatalog bool
	// Excluded 表示目录/设置收窄已经判定该 (账号,模型) 不参与调度。
	Excluded bool
	// ExcludeReason 是收窄给出的原因码；空时按 model_not_in_catalog 处理。
	ExcludeReason schedcore.Reason
}

// ObservedFacts 是运行态观察（阻塞、冷却、在途）。
//
// 原因码已由适配层归一，策略不解析任何 Provider 原始状态。
type ObservedFacts struct {
	AccountReasons       []schedcore.Reason
	AccountCooldownUntil time.Time
	// RoutingBlockReason 只在"人工复核"型路由阻塞时有值（完整原因码）。
	RoutingBlockReason string
	// RoutingBlockUntil 是路由硬阻塞的到期时间；到期后进入单请求试探。
	RoutingBlockUntil time.Time
	ModelReasons      []schedcore.Reason
	// ModelCooldownUntil 是该模型来自持久化的冷却到期时间。
	ModelCooldownUntil time.Time
	// RuntimeModelCooldownUntil 是运行态观察到的该模型冷却到期时间。
	RuntimeModelCooldownUntil time.Time
	// ModelFailureKind 是该模型最近的失败类别（例如 model_capacity_unavailable）。
	ModelFailureKind string
	AccountInFlight  int
	ModelInFlight    int
}

// EligibilityFacts 是需要外部端口才能得出的两个结论，由适配层先问好再交给策略。
type EligibilityFacts struct {
	// Route 来自运行态路由资格端口；空表示未拦。
	Route schedcore.Reason
	// UsageGate 来自选号前额度门禁；空表示未拦。
	UsageGate schedcore.Reason
}

// Evidence 是一次判定的全部输入。
type Evidence struct {
	Provider   string
	AccountRef string
	// ModelID 为空表示只做账号级判定（例如续聊/启动时还没定模型）。
	ModelID string

	Account     AccountFacts
	Model       ModelFacts
	Observed    ObservedFacts
	Eligibility EligibilityFacts

	// Buckets 是该账号的额度档位（按账号自己的优先级排序，已耗尽/无恢复时间的也在内）。
	Buckets []schedcore.Bucket
}

// Policy 是一个 Provider 的调度策略。新增 Provider 只需要实现这个端口并注册。
type Policy interface {
	// ProviderID 返回策略唯一支持的规范 Provider。
	ProviderID() string
	// EvaluateAccount 判定账号整体能否接客；返回可调度即继续看模型级。
	EvaluateAccount(Evidence) schedcore.Verdict
	// EvaluateModel 判定该账号的这个模型能否接客。
	// 账号级通过而模型级失败时，调度器应保留账号、只换模型。
	EvaluateModel(Evidence) schedcore.Verdict
	// QuotaPlan 返回该账号针对这个模型该花的额度档位顺序（第一个即本次消费档）。
	// 返回空表示不区分档位。
	QuotaPlan(Evidence) []schedcore.Bucket
}

// Registry 按 Provider 查找策略；未注册的 Provider 落到默认策略。
type Registry struct {
	policies map[string]Policy
	fallback Policy
}

// NewRegistry 构造策略注册表；fallback 不能为空。
func NewRegistry(fallback Policy, policies ...Policy) *Registry {
	registry := &Registry{policies: map[string]Policy{}, fallback: fallback}
	if fallback != nil {
		registry.policies[strings.TrimSpace(fallback.ProviderID())] = fallback
	}
	for _, policy := range policies {
		registry.Register(policy)
	}
	return registry
}

// Register 注册或覆盖一个 Provider 策略。
func (registry *Registry) Register(policy Policy) {
	if registry == nil || policy == nil {
		return
	}
	provider := strings.TrimSpace(policy.ProviderID())
	if provider == "" {
		return
	}
	registry.policies[provider] = policy
}

// Lookup 返回 Provider 策略；未注册时返回默认策略。
func (registry *Registry) Lookup(provider string) Policy {
	if registry == nil {
		return nil
	}
	if policy, found := registry.policies[strings.TrimSpace(provider)]; found {
		return policy
	}
	return registry.fallback
}

// Evaluator 按"账号级 -> 模型级 -> 额度档位"的顺序编排策略。
type Evaluator struct {
	registry *Registry
}

// NewEvaluator 构造编排器。
func NewEvaluator(registry *Registry) *Evaluator {
	return &Evaluator{registry: registry}
}

// Evaluate 返回本次调度的最终判定。
func (evaluator *Evaluator) Evaluate(evidence Evidence) schedcore.Verdict {
	if evaluator == nil {
		return schedcore.Allowed("")
	}
	policy := evaluator.registry.Lookup(evidence.Provider)
	if policy == nil {
		return schedcore.Allowed("")
	}
	if verdict := policy.EvaluateAccount(evidence); !verdict.Schedulable() {
		return verdict
	}
	if strings.TrimSpace(evidence.ModelID) == "" {
		return schedcore.Allowed("")
	}
	if verdict := policy.EvaluateModel(evidence); !verdict.Schedulable() {
		return verdict
	}
	for _, bucket := range policy.QuotaPlan(evidence) {
		if bucket.Usable() {
			return schedcore.Allowed(bucket.ID)
		}
	}
	// 所有档位都不可用：有恢复时间的按恢复时间拦，没有的按需续费/换号。
	if plan := policy.QuotaPlan(evidence); len(plan) > 0 {
		return schedcore.BlockedUntil(schedcore.ReasonQuotaExhausted, plan[0].ResetAt)
	}
	return schedcore.Allowed("")
}

// SortBucketsByPriority 是给策略复用的稳定排序：先按策略给的顺序，其次剩余多的优先。
//
// 这里只做通用排序，不表达任何 Provider 的额度语义（谁先花由策略自己决定）。
func SortBucketsByPriority(buckets []schedcore.Bucket) {
	sort.SliceStable(buckets, func(left, right int) bool {
		a, b := buckets[left], buckets[right]
		if a.Usable() != b.Usable() {
			return a.Usable()
		}
		return a.RemainingBasisPoints > b.RemainingBasisPoints
	})
}
