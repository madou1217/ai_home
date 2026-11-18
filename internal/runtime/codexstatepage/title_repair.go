package codexstatepage

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxThreadTitleRepairInput = 256 << 10
const maxTitleRepairRows = 4096
const maxTitleRepairOutput = 1 << 20

// Exact canonical identity; the original sidecar consumer derives the same
// canonical stem before .aih-slim-/.aih-full-. Unknown suffix layouts remain
// finite unsupported, never permission to read a different thread's content.
var titleRepairRolloutName = regexp.MustCompile(`^rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$`)

var errTitleRepairInput = errors.New("codex_thread_title_repair_input_invalid")
var errTitleRepairUnavailable = errors.New("codex_thread_title_repair_unavailable")
var titleRepairRole = regexp.MustCompile(`"role"[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*:[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*"user"`)

type titleRepairItem struct {
	ThreadID string `json:"threadId"`
	Title    string `json:"title"`
}
type titleRepairSummary struct {
	Checked  int               `json:"checked"`
	Repaired int               `json:"repaired"`
	Failed   int               `json:"failed"`
	Items    []titleRepairItem `json:"items"`
	Reason   string            `json:"reason,omitempty"`
}

func emptyTitleRepair() titleRepairSummary { return titleRepairSummary{Items: []titleRepairItem{}} }

type titleRepairRow struct{ raw [5]any }

func titleRepairRaw(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	text, ok := value.(string)
	if !ok || !utf8.ValidString(text) || strings.ContainsRune(text, 0) || len(text) > 1<<20 {
		return "", errTitleRepairUnavailable
	}
	return text, nil
}

// The existing pure sanitizer uses Go Fields. Admit the finite equivalent
// subset first; in particular JS whitespace does not include U+0085.
func titleRepairNormalize(value string) (string, error) {
	if !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\u0085") {
		return "", errTitleRepairUnavailable
	}
	var out strings.Builder
	space := false
	for _, r := range value {
		if responseTrim(string(r)) == "" {
			space = out.Len() > 0
			continue
		}
		if space {
			out.WriteByte(' ')
			space = false
		}
		out.WriteRune(r)
	}
	return out.String(), nil
}
func titleRepairSanitize(value string) (string, error) {
	value, err := titleRepairNormalize(value)
	if err != nil {
		return "", err
	}
	title := sanitizeTitle(value)
	if strings.ContainsRune(title, 0) {
		return "", errTitleRepairUnavailable
	}
	return title, nil
}
func titleRepairShouldRepair(value string) (bool, error) {
	value, err := titleRepairNormalize(value)
	if err != nil {
		return false, err
	}
	if value == "" || strings.Contains(value, "<INSTRUCTIONS>") {
		return true, nil
	}
	for _, prefix := range []string{"# AGENTS.md instructions", "<codex_internal_context", "<environment_context", "<turn_aborted", "<user_instructions", "<user_shell_command"} {
		if strings.HasPrefix(value, prefix) {
			return true, nil
		}
	}
	return false, nil
}
func titleRepairKeys(value map[string]any, names ...string) error {
	for key := range value {
		for _, name := range names {
			if key != name && strings.EqualFold(key, name) {
				return errTitleRepairUnavailable
			}
		}
	}
	return nil
}
func titleRepairField(value map[string]any, name string) (string, error) {
	if value[name] == nil {
		return "", nil
	}
	text, ok := value[name].(string)
	if !ok {
		return "", errTitleRepairUnavailable
	}
	return titleRepairNormalize(text)
}

// The exact raw-line prefilter precedes strict admission. Only canonical,
// case-sensitive participating fields are sent to the existing pure parser.
// A valid but unsupported record is an error, never a request to try later data.
func titleRepairLine(raw []byte) (string, error) {
	if !bytes.Contains(raw, []byte("user_message")) && !titleRepairRole.Match(raw) && !bytes.Contains(raw, []byte("thread_goal_updated")) {
		return "", nil
	}
	if !json.Valid(raw) {
		return "", nil
	}
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return "", nil
	}
	entry, err := jsondocument.Object(raw)
	if err != nil {
		return "", errTitleRepairUnavailable
	}
	if err := titleRepairKeys(entry, "type", "payload"); err != nil {
		return "", err
	}
	kind, ok := entry["type"].(string)
	if !ok || (kind != "event_msg" && kind != "response_item") {
		return "", nil
	}
	if entry["payload"] == nil {
		return "", nil
	}
	payload, ok := entry["payload"].(map[string]any)
	if !ok {
		return "", errTitleRepairUnavailable
	}
	if err := titleRepairKeys(payload, "type", "role", "message", "goal", "content"); err != nil {
		return "", err
	}
	p := map[string]any{}
	p["type"], _ = payload["type"].(string)
	switch p["type"] {
	case "user_message":
		text, err := titleRepairField(payload, "message")
		if err != nil {
			return "", err
		}
		p["message"] = text
	case "thread_goal_updated":
		if payload["goal"] == nil {
			return "", nil
		}
		goal, ok := payload["goal"].(map[string]any)
		if !ok {
			return "", errTitleRepairUnavailable
		}
		if err := titleRepairKeys(goal, "objective"); err != nil {
			return "", err
		}
		text, err := titleRepairField(goal, "objective")
		if err != nil {
			return "", err
		}
		p["goal"] = map[string]any{"objective": text}
	case "message":
		if payload["role"] != "user" {
			return "", nil
		}
		if payload["content"] == nil {
			return "", nil
		}
		content, ok := payload["content"].([]any)
		if !ok {
			return "", errTitleRepairUnavailable
		}
		blocks := []any{}
		for _, value := range content {
			if value == nil {
				continue
			}
			block, ok := value.(map[string]any)
			if !ok {
				return "", errTitleRepairUnavailable
			}
			if err := titleRepairKeys(block, "type", "text"); err != nil {
				return "", err
			}
			if block["type"] != "input_text" && block["type"] != "text" {
				continue
			}
			text, err := titleRepairField(block, "text")
			if err != nil {
				return "", err
			}
			blocks = append(blocks, map[string]any{"type": block["type"], "text": text})
		}
		p["role"], p["content"] = "user", blocks
	default:
		return "", nil
	}
	wire, err := json.Marshal(map[string]any{"type": kind, "payload": p})
	if err != nil {
		return "", err
	}
	title := titleLine(wire)
	if strings.ContainsRune(title, 0) {
		return "", errTitleRepairUnavailable
	}
	return title, nil
}

type titleRepairSnapshot struct {
	identity projectedRepairIdentity
	missing  string
}

func (snapshot titleRepairSnapshot) check() error {
	if snapshot.missing != "" {
		_, err := os.Lstat(snapshot.missing)
		if !errors.Is(err, os.ErrNotExist) {
			return errTitleRepairUnavailable
		}
		return nil
	}
	if err := snapshot.identity.check(); err != nil {
		return err
	}
	info, err := os.Stat(snapshot.identity.real)
	if err != nil || !os.SameFile(snapshot.identity.info, info) || info.Size() != snapshot.identity.info.Size() || !info.ModTime().Equal(snapshot.identity.info.ModTime()) {
		return errTitleRepairUnavailable
	}
	return nil
}

type titleRepairIO struct {
	authority   projectedRepairAuthority
	maxBytes    int64
	scanned     int64
	lookups     int
	indexLoaded bool
	index       map[string]string
	snapshots   []titleRepairSnapshot
}

func (files *titleRepairIO) check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := files.authority.check(); err != nil {
		return err
	}
	for _, snapshot := range files.snapshots {
		if err := snapshot.check(); err != nil {
			return err
		}
	}
	return ctx.Err()
}

// Read errors (including data+nonEOF error) beat titles. This focused adapter
// deliberately does not use scanTitleLines, whose callback precedes read errors.
// Independent 64KiB decoding matches the supported legacy Node chunk subset.
func (files *titleRepairIO) scan(ctx context.Context, identity projectedRepairIdentity, limit int64, visit func([]byte) (bool, error)) (resultErr error) {
	files.lookups++
	if files.lookups > 256 {
		return ErrBudget
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	file, err := openTitleFile(identity.real)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, file.Close()) }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(identity.info, info) || info.Size() != identity.info.Size() || !info.ModTime().Equal(identity.info.ModTime()) {
		return errTitleRepairUnavailable
	}
	if err := identity.check(); err != nil {
		return err
	}
	files.snapshots = append(files.snapshots, titleRepairSnapshot{identity: identity})
	buffer := make([]byte, 64<<10)
	var carry []byte
	var read int64
	for read < limit {
		if err := ctx.Err(); err != nil {
			return err
		}
		remaining := int64(256<<20) - files.scanned
		if remaining <= 0 {
			return ErrBudget
		}
		n, readErr := file.Read(buffer[:min(int64(len(buffer)), limit-read, remaining)])
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return readErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		read += int64(n)
		files.scanned += int64(n)
		if files.scanned > 256<<20 {
			return ErrBudget
		}
		chunk := buffer[:n]
		if !utf8.Valid(chunk) {
			return errTitleRepairUnavailable
		}
		for len(chunk) > 0 {
			end := bytes.IndexByte(chunk, '\n')
			part := chunk
			if end >= 0 {
				part = chunk[:end+1]
			}
			if len(carry)+len(part) > 8<<20 {
				return ErrBudget
			}
			carry = append(carry, part...)
			if end < 0 {
				break
			}
			found, err := visit(carry)
			if err != nil {
				return err
			}
			if found {
				return files.check(ctx)
			}
			carry = carry[:0]
			chunk = chunk[end+1:]
		}
		if n == 0 || errors.Is(readErr, io.EOF) {
			break
		}
	}
	if len(carry) > 0 {
		if _, err := visit(carry); err != nil {
			return err
		}
	}
	return files.check(ctx)
}
func (files *titleRepairIO) loadIndex(ctx context.Context) error {
	if files.indexLoaded {
		return files.check(ctx)
	}
	files.indexLoaded = true
	files.index = map[string]string{}
	request := filepath.Join(files.authority.requestRoot.path, "session_index.jsonl")
	canonical := filepath.Join(files.authority.root.real, "session_index.jsonl")
	_, requestErr := os.Lstat(request)
	_, canonicalErr := os.Lstat(canonical)
	if errors.Is(requestErr, os.ErrNotExist) && errors.Is(canonicalErr, os.ErrNotExist) {
		files.snapshots = append(files.snapshots, titleRepairSnapshot{missing: request}, titleRepairSnapshot{missing: canonical})
		return files.check(ctx)
	}
	identity, err := projectedRepairCapture(request, false)
	if err != nil || identity.real != canonical || identity.info.Size() > 32<<20 {
		return errTitleRepairUnavailable
	}
	canonicalIdentity, err := projectedRepairCapture(canonical, false)
	if err != nil || canonicalIdentity.real != canonical || !os.SameFile(identity.info, canonicalIdentity.info) {
		return errTitleRepairUnavailable
	}
	return files.scan(ctx, identity, identity.info.Size(), func(raw []byte) (bool, error) {
		if !json.Valid(raw) || len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
			return false, nil
		}
		value, err := jsondocument.Object(raw)
		if err != nil {
			return false, errTitleRepairUnavailable
		}
		if err := titleRepairKeys(value, "id", "thread_name"); err != nil {
			return false, err
		}
		id, ok := value["id"].(string)
		if !ok {
			if value["id"] != nil {
				return false, errTitleRepairUnavailable
			}
			return false, nil
		}
		id = responseTrim(id)
		if id == "" || files.index[id] != "" || !bytes.Contains(raw, []byte(id)) {
			return false, nil
		}
		name, err := titleRepairField(value, "thread_name")
		if err != nil {
			return false, err
		}
		title, err := titleRepairSanitize(name)
		if err != nil {
			return false, err
		}
		if title != "" {
			if len(files.index) >= maxTitleRepairRows {
				return false, ErrBudget
			}
			files.index[id] = title
		}
		return false, nil
	})
}

// Both lexical and resolved basenames must identify the exact raw row ID.
// A date/ID substring in another thread's basename is never sufficient.
func titleRepairSameID(path, id string) bool {
	name := filepath.Base(path)
	stem := name
	marker := len(name)
	for _, kind := range []string{".aih-slim-", ".aih-full-"} {
		if index := strings.Index(name, kind); index >= 0 && index < marker {
			if index+len(kind) == len(name) {
				return false
			}
			marker = index
		}
	}
	if marker < len(name) {
		stem = name[:marker]
	}
	match := titleRepairRolloutName.FindStringSubmatch(stem)
	return len(match) == 2 && match[1] == id
}
func (files *titleRepairIO) rollout(ctx context.Context, id, path string) (string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || !titleRepairSameID(path, id) {
		return "", errTitleRepairUnavailable
	}
	identity, err := projectedRepairCapture(path, false)
	if err != nil || !optimizedRepairInside(files.authority.sessions.real, identity.real) || !titleRepairSameID(identity.real, id) {
		return "", errTitleRepairUnavailable
	}
	var title string
	err = files.scan(ctx, identity, min(identity.info.Size(), files.maxBytes), func(raw []byte) (bool, error) {
		var err error
		title, err = titleRepairLine(raw)
		return title != "", err
	})
	return title, err
}

func titleRepairSchema(ctx context.Context, conn *sql.Conn) (string, map[string]bool, error) {
	shape, err := projectedRepairSchema(ctx, conn)
	if err != nil {
		return "", nil, err
	}
	rows, err := conn.QueryContext(ctx, "PRAGMA table_xinfo('threads')")
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notNull, pk, hidden int
		var name, kind string
		var def sql.NullString
		if err := rows.Scan(&cid, &name, &kind, &notNull, &def, &pk, &hidden); err != nil {
			return "", nil, err
		}
		columns[name] = true
		if name == "title" || name == "first_user_message" || name == "preview" {
			if !strings.EqualFold(kind, "TEXT") || hidden != 0 {
				return "", nil, errTitleRepairUnavailable
			}
		}
	}
	if err := rows.Err(); err != nil {
		return "", nil, err
	}
	if err := rows.Close(); err != nil {
		return "", nil, err
	}
	if !columns["title"] {
		return "", nil, errTitleRepairUnavailable
	}
	return shape, columns, nil
}
func titleRepairSelect(columns map[string]bool) string {
	first, preview := "NULL AS first_user_message", "NULL AS preview"
	if columns["first_user_message"] {
		first = "first_user_message"
	}
	if columns["preview"] {
		preview = "preview"
	}
	archive := ""
	if columns["archived"] {
		archive = " AND archived = 0"
	}
	order := "id"
	for _, base := range []string{"updated_at", "created_at"} {
		if columns[base+"_ms"] && columns[base] {
			order = "COALESCE(" + base + "_ms, " + base + " * 1000)"
		} else if columns[base+"_ms"] {
			order = base + "_ms"
		} else if columns[base] {
			order = base + " * 1000"
		} else {
			continue
		}
		break
	}
	return `SELECT id, rollout_path, title, ` + first + `, ` + preview + ` FROM threads WHERE (title IS NULL OR TRIM(title) = '' OR title LIKE '# AGENTS.md instructions%' OR title LIKE '<environment_context%' OR title LIKE '<user_instructions%' OR title LIKE '<user_shell_command%' OR title LIKE '%<INSTRUCTIONS>%') AND rollout_path IS NOT NULL AND TRIM(rollout_path) != ''` + archive + ` ORDER BY ` + order + ` DESC LIMIT ?`
}
func titleRepairRows(ctx context.Context, conn *sql.Conn, columns map[string]bool, limit, budget int) ([]titleRepairRow, error) {
	rows, err := conn.QueryContext(ctx, titleRepairSelect(columns), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []titleRepairRow{}
	size := 0
	for rows.Next() {
		if len(result) >= budget {
			return nil, ErrBudget
		}
		var row titleRepairRow
		if err := rows.Scan(&row.raw[0], &row.raw[1], &row.raw[2], &row.raw[3], &row.raw[4]); err != nil {
			return nil, err
		}
		for _, value := range row.raw {
			text, err := titleRepairRaw(value)
			if err != nil {
				return nil, err
			}
			size += len(text)
		}
		if size > 8<<20 {
			return nil, ErrBudget
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return result, nil
}

// One connection owns the candidate snapshot, all CAS writes and COMMIT.
// The deadline is cooperative; blocking filesystem/cleanup has no hard bound.
func titleRepairDatabase(ctx context.Context, authority projectedRepairAuthority, source projectedRepairSource, limit, budget int, previous titleRepairSummary, files *titleRepairIO) (summary titleRepairSummary, scanned int, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	summary = emptyTitleRepair()
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
			_, err := conn.ExecContext(cleanupCtx, "ROLLBACK")
			resultErr = errors.Join(resultErr, err)
		}
	}()
	if err := source.check(authority); err != nil {
		return summary, 0, err
	}
	shape, columns, err := titleRepairSchema(ctx, conn)
	if err != nil {
		return summary, 0, err
	}
	rows, err := titleRepairRows(ctx, conn, columns, limit, budget)
	if err != nil {
		return summary, 0, err
	}
	scanned = len(rows)
	if len(rows) > 0 {
		if err := files.loadIndex(ctx); err != nil {
			return emptyTitleRepair(), scanned, err
		}
	}
	for _, row := range rows {
		id, _ := titleRepairRaw(row.raw[0])
		path, _ := titleRepairRaw(row.raw[1])
		path = responseTrim(path)
		if responseTrim(id) == "" || path == "" {
			continue
		}
		if id != responseTrim(id) || strings.ContainsAny(id, "/\\") {
			return emptyTitleRepair(), scanned, errTitleRepairUnavailable
		}
		summary.Checked++
		title := files.index[id]
		if title == "" {
			first, _ := titleRepairRaw(row.raw[3])
			if first == "" {
				first, _ = titleRepairRaw(row.raw[4])
			}
			title, err = titleRepairSanitize(first)
			if err != nil {
				return emptyTitleRepair(), scanned, err
			}
		}
		if title == "" {
			title, err = files.rollout(ctx, id, path)
			if err != nil {
				return emptyTitleRepair(), scanned, err
			}
		}
		if title == "" {
			summary.Failed++
			continue
		}
		assignments := []string{}
		args := []any{}
		predicates := []string{}
		for i, name := range []string{"id", "rollout_path", "title", "first_user_message", "preview"} {
			if !columns[name] {
				continue
			}
			predicates = append(predicates, name+" COLLATE BINARY IS ?")
			if i < 2 {
				continue
			}
			value, _ := titleRepairRaw(row.raw[i])
			repair, err := titleRepairShouldRepair(value)
			if err != nil {
				return emptyTitleRepair(), scanned, err
			}
			if repair {
				assignments = append(assignments, name+" = ?")
				args = append(args, title)
			}
		}
		if len(assignments) == 0 {
			continue
		}
		for i, name := range []string{"id", "rollout_path", "title", "first_user_message", "preview"} {
			if columns[name] {
				args = append(args, row.raw[i])
			}
		}
		if err := source.check(authority); err != nil {
			return emptyTitleRepair(), scanned, err
		}
		if err := files.check(ctx); err != nil {
			return emptyTitleRepair(), scanned, err
		}
		result, err := conn.ExecContext(ctx, "UPDATE OR ABORT threads SET "+strings.Join(assignments, ", ")+" WHERE "+strings.Join(predicates, " AND "), args...)
		if err != nil {
			return emptyTitleRepair(), scanned, err
		}
		changes, err := result.RowsAffected()
		if err != nil || changes < 0 || changes > 1 {
			return emptyTitleRepair(), scanned, errTitleRepairUnavailable
		}
		if changes == 1 {
			summary.Repaired++
			summary.Items = append(summary.Items, titleRepairItem{id, title})
		} else {
			summary.Failed++
		}
	}
	if err := source.check(authority); err != nil {
		return emptyTitleRepair(), scanned, err
	}
	if err := files.check(ctx); err != nil {
		return emptyTitleRepair(), scanned, err
	}
	after, _, err := titleRepairSchema(ctx, conn)
	if err != nil || after != shape {
		return emptyTitleRepair(), scanned, errTitleRepairUnavailable
	}
	combined := previous
	combined.Checked += summary.Checked
	combined.Repaired += summary.Repaired
	combined.Failed += summary.Failed
	combined.Items = append(append([]titleRepairItem{}, previous.Items...), summary.Items...)
	combined.Reason = "codex_thread_title_repair_unavailable"
	wire, err := marshalWire(combined)
	if err != nil || len(wire)+1 > maxTitleRepairOutput {
		return emptyTitleRepair(), scanned, ErrBudget
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return emptyTitleRepair(), scanned, err
	}
	committed = true
	if err := source.check(authority); err != nil {
		return summary, scanned, err
	}
	if err := files.check(ctx); err != nil {
		return summary, scanned, err
	}
	return summary, scanned, nil
}

// RepairThreadTitles owns only the title repair SQL leaf. No Node SQL fallback
// is valid after an unavailable or ambiguous write receipt; never auto-retry.
func RepairThreadTitles(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxThreadTitleRepairInput {
		return nil, ErrBudget
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 5 || request["version"] != json.Number("1") || request["op"] != "thread-title-repair" {
		return nil, errTitleRepairInput
	}
	home, homeOK := request["codexHome"].(string)
	number, limitOK := request["limit"].(json.Number)
	maxNumber, bytesOK := request["maxBytes"].(json.Number)
	limit, limitErr := strconv.Atoi(string(number))
	maxBytes, bytesErr := strconv.ParseInt(string(maxNumber), 10, 64)
	if !homeOK || !filepath.IsAbs(home) || filepath.Clean(home) != home || responseTrim(home) != home || strings.ContainsRune(home, 0) || !limitOK || limitErr != nil || limit < 1 || limit > maxTitleRepairRows || !bytesOK || bytesErr != nil || maxBytes < 1024 || maxBytes > 32<<20 || ctx == nil {
		return nil, errTitleRepairInput
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
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
	files := &titleRepairIO{authority: authority, maxBytes: maxBytes}
	summary := emptyTitleRepair()
	budget := maxTitleRepairRows
	for _, source := range sources {
		part, scanned, err := titleRepairDatabase(ctx, authority, source, limit, budget, summary, files)
		budget -= scanned
		summary.Checked += part.Checked
		summary.Repaired += part.Repaired
		summary.Failed += part.Failed
		summary.Items = append(summary.Items, part.Items...)
		if err != nil {
			summary.Reason = "codex_thread_title_repair_unavailable"
			break
		}
	}
	return marshalWire(summary)
}
