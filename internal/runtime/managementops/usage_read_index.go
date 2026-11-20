package managementops

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

const (
	usageObservationCoverTableName    = "model_usage_records"
	usageObservationCoverIndexName    = "idx_model_usage_observation_cover"
	usageObservationCoverBuildTimeout = 30 * time.Second
	createObservationCoverIndexSQL    = `CREATE INDEX IF NOT EXISTS idx_model_usage_observation_cover ON model_usage_records(timestamp_ms,id,event_key,provider,account_ref,session_id,source_kind,model,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,reasoning_output_tokens,total_tokens,cost_usd,project,cwd,git_branch)`
)

var usageObservationCoverColumns = [...]string{
	"timestamp_ms", "id", "event_key", "provider", "account_ref", "session_id",
	"source_kind", "model", "input_tokens", "output_tokens", "cache_read_input_tokens",
	"cache_creation_input_tokens", "reasoning_output_tokens", "total_tokens", "cost_usd",
	"project", "cwd", "git_branch",
}

type readIndexState uint8

const (
	readIndexMissing readIndexState = iota
	readIndexReady
	readIndexMismatch
)

// ensureReadIndex 在构造阶段通过独立连接校验并按需原子创建观测覆盖索引；仅父 ctx 取消时返回错误。
func (s *UsageStore) ensureReadIndex(ctx context.Context) (ready bool, resultErr error) {
	if s == nil || s.db == nil {
		return false, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// Run after the borrowed connection closes: parent cancellation wins on all exits.
	defer func() {
		if err := ctx.Err(); err != nil {
			ready, resultErr = false, err
		}
	}()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return failOrSkipReadIndex(ctx, "acquire conn", err)
	}
	defer func() { _ = conn.Close() }()

	switch state, reason, err := inspectObservationCoverIndexConn(ctx, conn); {
	case err != nil:
		return failOrSkipReadIndex(ctx, "inspect", err)
	case state == readIndexReady:
		return true, nil
	case state == readIndexMismatch:
		log.Printf("[aih] usage read index unavailable: %s mismatch (%s); skipping", usageObservationCoverIndexName, reason)
		return false, nil
	}

	ddlCtx, cancel := context.WithTimeout(ctx, usageObservationCoverBuildTimeout)
	_, ddlErr := conn.ExecContext(ddlCtx, createObservationCoverIndexSQL)
	cancel()
	if ddlErr != nil {
		return failOrSkipReadIndex(ctx, "create "+usageObservationCoverIndexName, ddlErr)
	}
	postState, postReason, postErr := inspectObservationCoverIndexConn(ctx, conn)
	if postErr != nil {
		return failOrSkipReadIndex(ctx, "verify "+usageObservationCoverIndexName, postErr)
	}
	if postState != readIndexReady {
		log.Printf("[aih] usage read index unavailable: post-create %s mismatch (%s)", usageObservationCoverIndexName, postReason)
		return false, nil
	}
	return true, nil
}

func failOrSkipReadIndex(parentCtx context.Context, stage string, err error) (bool, error) {
	if ctxErr := parentCtx.Err(); ctxErr != nil {
		return false, ctxErr
	}
	log.Printf("[aih] usage read index unavailable: %s (%s)", stage, summarizeReadIndexErr(err))
	return false, nil
}

func inspectObservationCoverIndexConn(ctx context.Context, conn *sql.Conn) (readIndexState, string, error) {
	var tblName string
	err := conn.QueryRowContext(ctx,
		`SELECT tbl_name FROM main.sqlite_master WHERE type = 'index' AND lower(name) = lower(?) LIMIT 1`,
		usageObservationCoverIndexName).Scan(&tblName)
	if errors.Is(err, sql.ErrNoRows) {
		return readIndexMissing, "", nil
	}
	if err != nil {
		return readIndexMissing, "", err
	}
	if !strings.EqualFold(tblName, usageObservationCoverTableName) {
		return readIndexMismatch, "owner_table", nil
	}

	listRows, err := conn.QueryContext(ctx, "PRAGMA main.index_list('model_usage_records')")
	if err != nil {
		return readIndexMissing, "", err
	}
	foundMeta, metaOK := false, false
	for listRows.Next() {
		var seq, unique, partial int
		var name, origin string
		if scanErr := listRows.Scan(&seq, &name, &unique, &origin, &partial); scanErr != nil {
			_ = listRows.Close()
			return readIndexMissing, "", scanErr
		}
		if strings.EqualFold(name, usageObservationCoverIndexName) {
			foundMeta, metaOK = true, unique == 0 && partial == 0 && origin == "c"
		}
	}
	listErr := listRows.Err()
	closeErr := listRows.Close()
	if listErr != nil {
		return readIndexMissing, "", listErr
	}
	if closeErr != nil {
		return readIndexMissing, "", closeErr
	}
	if !foundMeta || !metaOK {
		return readIndexMismatch, "index_list_flags", nil
	}

	xRows, err := conn.QueryContext(ctx, "PRAGMA main.index_xinfo('idx_model_usage_observation_cover')")
	if err != nil {
		return readIndexMissing, "", err
	}
	defer func() { _ = xRows.Close() }()

	keyCount, rowIdx, sawAux := 0, 0, false
	for xRows.Next() {
		var seqno, cid, desc, key int
		var name, coll sql.NullString
		if scanErr := xRows.Scan(&seqno, &cid, &name, &desc, &coll, &key); scanErr != nil {
			return readIndexMissing, "", scanErr
		}
		if seqno != rowIdx {
			return readIndexMismatch, "seqno_order", nil
		}
		rowIdx++
		if key == 1 {
			if sawAux || keyCount >= len(usageObservationCoverColumns) || cid < 0 || !name.Valid ||
				name.String != usageObservationCoverColumns[keyCount] || desc != 0 || !coll.Valid || coll.String != "BINARY" {
				return readIndexMismatch, "key_column_spec", nil
			}
			keyCount++
		} else if key != 0 || sawAux || keyCount != len(usageObservationCoverColumns) || cid != -1 {
			return readIndexMismatch, "aux_column_spec", nil
		} else {
			sawAux = true
		}
	}
	if rowsErr := xRows.Err(); rowsErr != nil {
		return readIndexMissing, "", rowsErr
	}
	if err := xRows.Close(); err != nil {
		return readIndexMissing, "", err
	}
	if keyCount != len(usageObservationCoverColumns) {
		return readIndexMismatch, "key_column_count", nil
	}
	return readIndexReady, "", nil
}

func summarizeReadIndexErr(err error) string {
	if err == nil {
		return "unknown"
	}
	ro, busy := isSQLiteReadOnlyOrBusy(err)
	msg, kind := strings.ToLower(err.Error()), "sqlite_error"
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		kind = "timeout_30s"
	case ro:
		kind = "readonly"
	case busy:
		kind = "busy"
	case strings.Contains(msg, "full") || strings.Contains(msg, "ioerr") || strings.Contains(msg, "disk"):
		kind = "storage_or_io"
	case strings.Contains(msg, "interrupt"):
		kind = "interrupted"
	}
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		return fmt.Sprintf("%s code=%d", kind, coded.Code())
	}
	return kind
}
