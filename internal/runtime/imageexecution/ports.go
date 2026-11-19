// Package imageexecution 提供图片生成与编辑共享的账号执行、运行态观察与上游 429 有界等待重试。
//
// 该运行时层与 imagestudio 平级，仅依赖 images 适配器、accountruntime/upstreamretry 等应用与核心包，
// 不耦合任何 HTTP 传输包，从而可由 Gateway /v1/images/*（Stage 12）与 Image Studio（Stage 13）共同复用。
package imageexecution

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// ObservedAccount 绑定一次真实征召返回的账号视图与其对应的持久化凭据观察。
type ObservedAccount struct {
	Account     images.Account
	Observation accountcredentials.CredentialObservation
}

// ObservedAccountSession 包装一次请求内的候选账号源，记录每次真实征召产出的 CredentialObservation。
type ObservedAccountSession interface {
	images.AccountSource
	ObservationFor(accountRef string) (accountcredentials.CredentialObservation, bool)
}

// AccountEligibilityFunc 在重征召阶段校验候选账号是否满足当前图片请求的模型与能力闸门。
type AccountEligibilityFunc func(account images.Account) bool

// HealthyPoolCursor 在已观察到合法 raw 429 且尚未接受任何提交时，按完整 Recruiter
// 顺序产出尚未尝试过、当前健康且满足图片能力闸门的候选账号，直到真实池耗尽。
type HealthyPoolCursor interface {
	Next(ctx context.Context) (account ObservedAccount, found bool, err error)
}

// RateLimitReacquirer 是可选的宿主账号源扩展端口：
//   - 在初始执行期间捕获每次真实征召产生的 CredentialObservation（绝不伪造观察）；
//   - 在初始 3 次窗口因合法 raw 429 结束且未钉选时，打开健康池续扫游标，零等待尝试剩余健康账号；
//   - 在 429 退避等待后通过完整 Recruiter（含 UsageGate、Scheduling、硬阻塞、传输兼容与
//     原子 RateLimitCooldownWaiver）重新征召账号，非钉选场景下优先选择已健康的替代账号。
type RateLimitReacquirer interface {
	NewObservedSession() ObservedAccountSession
	OpenHealthyPool(
		ctx context.Context,
		provider string,
		model string,
		excluded map[string]struct{},
		eligible AccountEligibilityFunc,
	) (HealthyPoolCursor, error)
	ReacquireFor429Retry(
		ctx context.Context,
		provider string,
		model string,
		pinned bool,
		target accountcore.AccountRef,
		receipt runtimecore.CooldownReceipt,
		originObservation accountcredentials.CredentialObservation,
		eligible AccountEligibilityFunc,
	) (account ObservedAccount, usedWaiver bool, found bool, err error)
}

// LegacyFailureRecorder 在未装配 ObservedAttemptRecorder 或无真实凭据观察时兜底记录失败。
type LegacyFailureRecorder func(ctx context.Context, accountRef string, model string, cause error)

// LegacySuccessRecorder 在未装配 ObservedAttemptRecorder 或无真实凭据观察时兜底记录成功。
type LegacySuccessRecorder func(ctx context.Context, accountRef string, model string, at time.Time)

// RetryMetadata 汇总本次图片执行的 429 重试统计与权威 Retry-After 头动作（与 HTTP 解耦）。
type RetryMetadata struct {
	Retries          int
	TotalWait        time.Duration
	RetryAfterHeader string
	RetryAfterAction upstreamretry.RetryAfterHeaderAction
}

// Result 保存一次图片执行结果、真实凭据观察与 HTTP 无关的 429 诊断元数据。
type Result struct {
	Execution   images.Execution
	Observation accountcredentials.CredentialObservation
	HasObserved bool
	Retry       RetryMetadata
}
