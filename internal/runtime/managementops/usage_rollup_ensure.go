package managementops

import (
	"context"
	"database/sql"
	"fmt"
)

// ensureRollupSchema 通过描述性能力自检与幂等增量建表确保汇总表、索引与触发器就绪。
// 每次均以只读轻量自检核实实际表/列/索引/触发器，绝不依赖进程内布尔盲信；
// 必须在不持有 *sql.Conn 时调用，严格遵守 coord.sem -> s.writeMu -> s.db 锁顺序。
func (s *UsageStore) ensureRollupSchema(ctx context.Context) (ready bool, writable bool, err error) {
	if s == nil || s.db == nil {
		return false, false, nil
	}
	coord := getRollupCoordinator(s)

	// 先执行纯读描述性能力检查：所需表/列/索引/触发器与修订行均齐备时零写锁，
	// 既兼容只读数据库副本，也避免进程内长期缓存布尔值误信运行期被删除的表/触发器。
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return false, false, err
	}
	capReport, capErr := inspectRollupCapabilitiesQueryer(ctx, conn)
	_ = conn.Close()
	if capErr != nil {
		if ctx.Err() != nil {
			return false, false, ctx.Err()
		}
		return false, false, nil
	}
	if capReport.allReady {
		return true, !coord.isReadOnly(), nil
	}
	if coord.isReadOnly() {
		return false, false, nil
	}

	if err := coord.acquireSync(ctx); err != nil {
		return false, false, err
	}
	defer coord.releaseSync()

	if coord.isReadOnly() {
		return false, false, nil
	}

	// 需要幂等补齐表、索引、触发器或重建不完整派生汇总表：通过 runImmediateTx 原子执行。
	repairedDerived := false
	txErr := s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		cur, err := inspectRollupCapabilitiesQueryer(ctx, tx)
		if err != nil {
			return err
		}
		if cur.allReady {
			return nil
		}

		// 若某个派生汇总表缺列，先删除该派生表以便重建（仅触碰派生表，保留既有未知扩展列，绝不触碰原始事实表）。
		for _, spec := range requiredRollupTables {
			if cur.mismatchedTables[spec.name] {
				if _, dropErr := tx.ExecContext(ctx, "DROP TABLE IF EXISTS "+spec.name); dropErr != nil {
					return fmt.Errorf("重建不完整用量汇总表 %s 失败: %w", spec.name, dropErr)
				}
			}
		}
		for _, spec := range requiredRollupTables {
			if _, execErr := tx.ExecContext(ctx, spec.ddl); execErr != nil {
				return fmt.Errorf("初始化用量汇总表 %s 失败: %w", spec.name, execErr)
			}
		}
		for _, idx := range requiredRollupIndexes {
			if _, execErr := tx.ExecContext(ctx, idx.ddl); execErr != nil {
				return fmt.Errorf("初始化用量汇总索引 %s 失败: %w", idx.name, execErr)
			}
		}

		// 任何派生汇总表缺失、缺列、触发器缺失或修订行不完整，都可能导致 coverage 与派生表脱节；
		// 必须在同一事务内原子清空全部派生表与 coverage 并重装触发器，防止信任空表或陈旧 coverage。
		needResetDerived := !cur.meta.triggersReady ||
			!cur.meta.hasChangeRev ||
			!cur.meta.hasForkRev ||
			!cur.meta.hasPricingRev ||
			len(cur.missingTables) > 0 ||
			len(cur.mismatchedTables) > 0 ||
			len(cur.missingTriggers) > 0
		seedRev := maxInt64(1, s.now().UnixMicro())
		if needResetDerived {
			repairedDerived = true
			for _, tbl := range []string{
				"model_usage_rollup_coverage",
				"model_usage_rollup_dirty_hours",
				"model_usage_rollup_hours",
				"model_usage_rollup_hourly_model",
				"model_usage_rollup_hourly_session",
				"model_usage_rollup_hourly_prompt",
				"model_usage_rollup_attributions",
			} {
				if _, delErr := tx.ExecContext(ctx, "DELETE FROM "+tbl); delErr != nil {
					return delErr
				}
			}
			for _, trig := range rollupTriggerDefs {
				if _, dropErr := tx.ExecContext(ctx, "DROP TRIGGER IF EXISTS "+trig.name); dropErr != nil {
					return dropErr
				}
			}
		}

		if _, seedErr := tx.ExecContext(ctx, `
			INSERT OR IGNORE INTO model_usage_rollup_meta (key, int_val, text_val) VALUES
				('triggers_ready', 0, ''),
				('change_rev', ?, ''),
				('fork_rev', ?, ''),
				('pricing_rev', ?, '')`, seedRev, seedRev, seedRev); seedErr != nil {
			return seedErr
		}
		if needResetDerived {
			if _, bumpErr := tx.ExecContext(ctx, `
				UPDATE model_usage_rollup_meta
				SET int_val = int_val + 1
				WHERE key IN ('change_rev', 'fork_rev', 'pricing_rev')`); bumpErr != nil {
				return bumpErr
			}
		}
		for _, trig := range rollupTriggerDefs {
			if _, trigErr := tx.ExecContext(ctx, trig.ddl); trigErr != nil {
				return fmt.Errorf("创建用量汇总触发器 %s 失败: %w", trig.name, trigErr)
			}
		}
		if _, upErr := tx.ExecContext(ctx, `
			INSERT INTO model_usage_rollup_meta (key, int_val, text_val) VALUES ('triggers_ready', 1, '')
			ON CONFLICT(key) DO UPDATE SET int_val = 1`); upErr != nil {
			return upErr
		}
		return nil
	})
	if txErr != nil {
		if ctx.Err() != nil {
			return false, false, ctx.Err()
		}
		ro, busy := isSQLiteReadOnlyOrBusy(txErr)
		if ro {
			coord.mu.Lock()
			coord.readOnly = true
			coord.mu.Unlock()
			return false, false, nil
		}
		if busy {
			return false, false, nil
		}
		return false, false, nil
	}

	if repairedDerived {
		coord.invalidateForkCache()
	}
	return true, true, nil
}

// UsageChangeRevision 返回由触发器维护的持久数据变更代次，供跨连接/跨进程缓存失效判定使用。
// 能力不完整或触发器缺失时 fail-closed 返回 0。
func (s *UsageStore) UsageChangeRevision(ctx context.Context) (int64, error) {
	if s == nil || s.db == nil {
		return 0, ErrUsageUnavailable
	}
	ready, _, err := s.ensureRollupSchema(ctx)
	if err != nil {
		return 0, err
	}
	if !ready {
		return 0, nil
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = conn.Close() }()
	capReport, err := inspectRollupCapabilitiesQueryer(ctx, conn)
	if err != nil || !capReport.allReady {
		return 0, err
	}
	return capReport.meta.changeRev, nil
}

// EnsureUsageRollupSynced 在不持有调用方数据库连接的情况下增量同步查询窗口内的完整小时汇总。
// 可在 openPreparedProjection / PrepareDashboardProjection 之前调用，只读库或遇忙自动降级不报错。
func (s *UsageStore) EnsureUsageRollupSynced(ctx context.Context, query UsageQuery) error {
	if s == nil || s.db == nil {
		return nil
	}
	q := normalizeUsageQueryBounds(query)
	firstFull, lastFullEnd := fullHourWindow(q.FromMS, q.ToMS)
	if firstFull >= lastFullEnd {
		return nil
	}
	return s.ensureRollupSyncedForRange(ctx, firstFull, lastFullEnd)
}
