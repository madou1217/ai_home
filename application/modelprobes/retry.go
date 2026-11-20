package modelprobes

import (
	"context"
	"errors"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// State 是一条探测事实对外表达的状态。
//
// 这是状态的唯一声明点：传输层与前端只消费这里给出的结论，不再各自用
// 「有没有错误文本 / 目录是否为空 / 时间戳是否存在」重新推导一遍。
type State string

const (
	// StatePending 表示从未探测过（零值事实）。
	StatePending State = "pending"
	// StateOK 表示最近一次探测拿到了上游目录（目录可以为空）。
	StateOK State = "ok"
	// StateRetrying 表示失败但会自动重试，调用方无需介入。
	StateRetrying State = "retrying"
	// StateFailed 表示失败且需要人工处理（凭据、配置或账号本身）；
	// 仍会按长周期重试，但不应被描述成「正在重试」。
	StateFailed State = "failed"
)

// RetryPolicy 是一类失败事实的退避声明。
type RetryPolicy struct {
	// State 是失败对外表达的状态。
	State State
	// Retryable 表示是否需要自动重新探测。
	Retryable bool
	// RetryAfter 是距上一次探测至少需要等待多久才再次自动探测。
	RetryAfter time.Duration
}

// defaultProbeRetryAfter 是未归类失败的保守重试间隔。
const defaultProbeRetryAfter = 30 * time.Minute

// retryPolicies 是失败码 → 退避节奏的唯一声明。
//
// 分级的依据是失败是否可能自行恢复：
//   - 网络/上游抖动：分钟级重试；
//   - 目录内容或凭据版本冲突：半小时级；
//   - 认证被拒绝、凭据缺失：小时级，主要等凭据更新后的生命周期事件；
//   - Provider 不支持目录发现：一天一次，避免无意义地打上游；
//   - 账号不存在：不再自动重试。
var retryPolicies = map[string]RetryPolicy{
	"timeout": {
		State:      StateRetrying,
		Retryable:  true,
		RetryAfter: 5 * time.Minute,
	},
	"discovery_failed": {
		State:      StateRetrying,
		Retryable:  true,
		RetryAfter: 15 * time.Minute,
	},
	"refresh_failed": {
		State:      StateRetrying,
		Retryable:  true,
		RetryAfter: 15 * time.Minute,
	},
	"credential_conflict": {
		State:      StateRetrying,
		Retryable:  true,
		RetryAfter: 30 * time.Minute,
	},
	"invalid_catalog": {
		State:      StateRetrying,
		Retryable:  true,
		RetryAfter: 30 * time.Minute,
	},
	"authentication_rejected": {
		State:      StateFailed,
		Retryable:  true,
		RetryAfter: 6 * time.Hour,
	},
	"credential_missing": {
		State:      StateFailed,
		Retryable:  true,
		RetryAfter: 6 * time.Hour,
	},
	"discovery_unsupported": {
		State:      StateFailed,
		Retryable:  true,
		RetryAfter: 24 * time.Hour,
	},
	// account_not_found 的失败只可能来自账号在探测期间被删除，重试没有意义。
	"account_not_found": {
		State:     StateFailed,
		Retryable: false,
	},
}

// RetryPolicyFor 返回失败码对应的退避声明；未知失败按保守的可重试处理。
func RetryPolicyFor(errorCode string) RetryPolicy {
	if policy, found := retryPolicies[strings.TrimSpace(errorCode)]; found {
		return policy
	}
	return RetryPolicy{
		State:      StateRetrying,
		Retryable:  true,
		RetryAfter: defaultProbeRetryAfter,
	}
}

// RetryDue 报告一条失败事实现在是否已经到自动重试时间。
func RetryDue(errorCode string, attemptedAt, now time.Time) bool {
	policy := RetryPolicyFor(errorCode)
	if !policy.Retryable || attemptedAt.IsZero() {
		return false
	}
	return !now.Before(attemptedAt.Add(policy.RetryAfter))
}

// ProbeRetryBatchSize 限制一次到期扫描持有的失败事实数量。
const ProbeRetryBatchSize = 256

var (
	// ErrInvalidProbeRetry 表示到期探测重试用例缺少查询端口或调度器。
	ErrInvalidProbeRetry = errors.New("模型探测到期重试依赖无效")
	// ErrInvalidProbeRetryQuery 表示到期扫描缺少有界分页参数。
	ErrInvalidProbeRetryQuery = errors.New("模型探测到期重试查询无效")
	// ErrInvalidProbeRetryCandidate 表示持久化层返回了无法解释的候选。
	ErrInvalidProbeRetryCandidate = errors.New("模型探测到期重试候选无效")
)

// RetryQuery 使用 AccountRef keyset 游标读取失败的探测事实。
type RetryQuery struct {
	afterRef accountcore.AccountRef
	limit    int
}

// NewRetryQuery 创建有界到期扫描查询。
func NewRetryQuery(
	afterRef accountcore.AccountRef,
	limit int,
) (RetryQuery, error) {
	query := RetryQuery{afterRef: afterRef, limit: limit}
	if (query.afterRef != "" && !query.afterRef.IsValid()) ||
		query.limit < 1 ||
		query.limit > ProbeRetryBatchSize {
		return RetryQuery{}, ErrInvalidProbeRetryQuery
	}
	return query, nil
}

// IsValid 判断查询是否具备稳定游标与有界页大小。
func (query RetryQuery) IsValid() bool {
	return (query.afterRef == "" || query.afterRef.IsValid()) &&
		query.limit >= 1 &&
		query.limit <= ProbeRetryBatchSize
}

// AfterRef 返回不包含在下一页中的账号游标。
func (query RetryQuery) AfterRef() accountcore.AccountRef {
	return query.afterRef
}

// Limit 返回本页最多读取的失败事实数量。
func (query RetryQuery) Limit() int {
	return query.limit
}

// RetryCandidate 是一条到期扫描读出的失败事实（不含凭据）。
type RetryCandidate struct {
	accountRef  accountcore.AccountRef
	providerID  string
	errorCode   string
	attemptedAt time.Time
}

// NewRetryCandidate 校验候选的身份、Provider 与探测时刻。
func NewRetryCandidate(
	accountRef accountcore.AccountRef,
	providerID string,
	errorCode string,
	attemptedAt time.Time,
) (RetryCandidate, error) {
	providerID = strings.TrimSpace(providerID)
	errorCode = strings.TrimSpace(errorCode)
	if !accountRef.IsValid() ||
		providerID == "" ||
		len(providerID) > 64 ||
		errorCode == "" ||
		len(errorCode) > 64 ||
		attemptedAt.IsZero() ||
		attemptedAt.UnixMilli() < 0 {
		return RetryCandidate{}, ErrInvalidProbeRetryCandidate
	}
	return RetryCandidate{
		accountRef:  accountRef,
		providerID:  providerID,
		errorCode:   errorCode,
		attemptedAt: attemptedAt.UTC(),
	}, nil
}

// AccountRef 返回失败事实所属账号。
func (candidate RetryCandidate) AccountRef() accountcore.AccountRef {
	return candidate.accountRef
}

// ProviderID 返回失败事实所属 Provider。
func (candidate RetryCandidate) ProviderID() string {
	return candidate.providerID
}

// ErrorCode 返回失败分类。
func (candidate RetryCandidate) ErrorCode() string {
	return candidate.errorCode
}

// AttemptedAt 返回失败发生时刻。
func (candidate RetryCandidate) AttemptedAt() time.Time {
	return candidate.attemptedAt
}

// RetryCandidateReader 列出最近一次探测失败的账号事实。
type RetryCandidateReader interface {
	ListModelProbeRetryCandidates(
		ctx context.Context,
		query RetryQuery,
	) ([]RetryCandidate, error)
}

// RetryScheduler 把到期账号重新放入模型刷新队列。
type RetryScheduler interface {
	ScheduleModelRefresh(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		providerID string,
	) error
}

// ProbeRetry 按声明式退避把到期的失败账号重新提交刷新。
//
// 它只做「是否到期」的本地判断与入队；真正的执行、并发和进程内重试仍由
// 现有的 ModelRefreshCoordinator 负责，避免出现第二套刷新状态机。
type ProbeRetry struct {
	candidates RetryCandidateReader
	scheduler  RetryScheduler
	clock      func() time.Time
	batchSize  int
}

// NewProbeRetry 创建到期失败账号重试用例。
func NewProbeRetry(
	candidates RetryCandidateReader,
	scheduler RetryScheduler,
	clock func() time.Time,
) (*ProbeRetry, error) {
	if candidates == nil || scheduler == nil {
		return nil, ErrInvalidProbeRetry
	}
	if clock == nil {
		clock = time.Now
	}
	return &ProbeRetry{
		candidates: candidates,
		scheduler:  scheduler,
		clock:      clock,
		batchSize:  ProbeRetryBatchSize,
	}, nil
}

// RetryDueProbes 分页扫描失败的探测事实，把已过退避窗口的账号重新入队。
func (retry *ProbeRetry) RetryDueProbes(ctx context.Context) error {
	if retry == nil || retry.candidates == nil || retry.scheduler == nil || ctx == nil {
		return ErrInvalidProbeRetry
	}
	now := retry.clock()
	var afterRef accountcore.AccountRef
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		query, err := NewRetryQuery(afterRef, retry.batchSize)
		if err != nil {
			return err
		}
		candidates, err := retry.candidates.ListModelProbeRetryCandidates(ctx, query)
		if err != nil {
			return err
		}
		if len(candidates) > query.Limit() {
			return ErrInvalidProbeRetryCandidate
		}
		previousRef := query.AfterRef()
		for _, candidate := range candidates {
			if !candidate.accountRef.IsValid() ||
				candidate.accountRef <= previousRef ||
				candidate.providerID == "" ||
				candidate.errorCode == "" {
				return ErrInvalidProbeRetryCandidate
			}
			previousRef = candidate.accountRef
			if !RetryDue(candidate.errorCode, candidate.attemptedAt, now) {
				continue
			}
			if err := retry.scheduler.ScheduleModelRefresh(
				ctx,
				candidate.accountRef,
				candidate.providerID,
			); err != nil {
				return err
			}
		}
		if len(candidates) < query.Limit() {
			return nil
		}
		afterRef = candidates[len(candidates)-1].accountRef
	}
}
