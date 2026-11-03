package accounts

import (
	"context"
	"errors"
	"fmt"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// ModelRefreshSweepBatchSize 限制一次目录重扫持有的账号数量。
	ModelRefreshSweepBatchSize = 256
)

var (
	// ErrInvalidModelRefreshSweep 表示重扫用例缺少查询端口、调度器或 Provider Catalog。
	ErrInvalidModelRefreshSweep = errors.New("账号模型目录重扫依赖无效")
	// ErrInvalidModelRefreshSweepQuery 表示重扫查询缺少有界分页参数或 Provider 非规范。
	ErrInvalidModelRefreshSweepQuery = errors.New("账号模型目录重扫查询无效")
	// ErrInvalidModelRefreshSweepCandidate 表示持久化层返回了越界、乱序或错位候选。
	ErrInvalidModelRefreshSweepCandidate = errors.New("账号模型目录重扫候选无效")
)

// ModelRefreshSweepCandidate 与首次恢复候选是同一种不含凭据的调度事实。
type ModelRefreshSweepCandidate = InitialModelRefreshCandidate

// ModelRefreshSweepQuery 使用 AccountRef keyset 游标，可选限定单个 Provider。
type ModelRefreshSweepQuery struct {
	providerID string
	afterRef   accountcore.AccountRef
	limit      int
}

// NewModelRefreshSweepQuery 创建有界重扫查询；providerID 为空表示全部 Provider。
func NewModelRefreshSweepQuery(
	providerID string,
	afterRef accountcore.AccountRef,
	limit int,
) (ModelRefreshSweepQuery, error) {
	query := ModelRefreshSweepQuery{
		providerID: providerID,
		afterRef:   afterRef,
		limit:      limit,
	}
	if (query.afterRef != "" && !query.afterRef.IsValid()) ||
		query.limit < 1 ||
		query.limit > ModelRefreshSweepBatchSize {
		return ModelRefreshSweepQuery{}, ErrInvalidModelRefreshSweepQuery
	}
	return query, nil
}

// ProviderID 返回限定的规范 Provider；空值表示不限定。
func (query ModelRefreshSweepQuery) ProviderID() string {
	return query.providerID
}

// AfterRef 返回不包含在下一页中的账号游标。
func (query ModelRefreshSweepQuery) AfterRef() accountcore.AccountRef {
	return query.afterRef
}

// Limit 返回本页最多读取的候选数量。
func (query ModelRefreshSweepQuery) Limit() int {
	return query.limit
}

// ModelRefreshSweepCandidateReader 列出已启用且持有凭据的账号。
type ModelRefreshSweepCandidateReader interface {
	ListModelRefreshSweepCandidates(
		ctx context.Context,
		query ModelRefreshSweepQuery,
	) ([]ModelRefreshSweepCandidate, error)
}

// ModelRefreshSweep 为已启用账号重新提交模型目录刷新，修正上游目录漂移。
//
// 首次恢复只补齐从未物化的账号；上游新增模型后已有快照永远不会被重新发现，
// 路由目录因此缺模型且请求在路由阶段就失败，不会触发按账号的纠错刷新。
// 本用例只做本地查询和入队，刷新执行、合并与退避仍由协调器负责。
type ModelRefreshSweep struct {
	catalog    *providers.Catalog
	candidates ModelRefreshSweepCandidateReader
	scheduler  InitialModelRefreshScheduler
}

// NewModelRefreshSweep 创建可重复执行的目录重扫用例。
func NewModelRefreshSweep(
	catalog *providers.Catalog,
	candidates ModelRefreshSweepCandidateReader,
	scheduler InitialModelRefreshScheduler,
) (*ModelRefreshSweep, error) {
	if catalog == nil || candidates == nil || scheduler == nil {
		return nil, ErrInvalidModelRefreshSweep
	}
	return &ModelRefreshSweep{
		catalog:    catalog,
		candidates: candidates,
		scheduler:  scheduler,
	}, nil
}

// Sweep 为全部已装配刷新能力的 Provider 重扫已启用账号。
func (sweep *ModelRefreshSweep) Sweep(ctx context.Context) error {
	return sweep.run(ctx, "")
}

// SweepProvider 只重扫一个规范 Provider 的已启用账号。
func (sweep *ModelRefreshSweep) SweepProvider(
	ctx context.Context,
	providerID string,
) error {
	if sweep == nil || sweep.catalog == nil {
		return ErrInvalidModelRefreshSweep
	}
	canonicalProviderID, found := sweep.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return ErrInvalidModelRefreshSweepQuery
	}
	return sweep.run(ctx, providerID)
}

// run 分页读取候选并入队；同账号已排队时由协调器合并。
func (sweep *ModelRefreshSweep) run(ctx context.Context, providerID string) error {
	if sweep == nil ||
		sweep.catalog == nil ||
		sweep.candidates == nil ||
		sweep.scheduler == nil ||
		ctx == nil {
		return ErrInvalidModelRefreshSweep
	}
	if providerID != "" && !sweep.scheduler.SupportsModelRefresh(providerID) {
		return nil
	}
	var afterRef accountcore.AccountRef
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		query, err := NewModelRefreshSweepQuery(
			providerID,
			afterRef,
			ModelRefreshSweepBatchSize,
		)
		if err != nil {
			return err
		}
		candidates, err := sweep.candidates.ListModelRefreshSweepCandidates(ctx, query)
		if err != nil {
			return fmt.Errorf("查询账号模型目录重扫候选失败: %w", err)
		}
		if err := sweep.validatePage(query, candidates); err != nil {
			return err
		}
		for _, candidate := range candidates {
			if !sweep.scheduler.SupportsModelRefresh(candidate.ProviderID()) {
				continue
			}
			if err := sweep.scheduler.ScheduleModelRefresh(
				ctx,
				candidate.AccountRef(),
				candidate.ProviderID(),
			); err != nil {
				return fmt.Errorf(
					"调度账号 %s 模型目录重扫失败: %w",
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

// validatePage 阻止越界、乱序、未知 Provider 或越过 Provider 过滤的候选。
func (sweep *ModelRefreshSweep) validatePage(
	query ModelRefreshSweepQuery,
	candidates []ModelRefreshSweepCandidate,
) error {
	if len(candidates) > query.Limit() {
		return ErrInvalidModelRefreshSweepCandidate
	}
	previousRef := query.AfterRef()
	for _, candidate := range candidates {
		canonicalProviderID, found := sweep.catalog.CanonicalID(candidate.ProviderID())
		if !candidate.AccountRef().IsValid() ||
			candidate.AccountRef() <= previousRef ||
			!found ||
			canonicalProviderID != candidate.ProviderID() ||
			(query.ProviderID() != "" && candidate.ProviderID() != query.ProviderID()) {
			return ErrInvalidModelRefreshSweepCandidate
		}
		previousRef = candidate.AccountRef()
	}
	return nil
}
