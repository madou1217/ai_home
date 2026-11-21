package codexstatepage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/application/providerruntime"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxProjectedRolloutRepairInput = 256 << 10
const maxProjectedRepairOutput = 1 << 20
const maxProjectedRepairRows = 4096

var errProjectedRepairInput = errors.New("codex_projected_rollout_repair_input_invalid")
var errProjectedRepairUnavailable = errors.New("codex_projected_rollout_repair_unavailable")
var projectedRepairName = regexp.MustCompile(`(?i)^state_([0-9]+)\.sqlite$`)
var projectedRepairRelative = regexp.MustCompile(`[\\/]sessions[\\/]([0-9]{4}[\\/][0-9]{2}[\\/][0-9]{2}[\\/]rollout-[^\\/]+\.jsonl)$`)

type projectedRepairItem struct {
	ThreadID string `json:"threadId"`
	Previous string `json:"previousPath"`
	Repaired string `json:"repairedPath"`
}
type projectedRepairSummary struct {
	Checked  int                   `json:"checked"`
	Repaired int                   `json:"repaired"`
	Failed   int                   `json:"failed"`
	Items    []projectedRepairItem `json:"items"`
	Reason   string                `json:"reason,omitempty"`
}

func emptyProjectedRepair() projectedRepairSummary {
	return projectedRepairSummary{Items: []projectedRepairItem{}}
}

// SameFile checks device/inode in addition to the resolved path. This is a
// bounded generation check, NOT an atomic defence against external rename/ABA.
type projectedRepairIdentity struct {
	path, real string
	info       os.FileInfo
}

func projectedRepairCapture(path string, directory bool) (projectedRepairIdentity, error) {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return projectedRepairIdentity{}, errProjectedRepairUnavailable
	}
	info, err := os.Stat(real)
	if err != nil || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		return projectedRepairIdentity{}, errProjectedRepairUnavailable
	}
	return projectedRepairIdentity{path: path, real: real, info: info}, nil
}
func (identity projectedRepairIdentity) check() error {
	current, err := projectedRepairCapture(identity.path, identity.info.IsDir())
	if err != nil || current.real != identity.real || !os.SameFile(identity.info, current.info) {
		return errProjectedRepairUnavailable
	}
	return nil
}

type projectedRepairAuthority struct {
	root, sessions, requestRoot, requestSessions projectedRepairIdentity
}

func projectedRepairHostAuthority(home string) (projectedRepairAuthority, error) {
	// Windows private-use path decoding and passwd-only fallback are not part
	// of this finite write capability. Do not guess a different authority.
	if runtime.GOOS == "windows" {
		return projectedRepairAuthority{}, errProjectedRepairUnavailable
	}
	env := map[string]string{"AIH_HOST_HOME": os.Getenv("AIH_HOST_HOME"), "HOME": os.Getenv("HOME")}
	if responseTrim(env["AIH_HOST_HOME"]) == "" && responseTrim(env["HOME"]) == "" {
		return projectedRepairAuthority{}, errProjectedRepairUnavailable
	}
	host := providerruntime.ResolveHostHomeDir("", env, runtime.GOOS)
	if !filepath.IsAbs(host) || strings.ContainsAny(host, "\\\x00") {
		return projectedRepairAuthority{}, errProjectedRepairUnavailable
	}
	root, err := projectedRepairCapture(filepath.Join(host, providerroot.ConfigDir("codex")), true)
	if err != nil {
		return projectedRepairAuthority{}, err
	}
	sessions, err := projectedRepairCapture(filepath.Join(root.real, "sessions"), true)
	if err != nil {
		return projectedRepairAuthority{}, err
	}
	requestRoot, err := projectedRepairCapture(home, true)
	if err != nil {
		return projectedRepairAuthority{}, err
	}
	requestSessions, err := projectedRepairCapture(filepath.Join(home, "sessions"), true)
	if err != nil || requestSessions.real != sessions.real || !os.SameFile(requestSessions.info, sessions.info) {
		return projectedRepairAuthority{}, errProjectedRepairUnavailable
	}
	return projectedRepairAuthority{root, sessions, requestRoot, requestSessions}, nil
}
func (authority projectedRepairAuthority) check() error {
	for _, identity := range []projectedRepairIdentity{authority.root, authority.sessions, authority.requestRoot, authority.requestSessions} {
		if err := identity.check(); err != nil {
			return err
		}
	}
	return nil
}

type projectedRepairSource struct {
	request, database projectedRepairIdentity
	version           uint64
}

// Top-level only, descending numeric versions. Reject locale ties and versions
// outside the exact finite subset rather than selecting a convenient source.
func projectedRepairSources(authority projectedRepairAuthority) ([]projectedRepairSource, error) {
	dir, err := os.Open(authority.requestRoot.path)
	if err != nil {
		return nil, errProjectedRepairUnavailable
	}
	defer dir.Close()
	var result []projectedRepairSource
	seen := map[uint64]bool{}
	entries := 0
	for {
		names, readErr := dir.Readdirnames(128)
		entries += len(names)
		if entries > 8192 {
			return nil, ErrBudget
		}
		for _, name := range names {
			match := projectedRepairName.FindStringSubmatch(name)
			if len(match) != 2 {
				continue
			}
			version, err := strconv.ParseUint(match[1], 10, 31)
			if err != nil || seen[version] {
				return nil, errProjectedRepairUnavailable
			}
			seen[version] = true
			if len(result) >= maxSources {
				return nil, ErrBudget
			}
			database, err := projectedRepairCapture(filepath.Join(authority.root.real, name), false)
			// The projection may link to the same-named authority file. The
			// authority file itself cannot redirect this writer to an outside DB.
			if err != nil || database.real != filepath.Join(authority.root.real, name) {
				return nil, errProjectedRepairUnavailable
			}
			request, err := projectedRepairCapture(filepath.Join(authority.requestRoot.path, name), false)
			if err != nil || request.real != database.real || !os.SameFile(request.info, database.info) {
				return nil, errProjectedRepairUnavailable
			}
			result = append(result, projectedRepairSource{request, database, version})
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, errProjectedRepairUnavailable
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].version > result[j].version })
	return result, nil
}
func (source projectedRepairSource) check(authority projectedRepairAuthority) error {
	if err := authority.check(); err != nil {
		return err
	}
	if err := source.request.check(); err != nil {
		return err
	}
	return source.database.check()
}

// Keep the write schema deliberately narrow: one ordinary threads table, a
// unique text primary key and a non-generated text rollout_path, no triggers.
// Other vendor schema is neither initialized nor migrated.
func projectedRepairSchema(ctx context.Context, conn *sql.Conn) (string, error) {
	var version int64
	if err := conn.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&version); err != nil {
		return "", err
	}
	var kind, definition string
	if err := conn.QueryRowContext(ctx, "SELECT type, sql FROM sqlite_schema WHERE name = 'threads'").Scan(&kind, &definition); err != nil {
		return "", err
	}
	if kind != "table" || !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(definition)), "CREATE TABLE") {
		return "", errProjectedRepairUnavailable
	}
	var triggers int
	if err := conn.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'threads'").Scan(&triggers); err != nil || triggers != 0 {
		return "", errProjectedRepairUnavailable
	}
	rows, err := conn.QueryContext(ctx, "PRAGMA table_xinfo('threads')")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	columns := make([]any, 0)
	idOK, pathOK, primary := false, false, 0
	for rows.Next() {
		var cid, notNull, pk, hidden int
		var name, datatype string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &datatype, &notNull, &defaultValue, &pk, &hidden); err != nil {
			return "", err
		}
		if len(columns) >= 256 {
			return "", ErrBudget
		}
		columns = append(columns, []any{cid, name, datatype, notNull, defaultValue, pk, hidden})
		if pk > 0 {
			primary++
		}
		if name == "id" {
			idOK = strings.EqualFold(datatype, "TEXT") && pk > 0 && hidden == 0
		}
		if name == "rollout_path" {
			pathOK = strings.EqualFold(datatype, "TEXT") && hidden == 0
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if !idOK || !pathOK || primary != 1 {
		return "", errProjectedRepairUnavailable
	}
	if err := rows.Close(); err != nil {
		return "", err
	}
	value, err := json.Marshal([]any{version, definition, columns})
	if err != nil {
		return "", err
	}
	return projectedRepairForeignKeyShape(ctx, conn, string(value))
}

// Reject declared FK edges involving threads in either direction. Enabling
// enforcement could cascade beyond this leaf's sole DML target, so admission
// fails instead. All table names are bound data and enumeration is complete or
// unavailable; both operations execute this in each pre/post schema check.
func projectedRepairForeignKeyShape(ctx context.Context, conn *sql.Conn, shape string) (string, error) {
	rows, err := conn.QueryContext(ctx, "SELECT name FROM main.sqlite_schema WHERE type = 'table' ORDER BY name COLLATE BINARY")
	if err != nil {
		return "", err
	}
	tables := []string{}
	for rows.Next() {
		if len(tables) >= 256 {
			_ = rows.Close()
			return "", ErrBudget
		}
		var value any
		if err := rows.Scan(&value); err != nil {
			_ = rows.Close()
			return "", err
		}
		table, err := projectedRepairText(value)
		if err != nil || table == "" {
			_ = rows.Close()
			return "", errProjectedRepairUnavailable
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return "", err
	}
	if err := rows.Close(); err != nil {
		return "", err
	}
	foreignRows := 0
	fingerprint := []any{shape, tables}
	for _, table := range tables {
		// Table names are data, not interpolated SQL or escaped identifiers.
		foreign, err := conn.QueryContext(ctx, `SELECT "table" FROM pragma_foreign_key_list(?, 'main')`, table)
		if err != nil {
			return "", err
		}
		for foreign.Next() {
			foreignRows++
			if foreignRows > 4096 {
				_ = foreign.Close()
				return "", ErrBudget
			}
			var value any
			if err := foreign.Scan(&value); err != nil {
				_ = foreign.Close()
				return "", err
			}
			target, err := projectedRepairText(value)
			if err != nil || target == "" || strings.EqualFold(table, "threads") || strings.EqualFold(target, "threads") {
				_ = foreign.Close()
				return "", errProjectedRepairUnavailable
			}
			fingerprint = append(fingerprint, []string{table, target})
		}
		if err := foreign.Err(); err != nil {
			_ = foreign.Close()
			return "", err
		}
		if err := foreign.Close(); err != nil {
			return "", err
		}
	}
	wire, err := marshalWire(fingerprint)
	if err != nil || len(wire) > 256<<10 {
		return "", ErrBudget
	}
	return string(wire), nil
}

type projectedRepairRow struct{ id, path string }

func projectedRepairText(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	text, ok := value.(string)
	if !ok || !utf8.ValidString(text) || len(text) > 8192 || strings.ContainsRune(text, 0) {
		return "", errProjectedRepairUnavailable
	}
	// Only the already-normalized text subset is writable; padded/non-text
	// identities are not coerced into a different row's CAS key.
	if text != responseTrim(text) {
		return "", errProjectedRepairUnavailable
	}
	return text, nil
}
func projectedRepairRows(ctx context.Context, conn *sql.Conn, authority projectedRepairAuthority, threadID string, limit, budget int) ([]projectedRepairRow, error) {
	query := "SELECT id, rollout_path FROM threads WHERE id = ?"
	bindings := []any{threadID}
	if threadID == "" {
		query = "SELECT id, rollout_path FROM threads WHERE rollout_path LIKE ? AND rollout_path NOT LIKE ? ORDER BY rowid DESC LIMIT ?"
		bindings = []any{"%" + string(filepath.Separator) + "sessions" + string(filepath.Separator) + "%", authority.sessions.real + string(filepath.Separator) + "%", limit}
	}
	rows, err := conn.QueryContext(ctx, query, bindings...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []projectedRepairRow{}
	for rows.Next() {
		if len(result) >= budget {
			return nil, ErrBudget
		}
		var idValue, pathValue any
		if err := rows.Scan(&idValue, &pathValue); err != nil {
			return nil, err
		}
		id, err := projectedRepairText(idValue)
		if err != nil {
			return nil, err
		}
		// Vendor collation may match a different spelling. Admit exact request
		// identity before any UPDATE, not after COMMIT in the JS receipt check.
		if threadID != "" && id != threadID {
			return nil, errProjectedRepairUnavailable
		}
		path, err := projectedRepairText(pathValue)
		if err != nil {
			return nil, err
		}
		result = append(result, projectedRepairRow{id, path})
	}
	return result, rows.Err()
}
func projectedRepairMissing(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return false, nil
	}
	if errors.Is(err, syscall.ENOENT) {
		return true, nil
	}
	// Permission, IO, ENOTDIR, etc. must not authorize a repair.
	return false, errProjectedRepairUnavailable
}
func projectedRepairCandidate(authority projectedRepairAuthority, id, candidate string) (projectedRepairIdentity, error) {
	if !strings.HasSuffix(candidate, ".jsonl") || strings.Contains(candidate, ".aih-slim-") || strings.Contains(candidate, ".aih-full-") || !strings.Contains(filepath.Base(candidate), id) {
		return projectedRepairIdentity{}, errProjectedRepairUnavailable
	}
	identity, err := projectedRepairCapture(candidate, false)
	if err != nil {
		return projectedRepairIdentity{}, err
	}
	// Stable symlink aliases must not change the selected thread or admit an
	// optimized sidecar. This is separate from the external rename/ABA limit.
	if !strings.HasSuffix(identity.real, ".jsonl") || strings.Contains(identity.real, ".aih-slim-") || strings.Contains(identity.real, ".aih-full-") || !strings.Contains(filepath.Base(identity.real), id) {
		return projectedRepairIdentity{}, errProjectedRepairUnavailable
	}
	relative, err := filepath.Rel(authority.sessions.real, identity.real)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return projectedRepairIdentity{}, errProjectedRepairUnavailable
	}
	return identity, nil
}

type projectedRepairPending struct {
	item      projectedRepairItem
	candidate projectedRepairIdentity
}

// This is a dedicated existing-only RW opener; openVendorReadOnly and every
// other SQL leaf remain unchanged. One connection owns BEGIN IMMEDIATE and is
// rolled back/closed synchronously, including cancellation paths.
func projectedRepairDatabase(ctx context.Context, authority projectedRepairAuthority, source projectedRepairSource, threadID string, limit, budget int, previous projectedRepairSummary) (summary projectedRepairSummary, scanned int, resultErr error) {
	summary = emptyProjectedRepair()
	if err := source.check(authority); err != nil {
		return summary, 0, err
	}
	uri := sqlitefile.URL(source.database.real)
	query := uri.Query()
	query.Set("mode", "rw")
	query.Add("_pragma", "busy_timeout(1000)")
	query.Add("_pragma", "trusted_schema(OFF)")
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return summary, 0, err
	}
	db.SetMaxOpenConns(1)
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	conn, err := db.Conn(ctx)
	if err != nil {
		return summary, 0, err
	}
	defer func() { resultErr = errors.Join(resultErr, conn.Close()) }()
	if err := source.check(authority); err != nil {
		return summary, 0, err
	}
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return summary, 0, err
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
		return summary, 0, err
	}
	shape, err := projectedRepairSchema(ctx, conn)
	if err != nil {
		return summary, 0, err
	}
	rows, err := projectedRepairRows(ctx, conn, authority, threadID, limit, budget)
	if err != nil {
		return summary, 0, err
	}
	scanned = len(rows)
	pending := []projectedRepairPending{}
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return emptyProjectedRepair(), scanned, err
		}
		match := projectedRepairRelative.FindStringSubmatch(row.path)
		if row.id == "" || len(match) != 2 {
			continue
		}
		missing, err := projectedRepairMissing(row.path)
		if err != nil {
			return emptyProjectedRepair(), scanned, err
		}
		if !missing {
			continue
		}
		summary.Checked++
		candidate := filepath.Join(authority.sessions.real, match[1])
		identity, err := projectedRepairCandidate(authority, row.id, candidate)
		if err != nil {
			summary.Failed++
			continue
		}
		if err := source.check(authority); err != nil {
			return emptyProjectedRepair(), scanned, err
		}
		missing, err = projectedRepairMissing(row.path)
		if err != nil || !missing {
			return emptyProjectedRepair(), scanned, errProjectedRepairUnavailable
		}
		if err := identity.check(); err != nil {
			return emptyProjectedRepair(), scanned, err
		}
		result, err := conn.ExecContext(ctx, "UPDATE OR ABORT threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?", candidate, row.id, row.path)
		if err != nil {
			return emptyProjectedRepair(), scanned, err
		}
		changes, err := result.RowsAffected()
		if err != nil || changes < 0 || changes > 1 {
			return emptyProjectedRepair(), scanned, errProjectedRepairUnavailable
		}
		if changes == 1 {
			summary.Repaired++
			item := projectedRepairItem{row.id, row.path, candidate}
			summary.Items = append(summary.Items, item)
			pending = append(pending, projectedRepairPending{item, identity})
		}
	}
	if err := source.check(authority); err != nil {
		return emptyProjectedRepair(), scanned, err
	}
	afterShape, err := projectedRepairSchema(ctx, conn)
	if err != nil || afterShape != shape {
		return emptyProjectedRepair(), scanned, errProjectedRepairUnavailable
	}
	for _, repair := range pending {
		missing, err := projectedRepairMissing(repair.item.Previous)
		if err != nil || !missing {
			return emptyProjectedRepair(), scanned, errProjectedRepairUnavailable
		}
		if err := repair.candidate.check(); err != nil {
			return emptyProjectedRepair(), scanned, err
		}
	}
	// Reserve framing before COMMIT; never lose a known successful receipt just
	// because a later source would exceed the output budget.
	combined := previous
	combined.Items = append(append([]projectedRepairItem{}, previous.Items...), summary.Items...)
	combined.Checked += summary.Checked
	combined.Repaired += summary.Repaired
	combined.Failed += summary.Failed
	combined.Reason = "codex_projected_rollout_repair_unavailable"
	wire, err := marshalWire(combined)
	if err != nil || len(wire)+1 > maxProjectedRepairOutput {
		return emptyProjectedRepair(), scanned, ErrBudget
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return emptyProjectedRepair(), scanned, err
	}
	committed = true
	// A post-COMMIT generation change cannot undo a write. Preserve the
	// committed counts and mark the receipt partial, never report "no writes".
	if err := source.check(authority); err != nil {
		return summary, scanned, err
	}
	return summary, scanned, nil
}

// RepairProjectedRollouts transfers only the synchronous projected-path writer.
// The request selects a projection, never the write authority or a target path.
// Timeout/failed framing can follow COMMIT: callers must never retry implicitly.
func RepairProjectedRollouts(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxProjectedRolloutRepairInput {
		return nil, ErrBudget
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 5 || request["version"] != json.Number("1") || request["op"] != "projected-rollout-repair" {
		return nil, errProjectedRepairInput
	}
	home, homeOK := request["codexHome"].(string)
	threadID, idOK := request["threadId"].(string)
	number, limitOK := request["limit"].(json.Number)
	limit, limitErr := strconv.Atoi(string(number))
	if !homeOK || !filepath.IsAbs(home) || filepath.Clean(home) != home || responseTrim(home) != home || strings.ContainsRune(home, 0) ||
		!idOK || responseTrim(threadID) != threadID || strings.ContainsRune(threadID, 0) ||
		!limitOK || limitErr != nil || limit < 1 || limit > maxProjectedRepairRows {
		return nil, errProjectedRepairInput
	}
	if ctx == nil {
		return nil, errProjectedRepairInput
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	authority, err := projectedRepairHostAuthority(home)
	if err != nil {
		return nil, err
	}
	sources, err := projectedRepairSources(authority)
	if err != nil {
		return nil, err
	}
	summary := emptyProjectedRepair()
	budget := maxProjectedRepairRows
	for _, source := range sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		part, scanned, err := projectedRepairDatabase(ctx, authority, source, threadID, limit, budget, summary)
		budget -= scanned
		summary.Checked += part.Checked
		summary.Repaired += part.Repaired
		summary.Failed += part.Failed
		summary.Items = append(summary.Items, part.Items...)
		if err != nil {
			// Any previous commits remain observable; do not retry another
			// database after an unsupported shape/generation/transaction.
			summary.Reason = "codex_projected_rollout_repair_unavailable"
			break
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return marshalWire(summary)
}
