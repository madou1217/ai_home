package managementops

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"strings"
)

type liveCanonicalContext struct {
	forksByHash   map[string]forkDescriptor
	attrByScanner map[int64]usageAttribution
	matchedProxy  map[int64]struct{}
	recordHW      int64
	promptHW      int64
}

func buildLiveCanonicalContext(pCtx *UsageProjectionContext) liveCanonicalContext {
	lctx := liveCanonicalContext{
		recordHW: math.MaxInt64,
		promptHW: math.MaxInt64,
	}
	if pCtx == nil {
		return lctx
	}
	if pCtx.RecordHighWaterID >= 0 {
		lctx.recordHW = pCtx.RecordHighWaterID
	}
	if pCtx.PromptHighWaterRowID >= 0 {
		lctx.promptHW = pCtx.PromptHighWaterRowID
	}
	if len(pCtx.ForkDescriptors) > 0 {
		lctx.forksByHash = make(map[string]forkDescriptor, len(pCtx.ForkDescriptors))
		for _, f := range pCtx.ForkDescriptors {
			lctx.forksByHash[f.SourceHash] = f
		}
	}
	if len(pCtx.Attributions) > 0 {
		lctx.attrByScanner = make(map[int64]usageAttribution, len(pCtx.Attributions))
		lctx.matchedProxy = make(map[int64]struct{}, len(pCtx.Attributions))
		for _, a := range pCtx.Attributions {
			lctx.attrByScanner[a.ScannerID] = a
			lctx.matchedProxy[a.ProxyID] = struct{}{}
		}
	}
	return lctx
}

// scanLiveCanonicalRangeConn 以单趟 Go 流式扫描替代多次 CTE 重复遍历。
// 零临时表、零 SQLite 字符串/正则开销，保持与 canonical_usage / canonical_prompt_events 100% 语义一致。
func scanLiveCanonicalRangeConn(
	ctx context.Context,
	conn *sql.Conn,
	acc *usagePanelAccumulator,
	rng timeRange,
	lctx liveCanonicalContext,
	scanUsage bool,
	scanPrompts bool,
	includeTrend bool,
) error {
	if rng.ToMS < rng.FromMS {
		return nil
	}
	if scanUsage {
		usageSQL := `
			SELECT id, event_key, provider, account_ref, session_id, model,
				input_tokens, output_tokens, cache_read_input_tokens,
				cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
				cost_usd, timestamp_ms, project, cwd, git_branch
			FROM model_usage_records
			WHERE timestamp_ms BETWEEN ? AND ?
				AND id <= ?
				AND NOT (provider IN ('codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn') AND source_kind = 'native_session_done')`
		args := []any{rng.FromMS, rng.ToMS, lctx.recordHW}
		if acc.opts.provider != "" {
			// 一元 + 禁止 SQLite 改选 idx_model_usage_session(provider=?) 扫全历史，保持走 idx_model_usage_timestamp。
			usageSQL += ` AND +provider = ?`
			args = append(args, acc.opts.provider)
		}
		rows, err := conn.QueryContext(ctx, usageSQL, args...)
		if err != nil {
			return fmt.Errorf("单趟扫描规范用量记录失败: %w", err)
		}
		hasForks := len(lctx.forksByHash) > 0
		hasAttrs := len(lctx.attrByScanner) > 0
		for rows.Next() {
			var (
				id, inTok, outTok, cr, cc, reason, totalTok, tsMS int64
				eventKey, provider, accountRef, sessionID, model  string
				project, cwd, gitBranch                           string
				costUSD                                           float64
			)
			if scanErr := rows.Scan(
				&id, &eventKey, &provider, &accountRef, &sessionID, &model,
				&inTok, &outTok, &cr, &cc, &reason, &totalTok,
				&costUSD, &tsMS, &project, &cwd, &gitBranch,
			); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			if hasAttrs {
				if _, hidden := lctx.matchedProxy[id]; hidden {
					continue
				}
			}
			if hasForks && provider == "codex" {
				var keep bool
				sessionID, project, cwd, keep, _ = applyCodexForkToUsageRow(
					provider, eventKey, sessionID, project, cwd, lctx.forksByHash,
				)
				if !keep {
					continue
				}
			}
			if hasAttrs {
				if attr, ok := lctx.attrByScanner[id]; ok {
					if strings.TrimSpace(accountRef) == "" {
						accountRef = attr.AccountRef
					}
					if attr.Model != "" {
						model = attr.Model
					}
					costUSD = attr.CostUSD
				} else if strings.TrimSpace(accountRef) == "" {
					accountRef = ""
				}
			} else if strings.TrimSpace(accountRef) == "" {
				accountRef = ""
			}
			model = strings.TrimSpace(model)
			if model == "" {
				model = legacyUnknownModel
			}
			acc.addCanonicalRow(
				provider, model, accountRef, sessionID, project, cwd, gitBranch,
				tsMS, inTok, outTok, cr, cc, reason, totalTok, costUSD, includeTrend,
			)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()
	}

	if scanPrompts {
		promptSQL := `
			SELECT event_key, provider, session_id
			FROM model_usage_prompt_events
			WHERE timestamp_ms BETWEEN ? AND ?
				AND rowid <= ?`
		args := []any{rng.FromMS, rng.ToMS, lctx.promptHW}
		if acc.opts.provider != "" {
			promptSQL += ` AND +provider = ?`
			args = append(args, acc.opts.provider)
		}
		pRows, err := conn.QueryContext(ctx, promptSQL, args...)
		if err != nil {
			return fmt.Errorf("单趟扫描提示词事件失败: %w", err)
		}
		hasForks := len(lctx.forksByHash) > 0
		for pRows.Next() {
			var eventKey, provider, sessionID string
			if scanErr := pRows.Scan(&eventKey, &provider, &sessionID); scanErr != nil {
				_ = pRows.Close()
				return scanErr
			}
			if hasForks && provider == "codex" {
				var keep bool
				sessionID, keep, _ = applyCodexForkToPromptRow(provider, eventKey, sessionID, lctx.forksByHash)
				if !keep {
					continue
				}
			}
			acc.addPromptCount(provider, sessionID, 1)
		}
		if err := pRows.Err(); err != nil {
			_ = pRows.Close()
			return err
		}
		_ = pRows.Close()
	}
	return nil
}
