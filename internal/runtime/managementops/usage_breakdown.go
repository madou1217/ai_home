package managementops

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// usageBreakdownGroup 是账号×模型拆解的唯一聚合行形状。CTE 路径与 rollup 路径都产出
// 同一种行，再交给 assembleUsageBreakdown 单点组装，避免两套汇总语义漂移。
type usageBreakdownGroup struct {
	accountProvider          string
	accountRef               string
	provider                 string
	model                    string
	calls                    int
	inputTokens              int64
	outputTokens             int64
	cacheReadInputTokens     int64
	cacheCreationInputTokens int64
	reasoningOutputTokens    int64
	totalTokens              int64
	costUSD                  float64
}

type usageBreakdownGroupKey struct {
	accountProvider string
	accountRef      string
	provider        string
	model           string
}

// projectionScanScope 是下推到 usage_source 的作用域超集过滤：
// 只用于缩小扫描范围，最终仍由 canonical_usage 上的原始范围过滤保证精确。
type projectionScanScope struct {
	clause string
	args   []any
}

// QueryBreakdown 查询按账号与模型交叉拆解的聚合详情。
func (s *UsageStore) QueryBreakdown(ctx context.Context, query UsageQuery) (UsageBreakdownResult, error) {
	if s == nil || s.db == nil {
		return UsageBreakdownResult{}, ErrUsageUnavailable
	}
	q := normalizeUsageQueryBounds(query)
	groups, err := s.queryBreakdownGroups(ctx, q)
	if err != nil {
		return UsageBreakdownResult{}, err
	}
	return assembleUsageBreakdown(groups), nil
}

func (s *UsageStore) queryBreakdownGroups(ctx context.Context, q UsageQuery) ([]usageBreakdownGroup, error) {
	// 两种 scope 都优先走持久 rollup：model 用小时模型汇总，session 用小时会话汇总；
	// 只有窗口首尾未对齐的不足一小时区间才回落到 canonical CTE。
	// legacy-unknown 模型仍可走 session 汇总（rollup 存储的就是 canonical model 名），
	// 但 model 维度因 CTE 前缀无法安全缩小，仍走原 CTE。
	if q.SessionID != "" || (q.Model != "" && q.Model != legacyUnknownModel) {
		if groups, ok, err := s.queryBreakdownGroupsRollup(ctx, q); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
		} else if ok {
			return groups, nil
		}
	}
	return s.queryBreakdownGroupsCTE(ctx, q)
}

func (s *UsageStore) queryBreakdownGroupsCTE(ctx context.Context, q UsageQuery) ([]usageBreakdownGroup, error) {
	conn, _, pCtx, err := s.openPreparedProjection(ctx, q, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		cleanupProjectionConn(conn)
		_ = conn.Close()
	}()

	scope := buildBreakdownScanScope(q, pCtx)
	uWhere, uArgs := buildProjectedWhereClause(q, "u", true, true)
	args := append(projectionBaseArgsWithScope(q, pCtx, scope.args), uArgs...)
	rows, err := conn.QueryContext(ctx, fmt.Sprintf(`
		WITH %s
		SELECT
			u.account_provider, u.account_ref, u.provider, u.model,
			COUNT(*) AS calls,
			COALESCE(SUM(u.input_tokens), 0),
			COALESCE(SUM(u.output_tokens), 0),
			COALESCE(SUM(u.cache_read_input_tokens), 0),
			COALESCE(SUM(u.cache_creation_input_tokens), 0),
			COALESCE(SUM(u.reasoning_output_tokens), 0),
			COALESCE(SUM(u.total_tokens), 0),
			COALESCE(SUM(u.cost_usd), 0)
		FROM canonical_usage u
		WHERE %s
		GROUP BY u.account_provider, u.account_ref, u.provider, u.model`,
		buildCanonicalProjectionCTEWithScope(scope.clause), uWhere), args...)
	if err != nil {
		return nil, fmt.Errorf("查询账号用量拆解失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	groups := make([]usageBreakdownGroup, 0)
	for rows.Next() {
		var g usageBreakdownGroup
		if scanErr := rows.Scan(
			&g.accountProvider, &g.accountRef, &g.provider, &g.model,
			&g.calls, &g.inputTokens, &g.outputTokens, &g.cacheReadInputTokens,
			&g.cacheCreationInputTokens, &g.reasoningOutputTokens, &g.totalTokens, &g.costUSD,
		); scanErr != nil {
			return nil, scanErr
		}
		groups = append(groups, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return groups, nil
}

// buildBreakdownScanScope 生成 usage_source 上的作用域超集过滤。
//   - model：raw model 命中，或该行带有“归因为目标模型”的 scanner 归因；
//   - session：仅当不存在把行重写到目标 session 的分叉上下文时，raw session_id 才是精确超集；
//   - provider：raw 列，可直接下推。
//
// legacy-unknown 由空 model 推导，无法用 raw model 前缀安全缩小，故不下推。
func buildBreakdownScanScope(q UsageQuery, pCtx *UsageProjectionContext) projectionScanScope {
	var clauses []string
	var args []any
	if q.Provider != "" {
		clauses = append(clauses, "r.provider = ?")
		args = append(args, q.Provider)
	}
	if q.Model != "" && q.Model != legacyUnknownModel {
		clauses = append(clauses,
			"(r.model = ? OR r.id IN (SELECT scanner_id FROM model_usage_read_attributions WHERE model = ?))")
		args = append(args, q.Model, q.Model)
	}
	if q.SessionID != "" && !projectionRewritesToSession(pCtx, q.SessionID) {
		clauses = append(clauses, "r.session_id = ?")
		args = append(args, q.SessionID)
	}
	if len(clauses) == 0 {
		return projectionScanScope{}
	}
	return projectionScanScope{clause: " AND " + strings.Join(clauses, " AND "), args: args}
}

func projectionRewritesToSession(pCtx *UsageProjectionContext, sessionID string) bool {
	if pCtx == nil || sessionID == "" {
		return false
	}
	for _, f := range pCtx.ForkDescriptors {
		if f.SessionID == sessionID {
			return true
		}
	}
	return false
}

// queryBreakdownGroupsRollup 在整小时区间被有效 rollup 完整覆盖时，从小时模型汇总
// 直接产出账号×模型行；未对齐的首尾不足一小时区间仍用 canonical CTE 精确补算。
func (s *UsageStore) queryBreakdownGroupsRollup(ctx context.Context, q UsageQuery) ([]usageBreakdownGroup, bool, error) {
	firstFull, lastFullEnd := fullHourWindow(q.FromMS, q.ToMS)
	if firstFull >= lastFullEnd {
		return nil, false, nil
	}
	if err := s.ensureRollupSyncedForRange(ctx, firstFull, lastFullEnd); err != nil {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, false, nil
	}

	groups, ok, err := s.readBreakdownRollupGroups(ctx, q, firstFull, lastFullEnd)
	if err != nil || !ok {
		return nil, ok, err
	}

	merged := make(map[usageBreakdownGroupKey]*usageBreakdownGroup, len(groups))
	mergeUsageBreakdownGroups(merged, groups)
	if q.FromMS < firstFull {
		edgeQ := q
		edgeQ.ToMS = firstFull - 1
		edge, edgeErr := s.queryBreakdownGroupsCTE(ctx, edgeQ)
		if edgeErr != nil {
			return nil, false, edgeErr
		}
		mergeUsageBreakdownGroups(merged, edge)
	}
	if lastFullEnd <= q.ToMS {
		edgeQ := q
		edgeQ.FromMS = lastFullEnd
		edge, edgeErr := s.queryBreakdownGroupsCTE(ctx, edgeQ)
		if edgeErr != nil {
			return nil, false, edgeErr
		}
		mergeUsageBreakdownGroups(merged, edge)
	}
	out := make([]usageBreakdownGroup, 0, len(merged))
	for _, g := range merged {
		out = append(out, *g)
	}
	return out, true, nil
}

// readBreakdownRollupGroups 在同一只读快照内校验覆盖/脏小时/分叉与定价摘要后读取小时汇总。
// session scope 读小时会话汇总（按 canonical session_id），model scope 读小时模型汇总。
func (s *UsageStore) readBreakdownRollupGroups(
	ctx context.Context,
	q UsageQuery,
	firstFull, lastFullEnd int64,
) (groups []usageBreakdownGroup, ok bool, err error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = conn.Close() }()

	snap, err := beginProjectionReadSnapshot(ctx, conn)
	if err != nil {
		return nil, false, err
	}
	defer snap.close()

	capReport, err := inspectRollupCapabilitiesQueryer(ctx, conn)
	if err != nil || !capReport.allReady {
		return nil, false, err
	}
	_, forkDigest, err := s.getCachedForkDescriptorsConn(ctx, conn, capReport.meta.forkRev)
	if err != nil {
		return nil, false, err
	}
	var pricingCache rollupSyncPricingCache
	_, customDigest, err := pricingCache.loadConn(ctx, s, conn, capReport)
	if err != nil {
		return nil, false, err
	}
	ready, err := rollupWindowFullyMaterializedConn(ctx, conn, firstFull, lastFullEnd, capReport, forkDigest, customDigest)
	if err != nil || !ready {
		return nil, false, err
	}

	table := "model_usage_rollup_hourly_model"
	where := "model = ?"
	args := []any{q.Model}
	if q.SessionID != "" {
		table = "model_usage_rollup_hourly_session"
		where = "session_id = ?"
		args = []any{q.SessionID}
		if q.Model != "" {
			where += " AND model = ?"
			args = append(args, q.Model)
		}
	}
	if q.Provider != "" {
		where += " AND provider = ?"
		args = append(args, q.Provider)
	}
	args = append(args, firstFull, lastFullEnd)

	rows, err := conn.QueryContext(ctx, fmt.Sprintf(`
		SELECT account_provider, account_ref, provider, model,
			SUM(calls), SUM(input_tokens), SUM(output_tokens),
			SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
			SUM(reasoning_output_tokens), SUM(total_tokens), SUM(cost_usd)
		FROM %s
		WHERE %s AND hour_ms >= ? AND hour_ms < ?
		GROUP BY account_provider, account_ref, provider, model`, table, where), args...)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = rows.Close() }()

	groups = make([]usageBreakdownGroup, 0)
	for rows.Next() {
		var g usageBreakdownGroup
		if scanErr := rows.Scan(
			&g.accountProvider, &g.accountRef, &g.provider, &g.model,
			&g.calls, &g.inputTokens, &g.outputTokens, &g.cacheReadInputTokens,
			&g.cacheCreationInputTokens, &g.reasoningOutputTokens, &g.totalTokens, &g.costUSD,
		); scanErr != nil {
			return nil, false, scanErr
		}
		groups = append(groups, g)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return groups, true, nil
}

// rollupWindowFullyMaterializedConn 要求 [startHour,endHour) 覆盖连续且无脏小时、
// 无分叉/定价摘要不匹配的小时；任何残留都让调用方回落到 canonical CTE。
func rollupWindowFullyMaterializedConn(
	ctx context.Context,
	conn *sql.Conn,
	startHour, endHour int64,
	capReport rollupCapabilityReport,
	forkDigest, customPricingDigest int64,
) (bool, error) {
	covered, err := readCoverageRangesConn(ctx, conn, startHour, endHour)
	if err != nil {
		return false, err
	}
	if len(findUncoveredHourRanges(startHour, endHour, covered)) > 0 {
		return false, nil
	}
	var invalid int64
	if err := conn.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM (
			SELECT hour_ms FROM model_usage_rollup_dirty_hours
			WHERE hour_ms >= ? AND hour_ms < ?
			UNION
			SELECT hour_ms FROM model_usage_rollup_hours
			WHERE hour_ms >= ? AND hour_ms < ?
				AND (fork_digest != ? OR (attr_count > 0 AND (pricing_rev != ? OR pricing_custom_digest != ?)))
		)`, startHour, endHour, startHour, endHour,
		forkDigest, capReport.meta.pricingRev, customPricingDigest).Scan(&invalid); err != nil {
		return false, err
	}
	return invalid == 0, nil
}

func mergeUsageBreakdownGroups(dst map[usageBreakdownGroupKey]*usageBreakdownGroup, groups []usageBreakdownGroup) {
	for i := range groups {
		g := &groups[i]
		key := usageBreakdownGroupKey{
			accountProvider: g.accountProvider,
			accountRef:      g.accountRef,
			provider:        g.provider,
			model:           g.model,
		}
		agg := dst[key]
		if agg == nil {
			cp := *g
			dst[key] = &cp
			continue
		}
		agg.calls += g.calls
		agg.inputTokens += g.inputTokens
		agg.outputTokens += g.outputTokens
		agg.cacheReadInputTokens += g.cacheReadInputTokens
		agg.cacheCreationInputTokens += g.cacheCreationInputTokens
		agg.reasoningOutputTokens += g.reasoningOutputTokens
		agg.totalTokens += g.totalTokens
		agg.costUSD += g.costUSD
	}
}

// assembleUsageBreakdown 是账号/模型两层汇总的单一组装点，输入行与 CTE GROUP BY 行同形。
func assembleUsageBreakdown(groups []usageBreakdownGroup) UsageBreakdownResult {
	accountsMap := make(map[string]*UsageBreakdownAccount)
	for i := range groups {
		g := &groups[i]
		ref := strings.TrimSpace(g.accountRef)
		key := ref
		if key == "" {
			key = "__unattributed__"
		}
		acc, exists := accountsMap[key]
		if !exists {
			effProv := ""
			if ref != "" {
				effProv = strings.TrimSpace(g.accountProvider)
			}
			acc = &UsageBreakdownAccount{
				AccountRef:      ref,
				AccountProvider: effProv,
				Models:          make([]UsageModelItem, 0),
			}
			accountsMap[key] = acc
		} else if acc.AccountProvider != "" && strings.TrimSpace(g.accountProvider) != "" && acc.AccountProvider != strings.TrimSpace(g.accountProvider) {
			acc.AccountProvider = ""
		}

		mItem := UsageModelItem{
			Provider:                 g.provider,
			Model:                    g.model,
			Calls:                    g.calls,
			InputTokens:              g.inputTokens,
			OutputTokens:             g.outputTokens,
			CacheReadInputTokens:     g.cacheReadInputTokens,
			CacheCreationInputTokens: g.cacheCreationInputTokens,
			ReasoningOutputTokens:    g.reasoningOutputTokens,
			TotalTokens:              g.totalTokens,
			CostUSD:                  NormalizeUsageCostUSD(g.costUSD),
			CacheHitRate:             CalculateCacheHitRate(g.inputTokens, g.cacheReadInputTokens, g.cacheCreationInputTokens),
		}
		acc.Models = append(acc.Models, mItem)
		acc.Calls += g.calls
		acc.InputTokens += g.inputTokens
		acc.OutputTokens += g.outputTokens
		acc.CacheReadInputTokens += g.cacheReadInputTokens
		acc.CacheCreationInputTokens += g.cacheCreationInputTokens
		acc.ReasoningOutputTokens += g.reasoningOutputTokens
		acc.TotalTokens += g.totalTokens
		acc.CostUSD += mItem.CostUSD
	}

	var summary UsageBreakdownSummary
	type modelAgg struct {
		item        UsageModelItem
		accountRefs map[string]struct{}
	}
	modelsMap := make(map[string]*modelAgg)
	accounts := make([]UsageBreakdownAccount, 0, len(accountsMap))

	for _, acc := range accountsMap {
		acc.ModelCount = len(acc.Models)
		acc.CostUSD = NormalizeUsageCostUSD(acc.CostUSD)
		acc.CacheHitRate = CalculateCacheHitRate(acc.InputTokens, acc.CacheReadInputTokens, acc.CacheCreationInputTokens)
		sortUsageModels(acc.Models)
		accounts = append(accounts, *acc)

		if acc.AccountRef != "" {
			summary.AccountCount++
		} else {
			summary.UnattributedCalls += acc.Calls
		}
		summary.Calls += acc.Calls
		summary.InputTokens += acc.InputTokens
		summary.OutputTokens += acc.OutputTokens
		summary.CacheReadInputTokens += acc.CacheReadInputTokens
		summary.CacheCreationInputTokens += acc.CacheCreationInputTokens
		summary.ReasoningOutputTokens += acc.ReasoningOutputTokens
		summary.TotalTokens += acc.TotalTokens
		summary.CostUSD += acc.CostUSD

		for _, m := range acc.Models {
			mk := m.Provider + "\x00" + m.Model
			agg, ok := modelsMap[mk]
			if !ok {
				agg = &modelAgg{
					item:        UsageModelItem{Provider: m.Provider, Model: m.Model},
					accountRefs: make(map[string]struct{}),
				}
				modelsMap[mk] = agg
			}
			agg.item.Calls += m.Calls
			agg.item.InputTokens += m.InputTokens
			agg.item.OutputTokens += m.OutputTokens
			agg.item.CacheReadInputTokens += m.CacheReadInputTokens
			agg.item.CacheCreationInputTokens += m.CacheCreationInputTokens
			agg.item.ReasoningOutputTokens += m.ReasoningOutputTokens
			agg.item.TotalTokens += m.TotalTokens
			agg.item.CostUSD += m.CostUSD
			if acc.AccountRef != "" {
				agg.accountRefs[acc.AccountRef] = struct{}{}
			} else {
				agg.item.UnattributedCalls += m.Calls
			}
		}
	}

	sort.Slice(accounts, func(i, j int) bool {
		return compareUsageCostDesc(
			accounts[i].CostUSD, accounts[i].TotalTokens, accounts[i].Calls, accounts[i].AccountRef,
			accounts[j].CostUSD, accounts[j].TotalTokens, accounts[j].Calls, accounts[j].AccountRef,
		)
	})

	models := make([]UsageModelItem, 0, len(modelsMap))
	for _, agg := range modelsMap {
		item := agg.item
		item.CostUSD = NormalizeUsageCostUSD(item.CostUSD)
		item.AccountCount = len(agg.accountRefs)
		item.CacheHitRate = CalculateCacheHitRate(item.InputTokens, item.CacheReadInputTokens, item.CacheCreationInputTokens)
		models = append(models, item)
	}
	sortUsageModels(models)

	summary.CostUSD = NormalizeUsageCostUSD(summary.CostUSD)
	summary.CacheHitRate = CalculateCacheHitRate(summary.InputTokens, summary.CacheReadInputTokens, summary.CacheCreationInputTokens)
	return UsageBreakdownResult{
		Summary:  summary,
		Accounts: accounts,
		Models:   models,
	}
}
