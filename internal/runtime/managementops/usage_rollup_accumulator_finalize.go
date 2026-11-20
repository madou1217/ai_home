package managementops

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

func (a *usagePanelAccumulator) finalizeStats() UsageStatsSummary {
	out := a.stats
	if a.opts.needSessions {
		out.TotalSessions = len(a.sessions)
	} else {
		out.TotalSessions = len(a.sessionKeys)
	}
	out.TotalCostUSD = NormalizeUsageCostUSD(a.statsCostUSD.value())
	return out
}

func finalizePanelModelMap(src map[string]*panelModelAcc, includeRefs bool) []UsageModelItem {
	items := make([]UsageModelItem, 0, len(src))
	for _, m := range src {
		var refs []string
		if includeRefs && len(m.accountRefs) > 0 {
			refs = make([]string, 0, len(m.accountRefs))
			for r := range m.accountRefs {
				refs = append(refs, r)
			}
			sort.Strings(refs)
		}
		items = append(items, UsageModelItem{
			Provider:                 m.provider,
			Model:                    m.model,
			Calls:                    m.calls,
			InputTokens:              m.inputTokens,
			OutputTokens:             m.outputTokens,
			CacheReadInputTokens:     m.cacheReadInputTokens,
			CacheCreationInputTokens: m.cacheCreationInputTokens,
			ReasoningOutputTokens:    m.reasoningOutputTokens,
			TotalTokens:              m.totalTokens,
			CostUSD:                  NormalizeUsageCostUSD(m.costUSD.value()),
			AccountCount:             len(m.accountRefs),
			UnattributedCalls:        m.unattributedCalls,
			CacheHitRate:             CalculateCacheHitRate(m.inputTokens, m.cacheReadInputTokens, m.cacheCreationInputTokens),
			AccountRefs:              refs,
		})
	}
	sortUsageModels(items)
	return items
}

func (a *usagePanelAccumulator) finalizeModels(includeRefs bool) []UsageModelItem {
	return finalizePanelModelMap(a.models, includeRefs)
}

func (a *usagePanelAccumulator) finalizeModelOptions(includeRefs bool) []UsageModelItem {
	return finalizePanelModelMap(a.modelOptions, includeRefs)
}

func (a *usagePanelAccumulator) finalizeSessionParts(
	ctx context.Context,
	conn *sql.Conn,
	applyLimit bool,
	limit int,
) ([]UsageSessionPart, error) {
	if len(a.sessions) == 0 {
		return []UsageSessionPart{}, nil
	}
	if err := enrichSessionAccWithMetadataConn(ctx, conn, a.sessions); err != nil {
		return nil, err
	}
	parts := make([]UsageSessionPart, 0, len(a.sessions))
	for key, sa := range a.sessions {
		p := sa.part
		p.CostUSD = NormalizeUsageCostUSD(sa.costUSD.value())
		if len(sa.accountRefs) > 0 {
			p.AccountRefs = make([]string, 0, len(sa.accountRefs))
			for ref := range sa.accountRefs {
				p.AccountRefs = append(p.AccountRefs, ref)
			}
			sort.Strings(p.AccountRefs)
		}
		if a.promptCounts != nil {
			p.PromptCount = a.promptCounts[key]
		}
		parts = append(parts, p)
	}
	sortUpdated := func(p UsageSessionPart) int64 {
		if p.SessionUpdatedAtMS != 0 {
			return p.SessionUpdatedAtMS
		}
		return p.UsageUpdatedAtMS
	}
	sort.Slice(parts, func(i, j int) bool {
		li, lj := sortUpdated(parts[i]), sortUpdated(parts[j])
		if li != lj {
			return li > lj
		}
		if parts[i].Provider != parts[j].Provider {
			return parts[i].Provider < parts[j].Provider
		}
		return parts[i].SessionID < parts[j].SessionID
	})
	if applyLimit && limit > 0 && len(parts) > limit {
		parts = parts[:limit]
	}
	return parts, nil
}

func (a *usagePanelAccumulator) finalizeTrend() UsageTrend {
	if a.opts.trendOriginMS <= 0 || a.opts.trendBucketMS <= 0 {
		return UsageTrend{
			FromMS:   a.opts.trendFromMS,
			ToMS:     a.opts.trendToMS,
			BucketMS: 0,
			Points:   []UsageTrendPoint{},
		}
	}
	starts := listTrendBucketStarts(a.opts.trendFromMS, a.opts.trendToMS, a.opts.trendOriginMS, a.opts.trendBucketMS)
	points := make([]UsageTrendPoint, 0, len(starts))
	for _, start := range starts {
		if pt, ok := a.trendByStart[start]; ok {
			out := *pt
			out.CostUSD = NormalizeUsageCostUSD(a.trendCostByStart[start].value())
			out.CacheHitRate = CalculateCacheHitRate(out.InputTokens, out.CacheReadInputTokens, out.CacheCreationInputTokens)
			points = append(points, out)
		} else {
			points = append(points, UsageTrendPoint{BucketStartMS: start})
		}
	}
	return UsageTrend{
		FromMS:   a.opts.trendFromMS,
		ToMS:     a.opts.trendToMS,
		BucketMS: a.opts.trendBucketMS,
		Points:   points,
	}
}

// enrichSessionAccWithMetadataConn 按 provider 分组批量走 PK(provider, session_id) 补齐会话元数据。
func enrichSessionAccWithMetadataConn(ctx context.Context, conn *sql.Conn, sessions map[string]*panelSessionAcc) error {
	if len(sessions) == 0 {
		return nil
	}
	byProvider := make(map[string][]string)
	for _, sa := range sessions {
		byProvider[sa.part.Provider] = append(byProvider[sa.part.Provider], sa.part.SessionID)
	}
	const chunkSize = 400
	for prov, ids := range byProvider {
		for i := 0; i < len(ids); i += chunkSize {
			end := i + chunkSize
			if end > len(ids) {
				end = len(ids)
			}
			chunk := ids[i:end]
			var b strings.Builder
			b.WriteString(`
				SELECT session_id, project, cwd, git_branch, started_at_ms, updated_at_ms
				FROM model_usage_sessions
				WHERE provider = ? AND session_id IN (`)
			args := make([]any, 0, len(chunk)+1)
			args = append(args, prov)
			for idx, sid := range chunk {
				if idx > 0 {
					b.WriteByte(',')
				}
				b.WriteByte('?')
				args = append(args, sid)
			}
			b.WriteByte(')')
			rows, err := conn.QueryContext(ctx, b.String(), args...)
			if err != nil {
				return fmt.Errorf("查询会话元数据失败: %w", err)
			}
			for rows.Next() {
				var sid, project, cwd, gitBranch string
				var startedAt, updatedAt int64
				if scanErr := rows.Scan(&sid, &project, &cwd, &gitBranch, &startedAt, &updatedAt); scanErr != nil {
					_ = rows.Close()
					return scanErr
				}
				sa := sessions[prov+"\x00"+sid]
				if sa == nil {
					continue
				}
				sa.part.SessionProject = project
				sa.part.SessionCWD = cwd
				sa.part.SessionGitBranch = gitBranch
				if startedAt != 0 {
					sa.part.SessionStartedAtMS = startedAt
				}
				if updatedAt != 0 {
					sa.part.SessionUpdatedAtMS = updatedAt
				}
			}
			if err := rows.Err(); err != nil {
				_ = rows.Close()
				return err
			}
			_ = rows.Close()
		}
	}
	return nil
}
