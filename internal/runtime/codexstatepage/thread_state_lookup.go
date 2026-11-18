package codexstatepage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxThreadStateLookupInput = 256 << 10
const maxThreadStateLookupOutput = 1 << 20
const maxThreadStateSafeInteger = int64(9007199254740991)

var errThreadStateLookupInput = errors.New("codex_thread_state_lookup_input_invalid")
var errThreadStateLookupUnavailable = errors.New("codex_thread_state_lookup_unavailable")

// Keep this SELECT identical to getThreadStateRow, not the three-column resume
// DTO or the list projection's different field set. No renderer policy here.
var threadStateLookupColumns = []string{
	"id", "rollout_path", "created_at", "updated_at", "created_at_ms", "updated_at_ms",
	"source", "model_provider", "model", "cwd", "title", "sandbox_policy", "approval_mode",
	"cli_version", "first_user_message", "agent_nickname", "agent_role", "git_sha", "git_branch",
	"git_origin_url", "reasoning_effort", "thread_source",
}
var threadStateLookupSQL = "SELECT " + strings.Join(threadStateLookupColumns, ", ") + " FROM threads WHERE id = ?"

type threadStateLookupRepair struct {
	Checked  bool   `json:"checked"`
	Repaired bool   `json:"repaired"`
	ThreadID string `json:"threadId,omitempty"`
	Previous string `json:"previousPath,omitempty"`
	Path     string `json:"repairedPath,omitempty"`
	Reason   string `json:"reason,omitempty"`
}
type threadStateLookupResult struct {
	Row         map[string]any           `json:"row"`
	StateDBPath string                   `json:"stateDbPath"`
	Repair      *threadStateLookupRepair `json:"rolloutRepair"`
}

type threadStateLookupQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func threadStateLookupValue(value any) (any, error) {
	switch value := value.(type) {
	case nil:
		return nil, nil
	case string:
		if !utf8.ValidString(value) {
			return nil, errThreadStateLookupUnavailable
		}
		if len(value) > MaxThreadStateLookupInput {
			return nil, ErrBudget
		}
		return value, nil
	case int64:
		if value < -maxThreadStateSafeInteger || value > maxThreadStateSafeInteger {
			return nil, errThreadStateLookupUnavailable
		}
		return value, nil
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) || (math.Trunc(value) == value && math.Abs(value) > float64(maxThreadStateSafeInteger)) {
			return nil, errThreadStateLookupUnavailable
		}
		return value, nil
	default:
		// No lossy BLOB/string/NULL coercion or unsafe integer rounding.
		return nil, errThreadStateLookupUnavailable
	}
}
func threadStateLookupRow(ctx context.Context, query threadStateLookupQuery, threadID string) (result map[string]any, resultErr error) {
	rows, err := query.QueryContext(ctx, threadStateLookupSQL, threadID)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	// A true SELECT miss is authoritative as a miss even for an unsupported
	// result-key spelling; only successful rows need the exact-key admission.
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, sql.ErrNoRows
	}
	columns, err := rows.Columns()
	if err != nil || len(columns) != len(threadStateLookupColumns) {
		return nil, errThreadStateLookupUnavailable
	}
	for i, column := range columns {
		// Node exposes SQLite's actual result names. Do not silently turn a
		// declared TITLE into title or use AS aliases to hide that difference.
		if column != threadStateLookupColumns[i] {
			return nil, errThreadStateLookupUnavailable
		}
	}
	values := make([]any, len(threadStateLookupColumns))
	pointers := make([]any, len(values))
	for i := range values {
		pointers[i] = &values[i]
	}
	if err := rows.Scan(pointers...); err != nil {
		return nil, err
	}
	row := make(map[string]any, len(values))
	for i, value := range values {
		decoded, err := threadStateLookupValue(value)
		if err != nil {
			return nil, err
		}
		row[threadStateLookupColumns[i]] = decoded
	}
	if id, ok := row["id"].(string); !ok || id != threadID {
		return nil, errThreadStateLookupUnavailable
	}
	wire, err := marshalWire(row)
	if err != nil || len(wire)+1 > maxThreadStateLookupOutput/2 {
		return nil, ErrBudget
	}
	return row, nil
}

// Read shape is NOT write admission. A valid RO hit must survive a rejected FK,
// write authority, canonical candidate or stricter write-schema contract.
func threadStateLookupReadShape(ctx context.Context, query threadStateLookupQuery) (string, error) {
	var version int64
	if err := query.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&version); err != nil {
		return "", err
	}
	var kind, definition string
	if err := query.QueryRowContext(ctx, "SELECT type, sql FROM sqlite_schema WHERE name = 'threads' COLLATE NOCASE").Scan(&kind, &definition); err != nil {
		return "", err
	}
	wire, err := marshalWire([]any{version, kind, definition})
	if err != nil || len(wire) > MaxThreadStateLookupInput {
		return "", ErrBudget
	}
	return string(wire), nil
}

type threadStateLookupSnapshot struct {
	identity projectedRepairIdentity
	shape    string
	row      map[string]any
}

func threadStateLookupRead(ctx context.Context, path, threadID string) (snapshot threadStateLookupSnapshot, resultErr error) {
	identity, err := projectedRepairCapture(path, false)
	if err != nil {
		return snapshot, err
	}
	db, tx, err := openVendorReadOnly(ctx, path)
	if err != nil {
		return snapshot, err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	defer func() { resultErr = errors.Join(resultErr, tx.Rollback()) }()
	// Only the original SELECT can establish a legitimate row miss. Additional
	// repair-shape metadata must never select a later source instead of this
	// valid raw row, or impose write admission on the read result.
	row, err := threadStateLookupRow(ctx, tx, threadID)
	if err != nil {
		if row != nil {
			// Successful decode followed by close failure is not a new miss.
			snapshot = threadStateLookupSnapshot{identity: identity, row: row}
			return snapshot, errThreadStateLookupUnavailable
		}
		return snapshot, err
	}
	snapshot = threadStateLookupSnapshot{identity: identity, row: row}
	if err := identity.check(); err != nil {
		return snapshot, errThreadStateLookupUnavailable
	}
	shape, err := threadStateLookupReadShape(ctx, tx)
	if err != nil {
		if err := ctx.Err(); err != nil {
			return snapshot, err
		}
		// Keep the successful source's snapshot; empty shape explicitly
		// disables the optional write upgrade below. No later DB fallback.
		return snapshot, nil
	}
	snapshot.shape = shape
	return snapshot, nil
}

// Source-bound optional upgrade. No all-DB repair entry point is used, and
// nested sources never reach this function even if their realpath is top-level.
// The raw snapshot row changes only after this exact CAS is confirmed committed.
func threadStateLookupUpgrade(ctx context.Context, authority projectedRepairAuthority, source projectedRepairSource, snapshot threadStateLookupSnapshot, threadID, oldPath string) (repair threadStateLookupRepair, resultErr error) {
	repair.Checked = true
	if source.request.path != snapshot.identity.path || source.database.real != snapshot.identity.real || !os.SameFile(source.database.info, snapshot.identity.info) {
		return repair, errThreadStateLookupUnavailable
	}
	if err := source.check(authority); err != nil {
		return repair, err
	}
	uri := sqlitefile.URL(source.database.real)
	query := uri.Query()
	query.Set("mode", "rw")
	query.Add("_pragma", "busy_timeout(1000)")
	query.Add("_pragma", "trusted_schema(OFF)")
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return repair, err
	}
	db.SetMaxOpenConns(1)
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	conn, err := db.Conn(ctx)
	if err != nil {
		return repair, err
	}
	defer func() { resultErr = errors.Join(resultErr, conn.Close()) }()
	if err := source.check(authority); err != nil {
		return repair, err
	}
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return repair, err
	}
	committed := false
	defer func() {
		if !committed {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, rollbackErr := conn.ExecContext(cleanupCtx, "ROLLBACK")
			resultErr = errors.Join(resultErr, rollbackErr)
		}
	}()
	if err := source.check(authority); err != nil {
		return repair, err
	}
	readShape, err := threadStateLookupReadShape(ctx, conn)
	if err != nil || readShape != snapshot.shape {
		return repair, errThreadStateLookupUnavailable
	}
	writeShape, err := projectedRepairSchema(ctx, conn)
	if err != nil {
		return repair, err
	}
	current, err := threadStateLookupRow(ctx, conn, threadID)
	if err != nil {
		return repair, err
	}
	before, err := marshalWire(snapshot.row)
	if err != nil {
		return repair, err
	}
	now, err := marshalWire(current)
	if err != nil || string(before) != string(now) {
		return repair, errThreadStateLookupUnavailable
	}
	traversal := &optimizedRepairTraversal{}
	candidate, found, err := optimizedRepairFind(ctx, authority, threadID, oldPath, traversal)
	if err != nil {
		return repair, err
	}
	if !found {
		repair.Reason = "canonical_missing"
		return repair, nil
	}
	if err := source.check(authority); err != nil {
		return repair, err
	}
	if err := candidate.check(); err != nil {
		return repair, err
	}
	if err := traversal.check(); err != nil {
		return repair, err
	}
	result, err := conn.ExecContext(ctx, "UPDATE OR ABORT threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?", candidate.path, threadID, oldPath)
	if err != nil {
		return repair, err
	}
	changes, err := result.RowsAffected()
	if err != nil || changes < 0 || changes > 1 {
		return repair, errThreadStateLookupUnavailable
	}
	if changes == 0 {
		repair.Reason = "cas_not_applied"
		return repair, nil
	}
	afterShape, err := projectedRepairSchema(ctx, conn)
	if err != nil || afterShape != writeShape {
		return repair, errThreadStateLookupUnavailable
	}
	afterReadShape, err := threadStateLookupReadShape(ctx, conn)
	if err != nil || afterReadShape != snapshot.shape {
		return repair, errThreadStateLookupUnavailable
	}
	if err := source.check(authority); err != nil {
		return repair, err
	}
	if err := candidate.check(); err != nil {
		return repair, err
	}
	if err := traversal.check(); err != nil {
		return repair, err
	}
	// Check a complete post-commit receipt budget before issuing COMMIT.
	proposedRow := make(map[string]any, len(snapshot.row))
	for key, value := range snapshot.row {
		proposedRow[key] = value
	}
	proposedRow["rollout_path"] = candidate.path
	proposedRepair := threadStateLookupRepair{Checked: true, Repaired: true, ThreadID: threadID, Previous: oldPath, Path: candidate.path, Reason: "codex_thread_state_repair_unavailable"}
	wire, err := marshalWire(threadStateLookupResult{proposedRow, snapshot.identity.path, &proposedRepair})
	if err != nil || len(wire)+1 > maxThreadStateLookupOutput {
		return repair, ErrBudget
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return repair, err
	}
	committed = true
	repair = proposedRepair
	repair.Reason = ""
	// Post-commit failure preserves the confirmed write and updated row. It
	// cannot become evidence of no writes or an implicit retry instruction.
	if err := source.check(authority); err != nil {
		return repair, err
	}
	return repair, nil
}

func threadStateLookupOptionalRepair(ctx context.Context, home, sourcePath, threadID string, snapshot threadStateLookupSnapshot) *threadStateLookupRepair {
	// Writable admission follows lexical discovery location, never realpath.
	if filepath.Dir(sourcePath) != home {
		return nil
	}
	repair := threadStateLookupRepair{Checked: true}
	oldPath, ok := snapshot.row["rollout_path"].(string)
	if !ok || oldPath == "" || !optimizedRepairSidecar(oldPath) {
		return &repair
	}
	if snapshot.shape == "" {
		repair.Reason = "codex_thread_state_repair_unavailable"
		return &repair
	}
	// Write keys retain the finite normalized subset. The RO values themselves
	// stay unchanged; no trim or coercion is applied to the returned snapshot.
	if responseTrim(oldPath) != oldPath || strings.ContainsRune(oldPath, 0) {
		repair.Reason = "codex_thread_state_repair_unavailable"
		return &repair
	}
	authority, err := projectedRepairHostAuthority(home)
	if err != nil {
		repair.Reason = "codex_thread_state_repair_unavailable"
		return &repair
	}
	sources, err := projectedRepairSources(authority)
	if err != nil {
		repair.Reason = "codex_thread_state_repair_unavailable"
		return &repair
	}
	for _, source := range sources {
		if source.request.path != sourcePath {
			continue
		}
		repair, err = threadStateLookupUpgrade(ctx, authority, source, snapshot, threadID, oldPath)
		if err != nil {
			repair.Reason = "codex_thread_state_repair_unavailable"
		}
		if repair.Repaired {
			snapshot.row["rollout_path"] = repair.Path
		}
		return &repair
	}
	repair.Reason = "codex_thread_state_repair_unavailable"
	return &repair
}

// LookupThreadState preserves all three real consumers' row contract. A
// legitimate miss continues in source order; an unsupported successful row is
// NOT a miss or permission to pick a later convenient database.
func LookupThreadState(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxThreadStateLookupInput {
		return nil, ErrBudget
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 4 || request["version"] != json.Number("1") || request["op"] != "thread-state-lookup" {
		return nil, errThreadStateLookupInput
	}
	home, homeOK := request["codexHome"].(string)
	threadID, idOK := request["threadId"].(string)
	if !homeOK || !filepath.IsAbs(home) || filepath.Clean(home) != home || responseTrim(home) != home || strings.ContainsRune(home, 0) || !idOK || threadID == "" || responseTrim(threadID) != threadID || strings.ContainsRune(threadID, 0) {
		return nil, errThreadStateLookupInput
	}
	if ctx == nil {
		return nil, errThreadStateLookupInput
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	paths, err := managedReconcileSources(home)
	if err != nil {
		return nil, err
	}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		snapshot, err := threadStateLookupRead(ctx, path, threadID)
		if err != nil {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if snapshot.row != nil {
				// A close/read-generation failure after a successful row is not a
				// miss and must not select a later convenient source.
				return nil, errThreadStateLookupUnavailable
			}
			if errors.Is(err, errThreadStateLookupUnavailable) || errors.Is(err, ErrBudget) {
				return nil, err
			}
			// Includes a legitimate row miss, plus original SQL/open failures.
			// Unsupported values or identity changes above are never routed here.
			continue
		}
		repair := threadStateLookupOptionalRepair(ctx, home, path, threadID, snapshot)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		wire, err := marshalWire(threadStateLookupResult{snapshot.row, path, repair})
		if err != nil || len(wire)+1 > maxThreadStateLookupOutput {
			return nil, ErrBudget
		}
		return wire, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return []byte("null"), nil
}
