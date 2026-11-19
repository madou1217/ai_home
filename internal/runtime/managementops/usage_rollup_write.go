package managementops

import (
	"context"
	"database/sql"
	"strings"
)

const (
	// 各表满批行数均严格压在 SQLite 999 绑定变量上限以内：
	// hours: 64*12=768, model: 64*12=768, session: 48*18=864, prompt: 128*4=512, attr: 64*10=640。
	rollupWriteHourBatchRows    = 64
	rollupWriteModelBatchRows   = 64
	rollupWriteSessionBatchRows = 48
	rollupWritePromptBatchRows  = 128
	rollupWriteAttrBatchRows    = 64

	rollupInsertHoursPrefix = `INSERT OR REPLACE INTO model_usage_rollup_hours (` +
		`hour_ms,max_record_id,max_prompt_rowid,attr_count,attr_digest,fork_digest,` +
		`pricing_rev,pricing_custom_digest,has_codex_file,has_left_boundary_attr,has_right_boundary_attr,built_at_ms) VALUES `
	rollupInsertHoursTuple = "(?,?,?,?,?,?,?,?,?,?,?,?)"

	rollupInsertModelPrefix = `INSERT INTO model_usage_rollup_hourly_model (` +
		`hour_ms,provider,model,account_ref,calls,input_tokens,output_tokens,` +
		`cache_read_input_tokens,cache_creation_input_tokens,reasoning_output_tokens,total_tokens,cost_usd) VALUES `
	rollupInsertModelTuple = "(?,?,?,?,?,?,?,?,?,?,?,?)"

	rollupInsertSessionPrefix = `INSERT INTO model_usage_rollup_hourly_session (` +
		`hour_ms,provider,session_id,model,account_ref,calls,input_tokens,output_tokens,` +
		`cache_read_input_tokens,cache_creation_input_tokens,reasoning_output_tokens,total_tokens,cost_usd,` +
		`min_timestamp_ms,max_timestamp_ms,max_project,max_cwd,max_git_branch) VALUES `
	rollupInsertSessionTuple = "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"

	rollupInsertPromptPrefix = `INSERT INTO model_usage_rollup_hourly_prompt (hour_ms,provider,session_id,prompt_count) VALUES `
	rollupInsertPromptTuple  = "(?,?,?,?)"

	rollupInsertAttrPrefix = `INSERT OR REPLACE INTO model_usage_rollup_attributions (` +
		`scanner_id,proxy_id,scanner_timestamp_ms,proxy_timestamp_ms,` +
		`scanner_hour_ms,proxy_hour_ms,model,account_provider,account_ref,cost_usd) VALUES `
	rollupInsertAttrTuple = "(?,?,?,?,?,?,?,?,?,?)"
)

type txBatchInserter struct {
	tx        *sql.Tx
	prefix    string
	tuple     string
	cols      int
	batchRows int
	rows      int
	args      []any
	fullSQL   string
	fullStmt  *sql.Stmt
}

func newTxBatchInserter(tx *sql.Tx, prefix, tuple string, cols, batchRows int) txBatchInserter {
	return txBatchInserter{tx: tx, prefix: prefix, tuple: tuple, cols: cols, batchRows: batchRows}
}

func (b *txBatchInserter) prepareRow() {
	if b.args == nil {
		b.args = make([]any, 0, b.batchRows*b.cols)
	}
	b.rows++
}

func (b *txBatchInserter) flushIfFull(ctx context.Context) error {
	if b.rows < b.batchRows {
		return nil
	}
	return b.flush(ctx)
}

func (b *txBatchInserter) flush(ctx context.Context) error {
	if b.rows == 0 {
		return nil
	}
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	var err error
	if b.rows == b.batchRows {
		if b.fullStmt == nil {
			if b.fullSQL == "" {
				b.fullSQL = buildValuesSQL(b.prefix, b.tuple, b.batchRows)
			}
			b.fullStmt, err = b.tx.PrepareContext(ctx, b.fullSQL)
			if err != nil {
				return err
			}
		}
		_, err = b.fullStmt.ExecContext(ctx, b.args...)
	} else {
		_, err = b.tx.ExecContext(ctx, buildValuesSQL(b.prefix, b.tuple, b.rows), b.args...)
	}
	clear(b.args)
	b.args = b.args[:0]
	b.rows = 0
	return err
}

func (b *txBatchInserter) close() {
	if b.fullStmt != nil {
		_ = b.fullStmt.Close()
		b.fullStmt = nil
	}
}

func buildValuesSQL(prefix, tuple string, rows int) string {
	var sb strings.Builder
	sb.Grow(len(prefix) + rows*len(tuple) + rows - 1)
	sb.WriteString(prefix)
	for i := range rows {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(tuple)
	}
	return sb.String()
}

func isEmptyRollupHourBuild(hb *rollupHourBuild) bool {
	return hb == nil || (hb.maxRecordID == 0 && hb.maxPromptRowID == 0 && len(hb.attrs) == 0 &&
		len(hb.models) == 0 && len(hb.sessions) == 0 && len(hb.prompts) == 0 &&
		!hb.hasLeftBoundaryAttr && !hb.hasRightBoundaryAttr)
}

func boolToSQLiteInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// writeRollupBuildsTx 在调用方既有的写事务内按有界多行绑定批量落盘五张汇总表。
// 严格保持原逐行写入的空小时跳过判定、数值/浮点原生类型绑定、builtHours 升序与 hb.attrs 顺序及 ScannerID 去重。
func writeRollupBuildsTx(
	ctx context.Context,
	tx *sql.Tx,
	builtHours []int64,
	byHour map[int64]*rollupHourBuild,
	forkDigest int64,
	snapPricingRev int64,
	customPricingDigest int64,
	builtAtMS int64,
) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	if len(builtHours) == 0 {
		return nil
	}

	batches := [5]txBatchInserter{
		newTxBatchInserter(tx, rollupInsertHoursPrefix, rollupInsertHoursTuple, 12, rollupWriteHourBatchRows),
		newTxBatchInserter(tx, rollupInsertModelPrefix, rollupInsertModelTuple, 12, rollupWriteModelBatchRows),
		newTxBatchInserter(tx, rollupInsertSessionPrefix, rollupInsertSessionTuple, 18, rollupWriteSessionBatchRows),
		newTxBatchInserter(tx, rollupInsertPromptPrefix, rollupInsertPromptTuple, 4, rollupWritePromptBatchRows),
		newTxBatchInserter(tx, rollupInsertAttrPrefix, rollupInsertAttrTuple, 10, rollupWriteAttrBatchRows),
	}
	defer func() {
		for i := range batches {
			batches[i].close()
		}
	}()
	hourBatch, modelBatch, sessBatch, promptBatch, attrBatch :=
		&batches[0], &batches[1], &batches[2], &batches[3], &batches[4]

	writtenAttrs := make(map[int64]struct{})
	for _, h := range builtHours {
		if ctx != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		hb := byHour[h]
		if isEmptyRollupHourBuild(hb) {
			continue
		}

		ad := computeAttrSliceDigest(hb.attrs)
		hourBatch.prepareRow()
		hourBatch.args = append(hourBatch.args,
			h, hb.maxRecordID, hb.maxPromptRowID, ad.count, ad.digest, forkDigest,
			snapPricingRev, customPricingDigest,
			boolToSQLiteInt(hb.hasCodexFile), boolToSQLiteInt(hb.hasLeftBoundaryAttr),
			boolToSQLiteInt(hb.hasRightBoundaryAttr), builtAtMS,
		)
		if err := hourBatch.flushIfFull(ctx); err != nil {
			return err
		}

		for mk, mAgg := range hb.models {
			modelBatch.prepareRow()
			modelBatch.args = append(modelBatch.args,
				h, mk.provider, mk.model, mk.accountRef,
				mAgg.calls, mAgg.inputTokens, mAgg.outputTokens, mAgg.cacheReadInputTokens,
				mAgg.cacheCreationInputTokens, mAgg.reasoningOutputTokens, mAgg.totalTokens, mAgg.costUSD,
			)
			if err := modelBatch.flushIfFull(ctx); err != nil {
				return err
			}
		}

		for sk, sAgg := range hb.sessions {
			sessBatch.prepareRow()
			sessBatch.args = append(sessBatch.args,
				h, sk.provider, sk.sessionID, sk.model, sk.accountRef,
				sAgg.calls, sAgg.inputTokens, sAgg.outputTokens, sAgg.cacheReadInputTokens,
				sAgg.cacheCreationInputTokens, sAgg.reasoningOutputTokens, sAgg.totalTokens, sAgg.costUSD,
				sAgg.minTimestampMS, sAgg.maxTimestampMS, sAgg.maxProject, sAgg.maxCWD, sAgg.maxGitBranch,
			)
			if err := sessBatch.flushIfFull(ctx); err != nil {
				return err
			}
		}

		for pk, cnt := range hb.prompts {
			if cnt <= 0 {
				continue
			}
			promptBatch.prepareRow()
			promptBatch.args = append(promptBatch.args, h, pk.provider, pk.sessionID, cnt)
			if err := promptBatch.flushIfFull(ctx); err != nil {
				return err
			}
		}

		for _, a := range hb.attrs {
			if _, dup := writtenAttrs[a.ScannerID]; dup {
				continue
			}
			writtenAttrs[a.ScannerID] = struct{}{}
			attrBatch.prepareRow()
			attrBatch.args = append(attrBatch.args,
				a.ScannerID, a.ProxyID, a.ScannerTimestampMS, a.ProxyTimestampMS,
				hourFloorMS(a.ScannerTimestampMS), hourFloorMS(a.ProxyTimestampMS),
				a.Model, a.AccountProvider, a.AccountRef, a.CostUSD,
			)
			if err := attrBatch.flushIfFull(ctx); err != nil {
				return err
			}
		}
	}

	for i := range batches {
		if err := batches[i].flush(ctx); err != nil {
			return err
		}
	}
	return nil
}
