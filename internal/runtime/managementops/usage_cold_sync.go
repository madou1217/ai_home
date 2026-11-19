package managementops

import (
	"context"
)

var (
	coldSyncStatsPolicy = coldPanelPolicy{
		needStats:   true,
		needPrompts: true,
	}
	coldSyncModelsPolicy = coldPanelPolicy{
		needModels:       true,
		includeModelRefs: false,
	}
	coldSyncSessionsPolicy = coldPanelPolicy{
		needSessions:      true,
		needPrompts:       true,
		applySessionLimit: true,
	}
	coldSyncDashboardPolicy = coldPanelPolicy{
		needStats:         true,
		needModels:        true,
		needModelOptions:  true,
		needSessions:      true,
		needPrompts:       true,
		needTrend:         true,
		includeModelRefs:  false,
		applySessionLimit: true,
	}
)

// computeColdSyncWindow 面向已由上层入口规范化后的同步单窗查询（q.ToMS > 0，绝不再取新 time.Now），
// 复用 3 连接同版本只读 WAL 快照队列与有限面板策略，返回整窗聚合结果；
// 不满足条件或遇回退场景时返回 ok=false，由上层无损回退至既有同步路径。
func (s *UsageStore) computeColdSyncWindow(
	ctx context.Context,
	q UsageQuery,
	policy coldPanelPolicy,
) (UsageDashboardShard, bool, error) {
	if s == nil || s.db == nil {
		return UsageDashboardShard{}, false, ErrUsageUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return UsageDashboardShard{}, false, err
	}
	if q.ToMS <= 0 || q.ToMS < q.FromMS {
		return UsageDashboardShard{}, false, nil
	}
	shards, ok, err := s.computeColdShards(ctx, q, []UsageQuery{q}, 0, 0, policy)
	if err != nil || !ok || len(shards) != 1 {
		return UsageDashboardShard{}, false, err
	}
	return shards[0], true, nil
}

// tryComputeColdSyncStats 面向 QueryStats 缓存未命中路径：仅聚合标量统计、sessionKeys 会话去重数与
// 仅按 provider 过滤的提示词计数，绝不查询 model_usage_sessions 元数据或趋势分桶。
func (s *UsageStore) tryComputeColdSyncStats(ctx context.Context, q UsageQuery) (UsageStatsSummary, bool, error) {
	sh, ok, err := s.computeColdSyncWindow(ctx, q, coldSyncStatsPolicy)
	if err != nil || !ok {
		return UsageStatsSummary{}, false, err
	}
	return sh.Stats, true, nil
}

// tryComputeColdSyncModels 面向 QueryCostByModel 路径：仅聚合模型分布（保留 AccountCount 与 UnattributedCalls，
// 省略 AccountRefs），不补齐会话元数据、不组装提示词面板或趋势；共享 Phase A 仍扫描提示词事件。
func (s *UsageStore) tryComputeColdSyncModels(ctx context.Context, q UsageQuery) ([]UsageModelItem, bool, error) {
	sh, ok, err := s.computeColdSyncWindow(ctx, q, coldSyncModelsPolicy)
	if err != nil || !ok {
		return nil, false, err
	}
	return sh.Models, true, nil
}

// tryComputeColdSyncSessions 面向 QuerySessions 路径：在同一只读快照内补齐会话元数据、
// 按 updated(元数据优先)->provider->session_id 排序并应用 q.Limit，最后经 materializeSessionFromPart 输出。
func (s *UsageStore) tryComputeColdSyncSessions(ctx context.Context, q UsageQuery) ([]UsageSessionItem, bool, error) {
	sh, ok, err := s.computeColdSyncWindow(ctx, q, coldSyncSessionsPolicy)
	if err != nil || !ok {
		return nil, false, err
	}
	return materializeColdSessions(sh.SessionParts), true, nil
}

// tryComputeColdSyncDashboard 面向同步 QueryDashboard 路径：单窗一次产出完整面板，
// 保持 modelOptions 先于 model 过滤、includeModelRefs=false、applySessionLimit=true 及既有趋势分桶解析语义。
func (s *UsageStore) tryComputeColdSyncDashboard(ctx context.Context, q UsageQuery) (UsageDashboardPayload, bool, error) {
	sh, ok, err := s.computeColdSyncWindow(ctx, q, coldSyncDashboardPolicy)
	if err != nil || !ok {
		return UsageDashboardPayload{}, false, err
	}
	return UsageDashboardPayload{
		Stats:        sh.Stats,
		Models:       sh.Models,
		Sessions:     materializeColdSessions(sh.SessionParts),
		ModelOptions: sh.ModelOptions,
		Trend:        sh.Trend,
	}, true, nil
}

func materializeColdSessions(parts []UsageSessionPart) []UsageSessionItem {
	out := make([]UsageSessionItem, 0, len(parts))
	for _, part := range parts {
		out = append(out, materializeSessionFromPart(part))
	}
	return out
}
