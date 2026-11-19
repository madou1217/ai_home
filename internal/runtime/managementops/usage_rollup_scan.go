package managementops

import (
	"context"
	"database/sql"
	"math"
)

type rollupScanResult struct {
	snapRev             int64
	snapForkRev         int64
	snapPricingRev      int64
	forkDigest          int64
	customPricingDigest int64
	byHour              map[int64]*rollupHourBuild
	unclosedHours       map[int64]bool
}

// scanRollupHourRangeConn 在调用方已持有的只读快照连接上执行 Phase A 规范扫描、
// 归因闭包含并与小时聚合；不开启/提交/回滚/关闭连接，也不获取额外连接。
func (s *UsageStore) scanRollupHourRangeConn(
	ctx context.Context,
	conn *sql.Conn,
	startHour, endHour int64,
	targetHours map[int64]bool,
	pricingCache *rollupSyncPricingCache,
) (rollupScanResult, error) {
	if endHour <= startHour {
		return rollupScanResult{byHour: make(map[int64]*rollupHourBuild)}, nil
	}
	if s == nil || conn == nil {
		return rollupScanResult{}, ErrUsageUnavailable
	}

	var (
		snapRev             int64
		snapForkRev         int64
		snapPricingRev      int64
		forkDigest          int64
		customPricingDigest int64
		byHour              = make(map[int64]*rollupHourBuild)
		unclosedHours       map[int64]bool
	)

	capReport, err := inspectRollupCapabilitiesQueryer(ctx, conn)
	if err != nil {
		return rollupScanResult{}, err
	}
	if !capReport.allReady {
		return rollupScanResult{}, errRollupCapabilitiesNotReady
	}
	meta := capReport.meta
	snapRev = meta.changeRev
	snapForkRev = meta.forkRev
	snapPricingRev = meta.pricingRev

	forks, fDigest, err := s.getCachedForkDescriptorsConn(ctx, conn, snapForkRev)
	if err != nil {
		return rollupScanResult{}, err
	}
	forkDigest = fDigest
	forksByHash := make(map[string]forkDescriptor, len(forks))
	for _, f := range forks {
		forksByHash[f.SourceHash] = f
	}

	// Reuse only within this serial sync, after same-snapshot capability
	// and both persistent DATA pricing revisions have been verified.
	pricingSnap, digest, err := pricingCache.loadConn(ctx, s, conn, capReport)
	if err != nil {
		return rollupScanResult{}, err
	}
	customPricingDigest = digest

	endInclusive := endHour - 1
	padFrom := maxInt64(0, startHour-scannerAfterProxyWindowMS)
	padTo := endInclusive + scannerAfterProxyWindowMS
	if padTo < endInclusive {
		padTo = math.MaxInt64
	}

	var hasScannerFlag int
	scanCheckErr := conn.QueryRowContext(ctx, `
		SELECT 1 FROM model_usage_records INDEXED BY idx_model_usage_timestamp
		WHERE timestamp_ms BETWEEN ? AND ?
			AND source_kind IN ('session_jsonl', 'session_json')
			AND model != ''
		LIMIT 1`, padFrom, padTo).Scan(&hasScannerFlag)
	hasScanner := scanCheckErr == nil
	if scanCheckErr != nil && scanCheckErr != sql.ErrNoRows {
		return rollupScanResult{}, scanCheckErr
	}

	wantHour := func(h int64) bool {
		if h < startHour || h >= endHour {
			return false
		}
		if targetHours != nil {
			return targetHours[h]
		}
		return true
	}

	if !hasScanner {
		// 纯代理/非扫描流：直接单趟流式聚合，零行缓存。
		rows, qErr := conn.QueryContext(ctx, `
			SELECT id, event_key, provider, account_ref, session_id, source_kind, model,
				input_tokens, output_tokens, cache_read_input_tokens,
				cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
				cost_usd, timestamp_ms, project, cwd, git_branch
			FROM model_usage_records
			WHERE timestamp_ms BETWEEN ? AND ?
				AND NOT (provider IN ('codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn') AND source_kind = 'native_session_done')`,
			startHour, endInclusive)
		if qErr != nil {
			return rollupScanResult{}, qErr
		}
		for rows.Next() {
			var r observationRow
			if scanErr := rows.Scan(
				&r.ID, &r.EventKey, &r.Provider, &r.AccountRef, &r.SessionID, &r.SourceKind, &r.Model,
				&r.InputTokens, &r.OutputTokens, &r.CacheReadInputTokens,
				&r.CacheCreationInputTokens, &r.ReasoningOutputTokens, &r.TotalTokens,
				&r.CostUSD, &r.TimestampMS, &r.Project, &r.CWD, &r.GitBranch,
			); scanErr != nil {
				_ = rows.Close()
				return rollupScanResult{}, scanErr
			}
			if r.TimestampMS < 0 {
				continue
			}
			h := hourFloorMS(r.TimestampMS)
			if !wantHour(h) {
				continue
			}
			hb := getOrCreateHourBuild(byHour, h)
			accumulateCanonicalRowIntoHour(hb, r, nil, forksByHash)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			_ = rows.Close()
			return rollupScanResult{}, rowsErr
		}
		_ = rows.Close()
	} else {
		// 含本地扫描行：单趟扫描 [padFrom, padTo]，并对触及目标小时的候选分量做完整边界闭合。
		rows, qErr := conn.QueryContext(ctx, `
			SELECT id, event_key, provider, account_ref, session_id, source_kind, model,
				input_tokens, output_tokens, cache_read_input_tokens,
				cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
				cost_usd, timestamp_ms, project, cwd, git_branch
			FROM model_usage_records
			WHERE timestamp_ms BETWEEN ? AND ?`, padFrom, padTo)
		if qErr != nil {
			return rollupScanResult{}, qErr
		}
		var proxies, scanners, targetRows []observationRow
		for rows.Next() {
			var r observationRow
			if scanErr := rows.Scan(
				&r.ID, &r.EventKey, &r.Provider, &r.AccountRef, &r.SessionID, &r.SourceKind, &r.Model,
				&r.InputTokens, &r.OutputTokens, &r.CacheReadInputTokens,
				&r.CacheCreationInputTokens, &r.ReasoningOutputTokens, &r.TotalTokens,
				&r.CostUSD, &r.TimestampMS, &r.Project, &r.CWD, &r.GitBranch,
			); scanErr != nil {
				_ = rows.Close()
				return rollupScanResult{}, scanErr
			}
			if isProxyObservation(r) {
				proxies = append(proxies, r)
			} else if isScannerObservation(r) {
				scanners = append(scanners, r)
			}
			if r.TimestampMS >= startHour && r.TimestampMS <= endInclusive && !isExcludedCodebuddyNative(r.Provider, r.SourceKind) {
				h := hourFloorMS(r.TimestampMS)
				if wantHour(h) {
					targetRows = append(targetRows, r)
				}
			}
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			_ = rows.Close()
			return rollupScanResult{}, rowsErr
		}
		_ = rows.Close()

		attrs, crossLeft, crossRight, unclosed, closeErr := s.closeMaterializeAttributionsConn(
			ctx, conn, startHour, endHour, wantHour, padFrom, padTo,
			proxies, scanners, forksByHash, pricingSnap,
		)
		if closeErr != nil {
			return rollupScanResult{}, closeErr
		}
		unclosedHours = unclosed

		for h := range crossLeft {
			if wantHour(h) {
				getOrCreateHourBuild(byHour, h).hasLeftBoundaryAttr = true
			}
		}
		for h := range crossRight {
			if wantHour(h) {
				getOrCreateHourBuild(byHour, h).hasRightBoundaryAttr = true
			}
		}

		attrByScanner := make(map[int64]*usageAttribution, len(attrs))
		matchedProxy := make(map[int64]struct{}, len(attrs))
		for i := range attrs {
			a := &attrs[i]
			attrByScanner[a.ScannerID] = a
			matchedProxy[a.ProxyID] = struct{}{}
			sh := hourFloorMS(a.ScannerTimestampMS)
			ph := hourFloorMS(a.ProxyTimestampMS)
			if wantHour(sh) && !unclosedHours[sh] {
				hb := getOrCreateHourBuild(byHour, sh)
				hb.attrs = append(hb.attrs, *a)
				if a.ScannerID > hb.maxRecordID {
					hb.maxRecordID = a.ScannerID
				}
				if a.ProxyID > hb.maxRecordID {
					hb.maxRecordID = a.ProxyID
				}
			}
			if ph != sh && wantHour(ph) && !unclosedHours[ph] {
				hb := getOrCreateHourBuild(byHour, ph)
				hb.attrs = append(hb.attrs, *a)
				if a.ScannerID > hb.maxRecordID {
					hb.maxRecordID = a.ScannerID
				}
				if a.ProxyID > hb.maxRecordID {
					hb.maxRecordID = a.ProxyID
				}
			}
		}
		for _, r := range targetRows {
			h := hourFloorMS(r.TimestampMS)
			if unclosedHours[h] {
				continue
			}
			hb := getOrCreateHourBuild(byHour, h)
			if _, hidden := matchedProxy[r.ID]; hidden {
				if r.ID > hb.maxRecordID {
					hb.maxRecordID = r.ID
				}
				continue
			}
			accumulateCanonicalRowIntoHour(hb, r, attrByScanner[r.ID], forksByHash)
		}
	}

	// 扫描提示词事件（单趟）。
	pRows, pErr := conn.QueryContext(ctx, `
		SELECT rowid, event_key, provider, session_id, timestamp_ms
		FROM model_usage_prompt_events
		WHERE timestamp_ms BETWEEN ? AND ?`, startHour, endInclusive)
	if pErr != nil {
		return rollupScanResult{}, pErr
	}
	for pRows.Next() {
		var rowID, ts int64
		var eventKey, provider, sessionID string
		if scanErr := pRows.Scan(&rowID, &eventKey, &provider, &sessionID, &ts); scanErr != nil {
			_ = pRows.Close()
			return rollupScanResult{}, scanErr
		}
		if ts < 0 {
			continue
		}
		h := hourFloorMS(ts)
		if !wantHour(h) || unclosedHours[h] {
			continue
		}
		hb := getOrCreateHourBuild(byHour, h)
		if rowID > hb.maxPromptRowID {
			hb.maxPromptRowID = rowID
		}
		canonSess, keep, isCodexFile := applyCodexForkToPromptRow(provider, eventKey, sessionID, forksByHash)
		if isCodexFile {
			hb.hasCodexFile = true
		}
		if !keep {
			continue
		}
		hb.prompts[rollupPromptKey{provider: provider, sessionID: canonSess}]++
	}
	if pRowsErr := pRows.Err(); pRowsErr != nil {
		_ = pRows.Close()
		return rollupScanResult{}, pRowsErr
	}
	_ = pRows.Close()

	return rollupScanResult{
		snapRev:             snapRev,
		snapForkRev:         snapForkRev,
		snapPricingRev:      snapPricingRev,
		forkDigest:          forkDigest,
		customPricingDigest: customPricingDigest,
		byHour:              byHour,
		unclosedHours:       unclosedHours,
	}, nil
}
