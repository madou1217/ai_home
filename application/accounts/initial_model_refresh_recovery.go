package accounts

import (
	"context"
	"errors"
	"fmt"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// InitialModelRefreshRecoveryBatchSize 限制一次启动恢复扫描持有的账号数量。
	InitialModelRefreshRecoveryBatchSize = 256
)

var (
	// ErrInvalidInitialModelRefreshRecovery 表示恢复用例缺少查询端口、调度器或 Provider Catalog。
	ErrInvalidInitialModelRefreshRecovery = errors.New("首次模型刷新恢复依赖无效")
	// ErrInvalidInitialModelRefreshRecoveryQuery 表示恢复查询缺少有界分页参数。
	ErrInvalidInitialModelRefreshRecoveryQuery = errors.New("首次模型刷新恢复查询无效")
	// ErrInvalidInitialModelRefreshCandidate 表示持久化层返回了无效或错位候选。
	ErrInvalidInitialModelRefreshCandidate = errors.New("首次模型刷新恢复候选无效")
)

// InitialModelRefreshRecoveryQuery 使用 AccountRef 作为稳定 keyset 游标。
type InitialModelRefreshRecoveryQuery struct {
	afterRef accountcore.AccountRef
	limit    int
}

// NewInitialModelRefreshRecoveryQuery 创建有界的首次模型刷新恢复查询。
func NewInitialModelRefreshRecoveryQuery(
	afterRef accountcore.AccountRef,
	limit int,
) (InitialModelRefreshRecoveryQuery, error) {
	query := InitialModelRefreshRecoveryQuery{
		afterRef: afterRef,
		limit:    limit,
	}
	if !query.IsValid() {
		return InitialModelRefreshRecoveryQuery{},
			ErrInvalidInitialModelRefreshRecoveryQuery
	}
	return query, nil
}

// IsValid 判断查询是否具备稳定游标和固定内存上限。
func (query InitialModelRefreshRecoveryQuery) IsValid() bool {
	return (query.afterRef == "" || query.afterRef.IsValid()) &&
		query.limit >= 1 &&
		query.limit <= InitialModelRefreshRecoveryBatchSize
}

// AfterRef 返回不包含在下一页中的账号游标。
func (query InitialModelRefreshRecoveryQuery) AfterRef() accountcore.AccountRef {
	return query.afterRef
}

// Limit 返回本页最多读取的候选数量。
func (query InitialModelRefreshRecoveryQuery) Limit() int {
	return query.limit
}

// InitialModelRefreshCandidate 是不含凭据的启动恢复调度事实。
type InitialModelRefreshCandidate struct {
	accountRef accountcore.AccountRef
	providerID string
}

// NewInitialModelRefreshCandidate 校验稳定账号身份和规范 Provider。
func NewInitialModelRefreshCandidate(
	catalog *providers.Catalog,
	accountRef accountcore.AccountRef,
	providerID string,
) (InitialModelRefreshCandidate, error) {
	if catalog == nil || !accountRef.IsValid() {
		return InitialModelRefreshCandidate{}, ErrInvalidInitialModelRefreshCandidate
	}
	canonicalProviderID, found := catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return InitialModelRefreshCandidate{}, ErrInvalidInitialModelRefreshCandidate
	}
	return InitialModelRefreshCandidate{
		accountRef: accountRef,
		providerID: canonicalProviderID,
	}, nil
}

// AccountRef 返回待补齐模型快照的稳定账号身份。
func (candidate InitialModelRefreshCandidate) AccountRef() accountcore.AccountRef {
	return candidate.accountRef
}

// ProviderID 返回账号所属规范 Provider。
func (candidate InitialModelRefreshCandidate) ProviderID() string {
	return candidate.providerID
}

// InitialModelRefreshCandidateReader 是启动恢复专用的只读查询端口。
type InitialModelRefreshCandidateReader interface {
	ListInitialModelRefreshCandidates(
		ctx context.Context,
		query InitialModelRefreshRecoveryQuery,
	) ([]InitialModelRefreshCandidate, error)
}

// InitialModelRefreshScheduler 同时声明调度动作和当前已装配的 Provider 能力。
// 同一个数据库可以保存尚未迁移到 Go 模型发现链的其他 Provider。
type InitialModelRefreshScheduler interface {
	ModelRefreshScheduler
	SupportsModelRefresh(providerID string) bool
}

// InitialModelRefreshRecovery 扫描未物化首次模型快照的账号并提交异步刷新信号。
type InitialModelRefreshRecovery struct {
	catalog    *providers.Catalog
	candidates InitialModelRefreshCandidateReader
	scheduler  InitialModelRefreshScheduler
}

// NewInitialModelRefreshRecovery 创建一次性、有界的启动恢复用例。
func NewInitialModelRefreshRecovery(
	catalog *providers.Catalog,
	candidates InitialModelRefreshCandidateReader,
	scheduler InitialModelRefreshScheduler,
) (*InitialModelRefreshRecovery, error) {
	if catalog == nil || candidates == nil || scheduler == nil {
		return nil, ErrInvalidInitialModelRefreshRecovery
	}
	return &InitialModelRefreshRecovery{
		catalog:    catalog,
		candidates: candidates,
		scheduler:  scheduler,
	}, nil
}

// Recover 批量扫描并调度恢复任务；它只等待本地查询和入队，不等待上游发现。
func (recovery *InitialModelRefreshRecovery) Recover(ctx context.Context) error {
	if recovery == nil ||
		recovery.catalog == nil ||
		recovery.candidates == nil ||
		recovery.scheduler == nil ||
		ctx == nil {
		return ErrInvalidInitialModelRefreshRecovery
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	var afterRef accountcore.AccountRef
	for {
		query, err := NewInitialModelRefreshRecoveryQuery(
			afterRef,
			InitialModelRefreshRecoveryBatchSize,
		)
		if err != nil {
			return err
		}
		candidates, err := recovery.candidates.ListInitialModelRefreshCandidates(
			ctx,
			query,
		)
		if err != nil {
			return fmt.Errorf("查询首次模型刷新恢复候选失败: %w", err)
		}
		if err := recovery.validatePage(query, candidates); err != nil {
			return err
		}
		for _, candidate := range candidates {
			if !recovery.scheduler.SupportsModelRefresh(candidate.ProviderID()) {
				continue
			}
			if err := recovery.scheduler.ScheduleModelRefresh(
				ctx,
				candidate.AccountRef(),
				candidate.ProviderID(),
			); err != nil {
				return fmt.Errorf(
					"调度账号 %s 首次模型刷新失败: %w",
					candidate.AccountRef(),
					err,
				)
			}
		}
		if len(candidates) < query.Limit() {
			return nil
		}
		afterRef = candidates[len(candidates)-1].AccountRef()
	}
}

// validatePage 阻止越界、乱序或未知 Provider 破坏 keyset 扫描。
func (recovery *InitialModelRefreshRecovery) validatePage(
	query InitialModelRefreshRecoveryQuery,
	candidates []InitialModelRefreshCandidate,
) error {
	if len(candidates) > query.Limit() {
		return ErrInvalidInitialModelRefreshCandidate
	}
	previousRef := query.AfterRef()
	for _, candidate := range candidates {
		canonicalProviderID, found := recovery.catalog.CanonicalID(
			candidate.ProviderID(),
		)
		if !candidate.AccountRef().IsValid() ||
			candidate.AccountRef() <= previousRef ||
			!found ||
			canonicalProviderID != candidate.ProviderID() {
			return ErrInvalidInitialModelRefreshCandidate
		}
		previousRef = candidate.AccountRef()
	}
	return nil
}
