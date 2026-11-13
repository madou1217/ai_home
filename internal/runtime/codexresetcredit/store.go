package codexresetcredit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	resetCreditsTable    = "codex_reset_credits"
	resetOperationsTable = "codex_reset_operations"
)

func requireAccountRef(raw string) (string, error) {
	ref, err := accountcore.ParseAccountRef(strings.TrimSpace(raw))
	if err != nil {
		return "", newCodedError("invalid_account_ref", "账号引用无效", http.StatusBadRequest)
	}
	return ref.String(), nil
}

func openResetDatabase(ctx context.Context, aiHomeDir string, createIfMissing bool) (*sql.DB, error) {
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, newCodedError("codex_reset_store_unavailable", err.Error(), http.StatusServiceUnavailable)
	}
	if !createIfMissing {
		info, statErr := os.Stat(dbPath)
		if statErr != nil || !info.Mode().IsRegular() {
			return nil, nil
		}
	} else {
		if mkErr := os.MkdirAll(filepath.Dir(dbPath), 0o700); mkErr != nil {
			return nil, newCodedError("codex_reset_store_unavailable", mkErr.Error(), http.StatusServiceUnavailable)
		}
	}
	db, err := openImmediateSQLite(ctx, dbPath)
	if err != nil {
		return nil, newCodedError("codex_reset_store_unavailable", err.Error(), http.StatusServiceUnavailable)
	}
	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := ensureResetCreditTables(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func ensureResetCreditTables(ctx context.Context, db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS account_refs (
			account_ref TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS ` + resetCreditsTable + ` (
			account_ref TEXT NOT NULL,
			credit_id TEXT NOT NULL,
			status TEXT NOT NULL,
			granted_at INTEGER,
			expires_at INTEGER,
			first_seen_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL,
			consumed_at INTEGER,
			consumed_operation_id TEXT,
			status_source TEXT NOT NULL,
			PRIMARY KEY(account_ref, credit_id),
			FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS ` + resetOperationsTable + ` (
			operation_id TEXT PRIMARY KEY,
			account_ref TEXT NOT NULL,
			credit_id TEXT NOT NULL,
			inventory_version TEXT NOT NULL,
			status TEXT NOT NULL,
			outcome TEXT,
			requested_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			before_count INTEGER NOT NULL,
			after_count INTEGER,
			error_code TEXT,
			FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_codex_reset_credits_account_status_expiry
			ON ` + resetCreditsTable + `(account_ref, status, expires_at)`,
		`CREATE INDEX IF NOT EXISTS idx_codex_reset_operations_account_requested
			ON ` + resetOperationsTable + `(account_ref, requested_at DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_reset_operations_account_active
			ON ` + resetOperationsTable + `(account_ref)
			WHERE status IN ('consuming', 'unknown')`,
	}
	for _, stmt := range stmts {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func ensureAccountRefInTx(ctx context.Context, tx *sql.Tx, accountRef string, nowMS int64) error {
	_, err := tx.ExecContext(ctx,
		`INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
		 VALUES (?, 'codex', ?, ?)
		 ON CONFLICT(account_ref) DO NOTHING`,
		accountRef, nowMS, nowMS)
	return err
}

func deriveExpiredCreditsInTx(ctx context.Context, tx *sql.Tx, accountRef string, nowMS int64) error {
	_, err := tx.ExecContext(ctx,
		`UPDATE `+resetCreditsTable+`
		 SET status = 'expired', status_source = 'derived'
		 WHERE account_ref = ?
		   AND status IN ('available', 'missing')
		   AND expires_at IS NOT NULL
		   AND expires_at <= ?`,
		accountRef, nowMS)
	return err
}

func nullInt64Ptr(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	val := v.Int64
	return &val
}

func nullableInt64Arg(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullableStringArg(s string) any {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func scanCreditRow(scanner interface {
	Scan(dest ...any) error
}) (*CreditRecord, error) {
	var rec CreditRecord
	var grantedAt, expiresAt, consumedAt sql.NullInt64
	var consumedOpID sql.NullString
	err := scanner.Scan(
		&rec.AccountRef,
		&rec.CreditID,
		&rec.Status,
		&grantedAt,
		&expiresAt,
		&rec.FirstSeenAt,
		&rec.LastSeenAt,
		&consumedAt,
		&consumedOpID,
		&rec.StatusSource,
	)
	if err != nil {
		return nil, err
	}
	rec.AccountRef = strings.TrimSpace(rec.AccountRef)
	rec.CreditID = strings.TrimSpace(rec.CreditID)
	rec.Status = strings.TrimSpace(rec.Status)
	rec.GrantedAt = nullInt64Ptr(grantedAt)
	rec.ExpiresAt = nullInt64Ptr(expiresAt)
	rec.ConsumedAt = nullInt64Ptr(consumedAt)
	rec.ConsumedOperationID = strings.TrimSpace(consumedOpID.String)
	rec.StatusSource = strings.TrimSpace(rec.StatusSource)
	return &rec, nil
}

func scanOperationRow(scanner interface {
	Scan(dest ...any) error
}) (*OperationRecord, error) {
	var rec OperationRecord
	var outcome, errorCode sql.NullString
	var completedAt, afterCount sql.NullInt64
	err := scanner.Scan(
		&rec.OperationID,
		&rec.AccountRef,
		&rec.CreditID,
		&rec.InventoryVersion,
		&rec.Status,
		&outcome,
		&rec.RequestedAt,
		&rec.UpdatedAt,
		&completedAt,
		&rec.BeforeCount,
		&afterCount,
		&errorCode,
	)
	if err != nil {
		return nil, err
	}
	rec.OperationID = strings.TrimSpace(rec.OperationID)
	rec.AccountRef = strings.TrimSpace(rec.AccountRef)
	rec.CreditID = strings.TrimSpace(rec.CreditID)
	rec.InventoryVersion = strings.TrimSpace(rec.InventoryVersion)
	rec.Status = strings.TrimSpace(rec.Status)
	rec.Outcome = strings.TrimSpace(outcome.String)
	rec.CompletedAt = nullInt64Ptr(completedAt)
	rec.AfterCount = nullInt64Ptr(afterCount)
	rec.ErrorCode = strings.TrimSpace(errorCode.String)
	return &rec, nil
}

// SyncInventory 将上游库存与本地保护态合并落盘。
func SyncInventory(ctx context.Context, aiHomeDir string, accountRef string, inventory Inventory, nowMS int64) error {
	normalizedRef, err := requireAccountRef(accountRef)
	if err != nil {
		return err
	}
	db, err := openResetDatabase(ctx, aiHomeDir, true)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if err := ensureAccountRefInTx(ctx, tx, normalizedRef, nowMS); err != nil {
		return err
	}

	seen := map[string]struct{}{}
	for _, credit := range inventory.Credits {
		creditID := strings.TrimSpace(credit.CreditID)
		if creditID == "" {
			continue
		}
		if _, dup := seen[creditID]; dup {
			continue
		}
		seen[creditID] = struct{}{}

		var existingStatus string
		var consumedAt sql.NullInt64
		var consumedOpID sql.NullString
		hasExisting := false
		rowErr := tx.QueryRowContext(ctx,
			`SELECT status, consumed_at, consumed_operation_id FROM `+resetCreditsTable+` WHERE account_ref = ? AND credit_id = ?`,
			normalizedRef, creditID).Scan(&existingStatus, &consumedAt, &consumedOpID)
		if rowErr == nil {
			hasExisting = true
		} else if !errors.Is(rowErr, sql.ErrNoRows) {
			return rowErr
		}

		protected := hasExisting && (existingStatus == "consuming" || existingStatus == "consumed" || existingStatus == "unknown")
		status := credit.Status
		if status == "" {
			status = "unknown"
		}
		source := "upstream"
		if protected {
			status = strings.TrimSpace(existingStatus)
			source = "local"
		}

		var consumedAtArg any
		if consumedAt.Valid {
			consumedAtArg = consumedAt.Int64
		}
		var consumedOpArg any
		if strings.TrimSpace(consumedOpID.String) != "" {
			consumedOpArg = strings.TrimSpace(consumedOpID.String)
		}

		_, err := tx.ExecContext(ctx,
			`INSERT INTO `+resetCreditsTable+` (
				account_ref, credit_id, status, granted_at, expires_at,
				first_seen_at, last_seen_at, consumed_at, consumed_operation_id, status_source
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(account_ref, credit_id) DO UPDATE SET
				status = excluded.status,
				granted_at = COALESCE(excluded.granted_at, `+resetCreditsTable+`.granted_at),
				expires_at = COALESCE(excluded.expires_at, `+resetCreditsTable+`.expires_at),
				last_seen_at = excluded.last_seen_at,
				consumed_at = excluded.consumed_at,
				consumed_operation_id = excluded.consumed_operation_id,
				status_source = excluded.status_source`,
			normalizedRef,
			creditID,
			status,
			nullableInt64Arg(credit.GrantedAt),
			nullableInt64Arg(credit.ExpiresAt),
			nowMS,
			nowMS,
			consumedAtArg,
			consumedOpArg,
			source,
		)
		if err != nil {
			return err
		}
	}

	if inventory.DetailsComplete {
		rows, err := tx.QueryContext(ctx,
			`SELECT credit_id FROM `+resetCreditsTable+` WHERE account_ref = ? AND status = 'available'`,
			normalizedRef)
		if err != nil {
			return err
		}
		var missingIDs []string
		for rows.Next() {
			var cid string
			if err := rows.Scan(&cid); err != nil {
				_ = rows.Close()
				return err
			}
			cid = strings.TrimSpace(cid)
			if _, ok := seen[cid]; !ok {
				missingIDs = append(missingIDs, cid)
			}
		}
		_ = rows.Close()
		for _, cid := range missingIDs {
			if _, err := tx.ExecContext(ctx,
				`UPDATE `+resetCreditsTable+` SET status = 'missing', status_source = 'reconciled'
				 WHERE account_ref = ? AND credit_id = ? AND status = 'available'`,
				normalizedRef, cid); err != nil {
				return err
			}
		}
	}

	if err := deriveExpiredCreditsInTx(ctx, tx, normalizedRef, nowMS); err != nil {
		return err
	}
	return tx.Commit()
}

// ListHistory 返回账号的重置卡完整历史（自动标记已到期卡）。
func ListHistory(ctx context.Context, aiHomeDir string, accountRef string, nowMS int64) ([]CreditRecord, error) {
	normalizedRef, err := requireAccountRef(accountRef)
	if err != nil {
		return nil, err
	}
	db, err := openResetDatabase(ctx, aiHomeDir, false)
	if err != nil || db == nil {
		return []CreditRecord{}, err
	}
	defer func() { _ = db.Close() }()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := deriveExpiredCreditsInTx(ctx, tx, normalizedRef, nowMS); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT account_ref, credit_id, status, granted_at, expires_at, first_seen_at, last_seen_at, consumed_at, consumed_operation_id, status_source
		 FROM `+resetCreditsTable+`
		 WHERE account_ref = ?
		 ORDER BY expires_at IS NULL, expires_at, granted_at, credit_id`,
		normalizedRef)
	if err != nil {
		return nil, err
	}
	result := make([]CreditRecord, 0)
	for rows.Next() {
		rec, err := scanCreditRow(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		if rec != nil {
			result = append(result, *rec)
		}
	}
	_ = rows.Close()
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

// GetOperation 按 operationId 查询单条操作记录。
func GetOperation(ctx context.Context, aiHomeDir string, operationID string) (*OperationRecord, error) {
	id := strings.TrimSpace(operationID)
	if id == "" {
		return nil, nil
	}
	db, err := openResetDatabase(ctx, aiHomeDir, false)
	if err != nil || db == nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()

	row := db.QueryRowContext(ctx,
		`SELECT operation_id, account_ref, credit_id, inventory_version, status, outcome,
		        requested_at, updated_at, completed_at, before_count, after_count, error_code
		 FROM `+resetOperationsTable+` WHERE operation_id = ?`, id)
	rec, err := scanOperationRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return rec, nil
}

// GetActiveOperation 查询账号当前处于 consuming 或 unknown 状态的操作。
func GetActiveOperation(ctx context.Context, aiHomeDir string, accountRef string) (*OperationRecord, error) {
	normalizedRef, err := requireAccountRef(accountRef)
	if err != nil {
		return nil, err
	}
	db, err := openResetDatabase(ctx, aiHomeDir, false)
	if err != nil || db == nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()

	row := db.QueryRowContext(ctx,
		`SELECT operation_id, account_ref, credit_id, inventory_version, status, outcome,
		        requested_at, updated_at, completed_at, before_count, after_count, error_code
		 FROM `+resetOperationsTable+`
		 WHERE account_ref = ? AND status IN ('consuming', 'unknown')
		 ORDER BY requested_at DESC LIMIT 1`, normalizedRef)
	rec, err := scanOperationRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return rec, nil
}

// ReserveOperation 原子预占一次重置消费操作。
func ReserveOperation(
	ctx context.Context,
	aiHomeDir string,
	operationID string,
	accountRef string,
	creditID string,
	inventoryVersion string,
	beforeCount int,
	nowMS int64,
) (created bool, operation *OperationRecord, err error) {
	opID := strings.TrimSpace(operationID)
	normalizedRef, err := requireAccountRef(accountRef)
	if err != nil {
		return false, nil, err
	}
	cid := strings.TrimSpace(creditID)
	invVer := strings.TrimSpace(inventoryVersion)
	if opID == "" || invVer == "" {
		return false, nil, newCodedError("codex_reset_operation_invalid", "重置请求无效", http.StatusBadRequest)
	}
	if beforeCount < 0 {
		beforeCount = 0
	}

	db, err := openResetDatabase(ctx, aiHomeDir, true)
	if err != nil {
		return false, nil, err
	}
	defer func() { _ = db.Close() }()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := ensureAccountRefInTx(ctx, tx, normalizedRef, nowMS); err != nil {
		return false, nil, err
	}

	existing, err := getOperationInTx(ctx, tx, opID)
	if err != nil {
		return false, nil, err
	}
	if existing != nil {
		if existing.AccountRef != normalizedRef || existing.CreditID != cid || existing.InventoryVersion != invVer {
			return false, nil, newCodedError("codex_reset_idempotency_conflict", "", http.StatusConflict)
		}
		if err := tx.Commit(); err != nil {
			return false, nil, err
		}
		return false, existing, nil
	}

	activeRow := tx.QueryRowContext(ctx,
		`SELECT operation_id, account_ref, credit_id, inventory_version, status, outcome,
		        requested_at, updated_at, completed_at, before_count, after_count, error_code
		 FROM `+resetOperationsTable+`
		 WHERE account_ref = ? AND status IN ('consuming', 'unknown')
		 ORDER BY requested_at DESC LIMIT 1`, normalizedRef)
	active, err := scanOperationRow(activeRow)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, nil, err
	}
	if active != nil {
		code := "codex_reset_operation_in_progress"
		if active.Status == "unknown" {
			code = "codex_reset_operation_unknown"
		}
		return false, nil, newCodedError(code, "", http.StatusConflict)
	}

	if cid != "" {
		var creditStatus string
		err := tx.QueryRowContext(ctx,
			`SELECT status FROM `+resetCreditsTable+` WHERE account_ref = ? AND credit_id = ?`,
			normalizedRef, cid).Scan(&creditStatus)
		if errors.Is(err, sql.ErrNoRows) || strings.TrimSpace(creditStatus) != "available" {
			return false, nil, newCodedError("codex_reset_credit_unavailable", "没有可用的 Codex 重置卡", http.StatusConflict)
		}
		if err != nil {
			return false, nil, err
		}
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO `+resetOperationsTable+` (
			operation_id, account_ref, credit_id, inventory_version, status, outcome,
			requested_at, updated_at, completed_at, before_count, after_count, error_code
		) VALUES (?, ?, ?, ?, 'consuming', NULL, ?, ?, NULL, ?, NULL, NULL)`,
		opID, normalizedRef, cid, invVer, nowMS, nowMS, beforeCount)
	if err != nil {
		return false, nil, err
	}
	if cid != "" {
		if _, err := tx.ExecContext(ctx,
			`UPDATE `+resetCreditsTable+`
			 SET status = 'consuming', consumed_operation_id = ?, status_source = 'local'
			 WHERE account_ref = ? AND credit_id = ?`,
			opID, normalizedRef, cid); err != nil {
			return false, nil, err
		}
	}

	op, err := getOperationInTx(ctx, tx, opID)
	if err != nil {
		return false, nil, err
	}
	if err := tx.Commit(); err != nil {
		return false, nil, err
	}
	return true, op, nil
}

// MarkOperationUnknown 把进行中的消费标记为 unknown（需人工或自动核对）。
func MarkOperationUnknown(ctx context.Context, aiHomeDir string, operationID string, errorCode string, nowMS int64) (*OperationRecord, error) {
	opID := strings.TrimSpace(operationID)
	if opID == "" {
		return nil, newCodedError("codex_reset_operation_invalid", "", http.StatusBadRequest)
	}
	db, err := openResetDatabase(ctx, aiHomeDir, true)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	op, err := getOperationInTx(ctx, tx, opID)
	if err != nil {
		return nil, err
	}
	if op == nil {
		return nil, newCodedError("codex_reset_operation_not_found", "", http.StatusNotFound)
	}
	if op.Status != "consuming" && op.Status != "unknown" {
		return op, nil
	}
	code := strings.TrimSpace(errorCode)
	if code == "" {
		code = "codex_reset_result_unknown"
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE `+resetOperationsTable+` SET status = 'unknown', updated_at = ?, error_code = ? WHERE operation_id = ?`,
		nowMS, code, opID); err != nil {
		return nil, err
	}
	if op.CreditID != "" {
		if _, err := tx.ExecContext(ctx,
			`UPDATE `+resetCreditsTable+` SET status = 'unknown', status_source = 'local' WHERE account_ref = ? AND credit_id = ?`,
			op.AccountRef, op.CreditID); err != nil {
			return nil, err
		}
	}
	updated, err := getOperationInTx(ctx, tx, opID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return updated, nil
}

// CompleteOperation 结算一次消费操作（succeeded 或 no_effect）。
func CompleteOperation(ctx context.Context, aiHomeDir string, operationID string, outcome string, afterCount *int64, nowMS int64) (*OperationRecord, error) {
	opID := strings.TrimSpace(operationID)
	out := strings.TrimSpace(outcome)
	if opID == "" || out == "" {
		return nil, newCodedError("codex_reset_operation_invalid", "", http.StatusBadRequest)
	}
	db, err := openResetDatabase(ctx, aiHomeDir, true)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	op, err := getOperationInTx(ctx, tx, opID)
	if err != nil {
		return nil, err
	}
	if op == nil {
		return nil, newCodedError("codex_reset_operation_not_found", "", http.StatusNotFound)
	}
	if op.Status != "consuming" && op.Status != "unknown" {
		return op, nil
	}
	consumed := out == "reset" || out == "alreadyRedeemed"
	opStatus := "no_effect"
	if consumed {
		opStatus = "succeeded"
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE `+resetOperationsTable+`
		 SET status = ?, outcome = ?, updated_at = ?, completed_at = ?, after_count = ?, error_code = NULL
		 WHERE operation_id = ?`,
		opStatus, out, nowMS, nowMS, nullableInt64Arg(afterCount), opID); err != nil {
		return nil, err
	}
	if op.CreditID != "" {
		if consumed {
			if _, err := tx.ExecContext(ctx,
				`UPDATE `+resetCreditsTable+`
				 SET status = 'consumed', consumed_at = ?, consumed_operation_id = ?, status_source = 'local'
				 WHERE account_ref = ? AND credit_id = ?`,
				nowMS, opID, op.AccountRef, op.CreditID); err != nil {
				return nil, err
			}
		} else {
			nextCreditStatus := "available"
			if out == "noCredit" {
				nextCreditStatus = "missing"
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE `+resetCreditsTable+`
				 SET status = ?, consumed_operation_id = NULL, status_source = 'reconciled'
				 WHERE account_ref = ? AND credit_id = ?`,
				nextCreditStatus, op.AccountRef, op.CreditID); err != nil {
				return nil, err
			}
		}
	}
	updated, err := getOperationInTx(ctx, tx, opID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return updated, nil
}

func getOperationInTx(ctx context.Context, tx *sql.Tx, operationID string) (*OperationRecord, error) {
	row := tx.QueryRowContext(ctx,
		`SELECT operation_id, account_ref, credit_id, inventory_version, status, outcome,
		        requested_at, updated_at, completed_at, before_count, after_count, error_code
		 FROM `+resetOperationsTable+` WHERE operation_id = ?`, operationID)
	rec, err := scanOperationRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return rec, err
}

func openImmediateSQLite(ctx context.Context, dbPath string) (*sql.DB, error) {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(dbPath)}
	q := fileURL.Query()
	q.Set("mode", "rwc")
	q.Set("_txlock", "immediate")
	q.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", 5000))
	fileURL.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}
