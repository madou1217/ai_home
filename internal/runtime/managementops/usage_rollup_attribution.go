package managementops

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
	"math"
	"strings"
)

func buildObservationCandidates(
	proxies []observationRow,
	scanners []observationRow,
	forksByHash map[string]forkDescriptor,
) (
	candidates []matchCandidate,
	scannerByID map[int64]observationRow,
	proxyByID map[int64]observationRow,
	crossLeft map[int64]bool,
	crossRight map[int64]bool,
) {
	if len(proxies) == 0 || len(scanners) == 0 {
		return nil, nil, nil, nil, nil
	}

	proxyByID = make(map[int64]observationRow, len(proxies))
	byOut := make(map[tokenPairKey][]int, len(proxies))
	byGen := make(map[tokenPairKey][]int, len(proxies))
	for i, p := range proxies {
		proxyByID[p.ID] = p
		ctxTok := p.InputTokens + p.CacheReadInputTokens + p.CacheCreationInputTokens
		outKey := tokenPairKey{ctx: ctxTok, out: p.OutputTokens}
		byOut[outKey] = append(byOut[outKey], i)
		genKey := tokenPairKey{ctx: ctxTok, out: p.OutputTokens + p.ReasoningOutputTokens}
		byGen[genKey] = append(byGen[genKey], i)
	}

	seenStamp := make([]int, len(proxies))
	stamp := 0
	scannerByID = make(map[int64]observationRow)

	checkProxies := func(projected observationRow, list []int) {
		for _, pi := range list {
			if seenStamp[pi] == stamp {
				continue
			}
			seenStamp[pi] = stamp
			p := proxies[pi]
			minTS := p.TimestampMS - scannerBeforeProxyWindowMS
			maxTS := p.TimestampMS + scannerAfterProxyWindowMS
			if projected.TimestampMS < minTS || projected.TimestampMS > maxTS {
				continue
			}
			if !areCandidatesCompatible(projected, p) {
				continue
			}
			sh := hourFloorMS(projected.TimestampMS)
			ph := hourFloorMS(p.TimestampMS)
			if sh != ph {
				if crossLeft == nil {
					crossLeft = make(map[int64]bool)
					crossRight = make(map[int64]bool)
				}
				if sh > ph {
					crossRight[ph] = true
					crossLeft[sh] = true
				} else {
					crossRight[sh] = true
					crossLeft[ph] = true
				}
			}
			scannerByID[projected.ID] = projected
			delta := projected.TimestampMS - p.TimestampMS
			if delta < 0 {
				delta = -delta
			}
			var sRank int64 = 1
			if strings.TrimSpace(projected.SessionID) != "" && strings.TrimSpace(projected.SessionID) == strings.TrimSpace(p.SessionID) {
				sRank = 0
			}
			candidates = append(candidates, matchCandidate{
				ScannerID:          projected.ID,
				ProxyID:            p.ID,
				ScannerTimestampMS: projected.TimestampMS,
				DeltaMS:            delta,
				SessionRank:        sRank,
			})
		}
	}

	for _, sc := range scanners {
		projected, keep := projectForkCandidateRow(sc, forksByHash)
		if !keep {
			continue
		}
		ctxTok := projected.InputTokens + projected.CacheReadInputTokens + projected.CacheCreationInputTokens
		outKey := tokenPairKey{ctx: ctxTok, out: projected.OutputTokens}
		genKey := tokenPairKey{ctx: ctxTok, out: projected.OutputTokens + projected.ReasoningOutputTokens}
		listOut := byOut[outKey]
		listGen := byGen[genKey]
		if len(listOut) == 0 && len(listGen) == 0 {
			continue
		}
		stamp++
		if len(listOut) > 0 {
			checkProxies(projected, listOut)
		}
		if len(listGen) > 0 {
			checkProxies(projected, listGen)
		}
	}

	return candidates, scannerByID, proxyByID, crossLeft, crossRight
}

func materializeAttributionMatches(
	matches []matchCandidate,
	scannerByID map[int64]observationRow,
	proxyByID map[int64]observationRow,
	pricingSnap pricingResolverSnapshot,
	attrIdx *usagepricing.AttributionIndex,
) []usageAttribution {
	if len(matches) == 0 {
		return nil
	}
	attrs := make([]usageAttribution, 0, len(matches))
	for _, m := range matches {
		sc := scannerByID[m.ScannerID]
		px := proxyByID[m.ProxyID]
		model := attrIdx.FormatAttributedModel(sc.Provider, px.Provider, firstNonEmpty(px.Model, sc.Model))
		accountRef := strings.TrimSpace(px.AccountRef)
		pRec := pricingSnap.resolve(attrIdx, model, sc.Provider, accountRef)
		crossProvider := strings.ToLower(strings.TrimSpace(sc.Provider)) != strings.ToLower(strings.TrimSpace(px.Provider))
		costUSD := 0.0
		if pRec != nil {
			costUSD = usagepricing.CalculateCostUSD(usagepricing.Usage{
				InputTokens:              sc.InputTokens,
				OutputTokens:             sc.OutputTokens,
				CacheReadInputTokens:     sc.CacheReadInputTokens,
				CacheCreationInputTokens: sc.CacheCreationInputTokens,
				ReasoningOutputTokens:    sc.ReasoningOutputTokens,
			}, pRec)
		} else if !crossProvider {
			costUSD = clampNonNegFloat(sc.CostUSD)
		}
		attrs = append(attrs, usageAttribution{
			ScannerID:          m.ScannerID,
			ProxyID:            m.ProxyID,
			ScannerTimestampMS: sc.TimestampMS,
			ProxyTimestampMS:   px.TimestampMS,
			Model:              model,
			AccountProvider:    strings.ToLower(strings.TrimSpace(px.Provider)),
			AccountRef:         accountRef,
			CostUSD:            costUSD,
		})
	}
	return attrs
}

func computeAttributionsFromObservations(
	proxies []observationRow,
	scanners []observationRow,
	forksByHash map[string]forkDescriptor,
	pricingSnap pricingResolverSnapshot,
	attrIdx *usagepricing.AttributionIndex,
) (attrs []usageAttribution, crossLeft map[int64]bool, crossRight map[int64]bool) {
	candidates, scannerByID, proxyByID, crossLeft, crossRight := buildObservationCandidates(
		proxies, scanners, forksByHash,
	)
	if len(candidates) == 0 {
		return nil, crossLeft, crossRight
	}
	matches := matchObservationCandidates(candidates)
	if len(matches) == 0 {
		return nil, crossLeft, crossRight
	}
	attrs = materializeAttributionMatches(matches, scannerByID, proxyByID, pricingSnap, attrIdx)
	return attrs, crossLeft, crossRight
}

func isProxyObservation(r observationRow) bool {
	if !strings.HasPrefix(r.SourceKind, "server_") || r.Model == "" {
		return false
	}
	return r.InputTokens > 0 || r.OutputTokens > 0 || r.CacheReadInputTokens > 0 ||
		r.CacheCreationInputTokens > 0 || r.ReasoningOutputTokens > 0
}

func isScannerObservation(r observationRow) bool {
	return (r.SourceKind == "session_jsonl" || r.SourceKind == "session_json") && r.Model != ""
}

func isExcludedCodebuddyNative(provider, sourceKind string) bool {
	if sourceKind != "native_session_done" {
		return false
	}
	_, ok := codebuddyFamilyProviderSet[provider]
	return ok
}

func loadAttributionObservationsConn(
	ctx context.Context,
	conn *sql.Conn,
	attrFromMS, attrToMS, recordHW int64,
	requireScannerGate bool,
) (proxies []observationRow, scanners []observationRow, err error) {
	if attrToMS < attrFromMS {
		return nil, nil, nil
	}
	hw := recordHW
	if hw <= 0 {
		hw = math.MaxInt64
	}
	if requireScannerGate {
		var hasCandidate int
		candErr := conn.QueryRowContext(ctx, `
			SELECT 1 FROM model_usage_records INDEXED BY idx_model_usage_timestamp
			WHERE timestamp_ms BETWEEN ? AND ?
				AND id <= ?
				AND source_kind IN ('session_jsonl', 'session_json')
				AND model != ''
			LIMIT 1`, attrFromMS, attrToMS, hw).Scan(&hasCandidate)
		if candErr == sql.ErrNoRows {
			return nil, nil, nil
		}
		if candErr != nil {
			return nil, nil, fmt.Errorf("检查归因候选失败: %w", candErr)
		}
	}

	queryErr, readErr := streamObservationRows(ctx, conn, `
		SELECT id, event_key, provider, account_ref, session_id, source_kind, model,
			input_tokens, output_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
			cost_usd, timestamp_ms, project, cwd, git_branch
		FROM model_usage_records
		WHERE timestamp_ms BETWEEN ? AND ?
			AND id <= ?
			AND model != ''
			AND (
				source_kind IN ('session_jsonl', 'session_json')
				OR (
					source_kind GLOB 'server_*'
					AND (
						input_tokens > 0 OR output_tokens > 0 OR cache_read_input_tokens > 0
						OR cache_creation_input_tokens > 0 OR reasoning_output_tokens > 0
					)
				)
			)`, []int64{attrFromMS, attrToMS, hw}, func(r observationRow) {
		if isProxyObservation(r) {
			proxies = append(proxies, r)
		} else if isScannerObservation(r) {
			scanners = append(scanners, r)
		}
	})
	if queryErr != nil {
		return nil, nil, fmt.Errorf("扫描归因观测行失败: %w", queryErr)
	}
	if readErr != nil {
		return nil, nil, readErr
	}
	return proxies, scanners, nil
}

func computeAttributionsRangeConn(
	ctx context.Context,
	conn *sql.Conn,
	attrFromMS, attrToMS, recordHW int64,
	forksByHash map[string]forkDescriptor,
	pricingSnap pricingResolverSnapshot,
	attrIdx *usagepricing.AttributionIndex,
) ([]usageAttribution, error) {
	proxies, scanners, err := loadAttributionObservationsConn(ctx, conn, attrFromMS, attrToMS, recordHW, true)
	if err != nil {
		return nil, err
	}
	if len(proxies) == 0 || len(scanners) == 0 {
		return nil, nil
	}
	attrs, _, _ := computeAttributionsFromObservations(proxies, scanners, forksByHash, pricingSnap, attrIdx)
	return attrs, nil
}
