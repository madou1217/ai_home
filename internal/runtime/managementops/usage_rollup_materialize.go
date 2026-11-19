package managementops

import (
	"context"
	"database/sql"
	"math"
	"sort"
)

func (s *UsageStore) materializeHourRange(
	ctx context.Context,
	startHour, endHour int64,
	targetHours map[int64]bool,
	markCoverage bool,
	pricingCache *rollupSyncPricingCache,
) ([]int64, error) {
	if endHour <= startHour {
		return nil, nil
	}

	// Phase A: 在独立只读快照连接中扫描原始行并在 Go 内存完成规范归因与聚合，不持写锁。
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	snap, err := beginProjectionReadSnapshot(ctx, conn)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}

	var (
		snapRev             int64
		snapForkRev         int64
		snapPricingRev      int64
		forkDigest          int64
		customPricingDigest int64
		byHour              = make(map[int64]*rollupHourBuild)
		unclosedHours       map[int64]bool
		readErr             error
	)

	func() {
		defer func() {
			snap.close()
			_ = conn.Close()
		}()

		capReport, err := inspectRollupCapabilitiesQueryer(ctx, conn)
		if err != nil {
			readErr = err
			return
		}
		if !capReport.allReady {
			readErr = errRollupCapabilitiesNotReady
			return
		}
		meta := capReport.meta
		snapRev = meta.changeRev
		snapForkRev = meta.forkRev
		snapPricingRev = meta.pricingRev

		forks, fDigest, err := s.getCachedForkDescriptorsConn(ctx, conn, snapForkRev)
		if err != nil {
			readErr = err
			return
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
			readErr = err
			return
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
			readErr = scanCheckErr
			return
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
				readErr = qErr
				return
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
					readErr = scanErr
					return
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
				readErr = rowsErr
				return
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
				readErr = qErr
				return
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
					readErr = scanErr
					return
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
				readErr = rowsErr
				return
			}
			_ = rows.Close()

			attrs, crossLeft, crossRight, unclosed, closeErr := s.closeMaterializeAttributionsConn(
				ctx, conn, startHour, endHour, wantHour, padFrom, padTo,
				proxies, scanners, forksByHash, pricingSnap,
			)
			if closeErr != nil {
				readErr = closeErr
				return
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
			readErr = pErr
			return
		}
		for pRows.Next() {
			var rowID, ts int64
			var eventKey, provider, sessionID string
			if scanErr := pRows.Scan(&rowID, &eventKey, &provider, &sessionID, &ts); scanErr != nil {
				_ = pRows.Close()
				readErr = scanErr
				return
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
			readErr = pRowsErr
			return
		}
		_ = pRows.Close()
	}()

	if readErr != nil {
		return nil, readErr
	}

	// Phase B: 在 runImmediateTx 中执行乐观版本校验、跨小时外部失效检测与原子落盘（coord.sem -> s.writeMu -> s.db）。
	builtAtMS := s.now().UnixMilli()
	coord := getRollupCoordinator(s)
	var invalidatedExtHours []int64
	commitErr := s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		invalidatedExtHours = nil

		curCap, capErr := inspectRollupCapabilitiesQueryer(ctx, tx)
		if capErr != nil {
			return capErr
		}
		if !curCap.allReady {
			return errRollupCapabilitiesNotReady
		}
		// Closure may read candidates outside the target chunk. Any fact change
		// after Phase A can alter its optimum even when no target hour is dirty.
		// Reject the entire old snapshot; clear target coverage atomically so
		// this query falls back to live data instead of publishing stale rows.
		if curCap.meta.changeRev != snapRev {
			hours := make(map[int64]bool)
			var ordered []int64
			for h := startHour; h < endHour; h += rollupHourMS {
				if targetHours == nil || targetHours[h] {
					hours[h] = true
					ordered = append(ordered, h)
				}
			}
			if err := invalidateRollupHoursTx(ctx, tx, ordered, curCap.meta.changeRev, 32, true); err != nil {
				return err
			}
			return subtractHoursFromCoverageTx(ctx, tx, hours)
		}
		curForkRev := curCap.meta.forkRev
		curPricingRev := curCap.meta.pricingRev

		skipped := make(map[int64]bool)
		fromUnclosed := make(map[int64]bool)
		for h := range unclosedHours {
			skipped[h] = true
			fromUnclosed[h] = true
		}

		rRows, qErr := tx.QueryContext(ctx, `
			SELECT hour_ms FROM model_usage_rollup_dirty_hours
			WHERE hour_ms >= ? AND hour_ms < ? AND dirty_rev > ?`,
			startHour, endHour, snapRev)
		if qErr != nil {
			return qErr
		}
		for rRows.Next() {
			var h int64
			if scanErr := rRows.Scan(&h); scanErr != nil {
				_ = rRows.Close()
				return scanErr
			}
			skipped[h] = true
		}
		if err := rRows.Err(); err != nil {
			_ = rRows.Close()
			return err
		}
		_ = rRows.Close()

		// 若分叉在只读快照之后发生变化，保守跳过本次全部目标小时（跨小时连通分量可传播）；
		// 若定价在只读快照之后发生变化，跳过含归因小时以待下次按最新定价重算。
		if curForkRev != snapForkRev {
			if targetHours != nil {
				for h := range targetHours {
					skipped[h] = true
				}
			} else {
				for h := startHour; h < endHour; h += rollupHourMS {
					skipped[h] = true
				}
			}
		}
		if curPricingRev != snapPricingRev {
			for h, hb := range byHour {
				if len(hb.attrs) > 0 {
					skipped[h] = true
				}
			}
		}
		// 若跨小时归因分量的一端发生并发写入竞争或触达闭合上限，保守跳过相连的另一端，避免只提交半边归因。
		if len(skipped) > 0 && len(byHour) > 0 {
			for {
				progressed := false
				for h, hb := range byHour {
					leftSkipped := hb.hasLeftBoundaryAttr && h >= rollupHourMS && skipped[h-rollupHourMS]
					rightSkipped := hb.hasRightBoundaryAttr && h <= math.MaxInt64-rollupHourMS && skipped[h+rollupHourMS]
					if !skipped[h] && (leftSkipped || rightSkipped) {
						skipped[h] = true
						progressed = true
					}
					leftUnclosed := hb.hasLeftBoundaryAttr && h >= rollupHourMS && fromUnclosed[h-rollupHourMS]
					rightUnclosed := hb.hasRightBoundaryAttr && h <= math.MaxInt64-rollupHourMS && fromUnclosed[h+rollupHourMS]
					if !fromUnclosed[h] && (leftUnclosed || rightUnclosed) {
						fromUnclosed[h] = true
						progressed = true
					}
				}
				if !progressed {
					break
				}
			}
		}

		commitSet := make(map[int64]bool)
		var hoursToClear []int64
		if targetHours != nil {
			for h := range targetHours {
				if !skipped[h] {
					commitSet[h] = true
					hoursToClear = append(hoursToClear, h)
				}
			}
		} else {
			for h := startHour; h < endHour; h += rollupHourMS {
				if !skipped[h] {
					commitSet[h] = true
					hoursToClear = append(hoursToClear, h)
				}
			}
		}
		sort.Slice(hoursToClear, func(i, j int) bool { return hoursToClear[i] < hoursToClear[j] })

		builtHours := make([]int64, 0, len(byHour))
		for h := range byHour {
			if commitSet[h] {
				builtHours = append(builtHours, h)
			}
		}
		sort.Slice(builtHours, func(i, j int) bool { return builtHours[i] < builtHours[j] })

		// 收集本次提交中跨越 commitSet 边界的新归因，以便在删写前原子检测外部已物化小时是否受影响。
		newByExtHour := make(map[int64][]usageAttribution)
		var newCrossCommitAttrs []usageAttribution
		seenNewAttr := make(map[int64]struct{})
		for _, h := range builtHours {
			for _, a := range byHour[h].attrs {
				if _, dup := seenNewAttr[a.ScannerID]; dup {
					continue
				}
				seenNewAttr[a.ScannerID] = struct{}{}
				sh := hourFloorMS(a.ScannerTimestampMS)
				ph := hourFloorMS(a.ProxyTimestampMS)
				if !commitSet[sh] || !commitSet[ph] {
					newCrossCommitAttrs = append(newCrossCommitAttrs, a)
					if !commitSet[sh] {
						newByExtHour[sh] = append(newByExtHour[sh], a)
					}
					if !commitSet[ph] && ph != sh {
						newByExtHour[ph] = append(newByExtHour[ph], a)
					}
				}
			}
		}

		oldByExtHour := make(map[int64][]usageAttribution)
		forceInvalidateExt := make(map[int64]bool)
		seenOldScanner := make(map[int64]struct{})
		recordOldCrossRow := func(a usageAttribution, sh, ph int64) {
			if commitSet[sh] && commitSet[ph] {
				return
			}
			if _, dup := seenOldScanner[a.ScannerID]; dup {
				return
			}
			seenOldScanner[a.ScannerID] = struct{}{}
			if !commitSet[sh] {
				oldByExtHour[sh] = append(oldByExtHour[sh], a)
			}
			if !commitSet[ph] && ph != sh {
				oldByExtHour[ph] = append(oldByExtHour[ph], a)
			}
		}

		if targetHours == nil && len(skipped) == 0 {
			oldRows, qErr := tx.QueryContext(ctx, `
				SELECT scanner_id, proxy_id, scanner_timestamp_ms, proxy_timestamp_ms,
					scanner_hour_ms, proxy_hour_ms, model, account_provider, account_ref, cost_usd
				FROM model_usage_rollup_attributions
				WHERE (scanner_hour_ms >= ? AND scanner_hour_ms < ? AND (proxy_hour_ms < ? OR proxy_hour_ms >= ?))
				   OR (proxy_hour_ms >= ? AND proxy_hour_ms < ? AND (scanner_hour_ms < ? OR scanner_hour_ms >= ?))`,
				startHour, endHour, startHour, endHour,
				startHour, endHour, startHour, endHour)
			if qErr != nil {
				return qErr
			}
			for oldRows.Next() {
				var a usageAttribution
				var sh, ph int64
				if scanErr := oldRows.Scan(
					&a.ScannerID, &a.ProxyID, &a.ScannerTimestampMS, &a.ProxyTimestampMS,
					&sh, &ph, &a.Model, &a.AccountProvider, &a.AccountRef, &a.CostUSD,
				); scanErr != nil {
					_ = oldRows.Close()
					return scanErr
				}
				recordOldCrossRow(a, sh, ph)
			}
			if err := oldRows.Err(); err != nil {
				_ = oldRows.Close()
				return err
			}
			_ = oldRows.Close()
		} else if len(hoursToClear) > 0 {
			for _, h := range hoursToClear {
				oldRows, qErr := tx.QueryContext(ctx, `
					SELECT scanner_id, proxy_id, scanner_timestamp_ms, proxy_timestamp_ms,
						scanner_hour_ms, proxy_hour_ms, model, account_provider, account_ref, cost_usd
					FROM model_usage_rollup_attributions
					WHERE scanner_hour_ms = ? OR proxy_hour_ms = ?`, h, h)
				if qErr != nil {
					return qErr
				}
				for oldRows.Next() {
					var a usageAttribution
					var sh, ph int64
					if scanErr := oldRows.Scan(
						&a.ScannerID, &a.ProxyID, &a.ScannerTimestampMS, &a.ProxyTimestampMS,
						&sh, &ph, &a.Model, &a.AccountProvider, &a.AccountRef, &a.CostUSD,
					); scanErr != nil {
						_ = oldRows.Close()
						return scanErr
					}
					recordOldCrossRow(a, sh, ph)
				}
				if err := oldRows.Err(); err != nil {
					_ = oldRows.Close()
					return err
				}
				_ = oldRows.Close()
			}
		}

		// 若新写入的跨边界归因将通过 scanner_id/proxy_id 覆盖外部小时上的旧配对，标记所有受影响外部小时失效。
		for _, a := range newCrossCommitAttrs {
			collRows, qErr := tx.QueryContext(ctx, `
				SELECT scanner_id, proxy_id, scanner_hour_ms, proxy_hour_ms
				FROM model_usage_rollup_attributions
				WHERE scanner_id = ? OR proxy_id = ?`, a.ScannerID, a.ProxyID)
			if qErr != nil {
				return qErr
			}
			for collRows.Next() {
				var eS, eP, eSH, ePH int64
				if scanErr := collRows.Scan(&eS, &eP, &eSH, &ePH); scanErr != nil {
					_ = collRows.Close()
					return scanErr
				}
				if eS != a.ScannerID || eP != a.ProxyID {
					if !commitSet[eSH] {
						forceInvalidateExt[eSH] = true
					}
					if !commitSet[ePH] {
						forceInvalidateExt[ePH] = true
					}
				}
			}
			if err := collRows.Err(); err != nil {
				_ = collRows.Close()
				return err
			}
			_ = collRows.Close()
		}

		// 对触达闭合上限的未闭合小时：若先前已物化或覆盖，必须原子清理其旧汇总、移出 coverage 并保持脏状态。
		unclosedToClear := make(map[int64]bool)
		for h := range fromUnclosed {
			matOrCov, checkErr := isHourMaterializedOrCoveredTx(ctx, tx, h)
			if checkErr != nil {
				return checkErr
			}
			if !matOrCov {
				continue
			}
			unclosedToClear[h] = true
			uRows, qErr := tx.QueryContext(ctx, `
				SELECT scanner_hour_ms, proxy_hour_ms
				FROM model_usage_rollup_attributions
				WHERE scanner_hour_ms = ? OR proxy_hour_ms = ?`, h, h)
			if qErr != nil {
				return qErr
			}
			for uRows.Next() {
				var eSH, ePH int64
				if scanErr := uRows.Scan(&eSH, &ePH); scanErr != nil {
					_ = uRows.Close()
					return scanErr
				}
				if !commitSet[eSH] && !fromUnclosed[eSH] {
					forceInvalidateExt[eSH] = true
				}
				if !commitSet[ePH] && !fromUnclosed[ePH] {
					forceInvalidateExt[ePH] = true
				}
			}
			if err := uRows.Err(); err != nil {
				_ = uRows.Close()
				return err
			}
			_ = uRows.Close()
		}

		// 计算需要原子失效的外部已物化/已覆盖小时。
		extCandSet := make(map[int64]struct{})
		for h := range oldByExtHour {
			extCandSet[h] = struct{}{}
		}
		for h := range newByExtHour {
			extCandSet[h] = struct{}{}
		}
		for h := range forceInvalidateExt {
			extCandSet[h] = struct{}{}
		}
		var extToInvalidate []int64
		for hExt := range extCandSet {
			if commitSet[hExt] || unclosedToClear[hExt] {
				continue
			}
			if !forceInvalidateExt[hExt] {
				oldD := computeAttrSliceDigest(oldByExtHour[hExt])
				newD := computeAttrSliceDigest(newByExtHour[hExt])
				if oldD == newD {
					continue
				}
			}
			matOrCov, checkErr := isHourMaterializedOrCoveredTx(ctx, tx, hExt)
			if checkErr != nil {
				return checkErr
			}
			if matOrCov {
				extToInvalidate = append(extToInvalidate, hExt)
			}
		}
		sort.Slice(extToInvalidate, func(i, j int) bool { return extToInvalidate[i] < extToInvalidate[j] })

		// 清理将被重写的小时旧数据。
		if targetHours == nil && len(skipped) == 0 {
			for _, delSQL := range []string{
				`DELETE FROM model_usage_rollup_hourly_model WHERE hour_ms >= ? AND hour_ms < ?`,
				`DELETE FROM model_usage_rollup_hourly_session WHERE hour_ms >= ? AND hour_ms < ?`,
				`DELETE FROM model_usage_rollup_hourly_prompt WHERE hour_ms >= ? AND hour_ms < ?`,
				`DELETE FROM model_usage_rollup_hours WHERE hour_ms >= ? AND hour_ms < ?`,
			} {
				if _, err := tx.ExecContext(ctx, delSQL, startHour, endHour); err != nil {
					return err
				}
			}
			if _, err := tx.ExecContext(ctx, `
				DELETE FROM model_usage_rollup_attributions
				WHERE (scanner_hour_ms >= ? AND scanner_hour_ms < ?)
					OR (proxy_hour_ms >= ? AND proxy_hour_ms < ?)`,
				startHour, endHour, startHour, endHour); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				DELETE FROM model_usage_rollup_dirty_hours
				WHERE hour_ms >= ? AND hour_ms < ? AND dirty_rev <= ?`,
				startHour, endHour, snapRev); err != nil {
				return err
			}
		} else {
			for _, h := range hoursToClear {
				for _, delSQL := range []string{
					`DELETE FROM model_usage_rollup_hourly_model WHERE hour_ms = ?`,
					`DELETE FROM model_usage_rollup_hourly_session WHERE hour_ms = ?`,
					`DELETE FROM model_usage_rollup_hourly_prompt WHERE hour_ms = ?`,
					`DELETE FROM model_usage_rollup_hours WHERE hour_ms = ?`,
				} {
					if _, err := tx.ExecContext(ctx, delSQL, h); err != nil {
						return err
					}
				}
				if _, err := tx.ExecContext(ctx, `
					DELETE FROM model_usage_rollup_attributions
					WHERE scanner_hour_ms = ? OR proxy_hour_ms = ?`, h, h); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `
					DELETE FROM model_usage_rollup_dirty_hours
					WHERE hour_ms = ? AND dirty_rev <= ?`, h, snapRev); err != nil {
					return err
				}
			}
		}

		if err := writeRollupBuildsTx(
			ctx,
			tx,
			builtHours,
			byHour,
			forkDigest,
			snapPricingRev,
			customPricingDigest,
			builtAtMS,
		); err != nil {
			return err
		}

		if markCoverage {
			if len(skipped) == 0 {
				if err := mergeHourCoverageTx(ctx, tx, []hourRange{{StartHour: startHour, EndHour: endHour}}); err != nil {
					return err
				}
			} else {
				skippedList := make([]int64, 0, len(skipped))
				for h := range skipped {
					if h >= startHour && h < endHour {
						skippedList = append(skippedList, h)
					}
				}
				sort.Slice(skippedList, func(i, j int) bool { return skippedList[i] < skippedList[j] })
				var safe []hourRange
				cur := startHour
				for _, rh := range skippedList {
					if rh > cur {
						safe = append(safe, hourRange{StartHour: cur, EndHour: rh})
					}
					cur = rh + rollupHourMS
				}
				if cur < endHour {
					safe = append(safe, hourRange{StartHour: cur, EndHour: endHour})
				}
				if err := mergeHourCoverageTx(ctx, tx, safe); err != nil {
					return err
				}
			}
		}

		if len(extToInvalidate) > 0 || len(unclosedToClear) > 0 {
			newRev, revErr := bumpChangeRevTx(ctx, tx)
			if revErr != nil {
				return revErr
			}
			if len(extToInvalidate) > 0 {
				if invErr := invalidateRollupHoursTx(ctx, tx, extToInvalidate, newRev, 8, false); invErr != nil {
					return invErr
				}
				invalidatedExtHours = append([]int64(nil), extToInvalidate...)
			}
			if len(unclosedToClear) > 0 {
				unclosedList := make([]int64, 0, len(unclosedToClear))
				for h := range unclosedToClear {
					unclosedList = append(unclosedList, h)
				}
				sort.Slice(unclosedList, func(i, j int) bool { return unclosedList[i] < unclosedList[j] })
				if invErr := invalidateRollupHoursTx(ctx, tx, unclosedList, newRev, 16, true); invErr != nil {
					return invErr
				}
				if subErr := subtractHoursFromCoverageTx(ctx, tx, unclosedToClear); subErr != nil {
					return subErr
				}
			}
		}
		return nil
	})
	if commitErr != nil {
		if ro, _ := isSQLiteReadOnlyOrBusy(commitErr); ro {
			coord.mu.Lock()
			coord.readOnly = true
			coord.mu.Unlock()
		}
		return nil, commitErr
	}
	return invalidatedExtHours, nil
}
