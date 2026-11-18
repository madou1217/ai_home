package codexstatepage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxOptimizedRolloutRepairInput = 256 << 10
const maxOptimizedRepairOutput = 1 << 20
const maxOptimizedRepairRows = 4096
const maxOptimizedRepairEntries = 32768
const maxOptimizedRepairDirectories = 1024

var errOptimizedRepairInput = errors.New("codex_optimized_rollout_repair_input_invalid")
var errOptimizedRepairUnavailable = errors.New("codex_optimized_rollout_repair_unavailable")

type optimizedRepairItem struct {
	Checked  bool   `json:"checked"`
	Repaired bool   `json:"repaired"`
	ThreadID string `json:"threadId"`
	Previous string `json:"previousPath"`
	Path     string `json:"repairedPath"`
}
type optimizedRepairSummary struct {
	Checked  int                   `json:"checked"`
	Repaired int                   `json:"repaired"`
	Failed   int                   `json:"failed"`
	Items    []optimizedRepairItem `json:"items"`
	Reason   string                `json:"reason,omitempty"`
}

func emptyOptimizedRepair() optimizedRepairSummary {
	return optimizedRepairSummary{Items: []optimizedRepairItem{}}
}
func optimizedRepairSidecar(path string) bool {
	return strings.Contains(path, ".aih-slim-") || strings.Contains(path, ".aih-full-")
}
func optimizedRepairDerived(path string) string {
	if index := strings.Index(path, ".aih-slim-"); index > 0 {
		return path[:index]
	}
	if index := strings.Index(path, ".aih-full-"); index > 0 {
		return path[:index]
	}
	return ""
}

type optimizedRepairTraversal struct {
	entries, directories int
	observed             []projectedRepairIdentity
}

func (traversal *optimizedRepairTraversal) check() error {
	for _, identity := range traversal.observed {
		if err := identity.check(); err != nil {
			return err
		}
		info, err := os.Stat(identity.real)
		// In addition to path/device/inode, reject an observable enumeration
		// generation change. This does not promise atomicity against rename/ABA.
		if err != nil || info.Size() != identity.info.Size() || !info.ModTime().Equal(identity.info.ModTime()) {
			return errOptimizedRepairUnavailable
		}
	}
	return nil
}
func optimizedRepairInside(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

// Preserve derived-first. Fallback follows unsorted Dirent iteration and a
// LIFO directory stack, but admits only a bounded COMPLETE enumeration with
// one original-predicate match: its result is independent of driver order.
// Multiple matches, unreadable directories and exceeded budgets are unavailable,
// never a reason to select a convenient different first match or sorted walk.
func optimizedRepairFind(ctx context.Context, authority projectedRepairAuthority, id, path string, traversal *optimizedRepairTraversal) (projectedRepairIdentity, bool, error) {
	derived := optimizedRepairDerived(path)
	if derived != "" {
		// Original lexical predicate must pass before probing the derived file.
		if strings.HasSuffix(derived, ".jsonl") && !optimizedRepairSidecar(derived) && strings.Contains(filepath.Base(derived), id) {
			_, err := os.Stat(derived)
			if err == nil {
				candidate, candidateErr := projectedRepairCandidate(authority, id, derived)
				if candidateErr != nil {
					return projectedRepairIdentity{}, false, errOptimizedRepairUnavailable
				}
				return candidate, true, nil
			}
			if !errors.Is(err, syscall.ENOENT) {
				return projectedRepairIdentity{}, false, errOptimizedRepairUnavailable
			}
		}
	}
	stack := []string{filepath.Join(authority.requestRoot.path, "sessions")}
	var found projectedRepairIdentity
	matches := 0
	for len(stack) > 0 {
		if err := ctx.Err(); err != nil {
			return projectedRepairIdentity{}, false, err
		}
		directory := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		traversal.directories++
		if traversal.directories > maxOptimizedRepairDirectories {
			return projectedRepairIdentity{}, false, ErrBudget
		}
		identity, err := projectedRepairCapture(directory, true)
		if err != nil || !optimizedRepairInside(authority.sessions.real, identity.real) {
			return projectedRepairIdentity{}, false, errOptimizedRepairUnavailable
		}
		traversal.observed = append(traversal.observed, identity)
		file, err := os.Open(directory)
		if err != nil {
			return projectedRepairIdentity{}, false, errOptimizedRepairUnavailable
		}
		readErr := func() error {
			defer file.Close()
			opened, err := file.Stat()
			if err != nil || !os.SameFile(identity.info, opened) {
				return errOptimizedRepairUnavailable
			}
			for {
				if err := ctx.Err(); err != nil {
					return err
				}
				entries, err := file.ReadDir(128)
				traversal.entries += len(entries)
				if traversal.entries > maxOptimizedRepairEntries {
					return ErrBudget
				}
				for _, entry := range entries {
					name := entry.Name()
					// Node's UTF-8 replacement ordering is not guessed for invalid
					// names. projectedRepairText also bounds the returned path.
					if _, err := projectedRepairText(name); err != nil {
						return errOptimizedRepairUnavailable
					}
					candidatePath := filepath.Join(directory, name)
					if entry.IsDir() {
						if len(stack) >= maxOptimizedRepairDirectories {
							return ErrBudget
						}
						stack = append(stack, candidatePath)
						continue
					}
					if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, id+".jsonl") || optimizedRepairSidecar(name) {
						continue
					}
					matches++
					if matches > 1 {
						return errOptimizedRepairUnavailable
					}
					candidate, err := projectedRepairCandidate(authority, id, candidatePath)
					if err != nil {
						return errOptimizedRepairUnavailable
					}
					found = candidate
				}
				if errors.Is(err, io.EOF) {
					return nil
				}
				if err != nil {
					return errOptimizedRepairUnavailable
				}
			}
		}()
		if readErr != nil {
			return projectedRepairIdentity{}, false, readErr
		}
		if err := traversal.check(); err != nil {
			return projectedRepairIdentity{}, false, err
		}
	}
	if err := traversal.check(); err != nil {
		return projectedRepairIdentity{}, false, err
	}
	return found, matches == 1, nil
}

// The shared write-schema gate now rejects both FK directions for both
// operations. Do not duplicate or weaken its bounded complete enumeration.
func optimizedRepairSchema(ctx context.Context, conn *sql.Conn) (string, error) {
	return projectedRepairSchema(ctx, conn)
}

func optimizedRepairRows(ctx context.Context, conn *sql.Conn, limit, budget int) ([]projectedRepairRow, error) {
	// Per-DB original query: no new ordering, no global LIMIT substitution.
	// Identical unordered SQL does not promise the same subset across drivers.
	rows, err := conn.QueryContext(ctx, "SELECT id, rollout_path FROM threads WHERE rollout_path LIKE '%.aih-slim-%' OR rollout_path LIKE '%.aih-full-%' LIMIT ?", limit)
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
		path, err := projectedRepairText(pathValue)
		if err != nil {
			return nil, err
		}
		result = append(result, projectedRepairRow{id, path})
	}
	return result, rows.Err()
}

type optimizedRepairPending struct {
	item      optimizedRepairItem
	candidate projectedRepairIdentity
}

// Reuse only the reviewed authority/schema/identity contract, NOT projected's
// query or missing-old-path business predicate. This list leaf repairs an
// existing sidecar too. A DB-level error rolls back this DB and stops later DBs;
// earlier commits remain explicit partial results, never implicit retry input.
func optimizedRepairDatabase(ctx context.Context, authority projectedRepairAuthority, source projectedRepairSource, limit, budget int, previous optimizedRepairSummary, traversal *optimizedRepairTraversal) (summary optimizedRepairSummary, scanned int, resultErr error) {
	summary = emptyOptimizedRepair()
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
	shape, err := optimizedRepairSchema(ctx, conn)
	if err != nil {
		return summary, 0, err
	}
	rows, err := optimizedRepairRows(ctx, conn, limit, budget)
	if err != nil {
		return summary, 0, err
	}
	scanned = len(rows)
	pending := []optimizedRepairPending{}
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return emptyOptimizedRepair(), scanned, err
		}
		if row.id == "" {
			continue
		}
		summary.Checked++
		// SQL LIKE can select a case variant which JS includes would reject.
		if row.path == "" || !optimizedRepairSidecar(row.path) {
			continue
		}
		candidate, found, err := optimizedRepairFind(ctx, authority, row.id, row.path, traversal)
		if err != nil {
			return emptyOptimizedRepair(), scanned, err
		}
		if !found {
			summary.Failed++
			continue
		}
		if err := source.check(authority); err != nil {
			return emptyOptimizedRepair(), scanned, err
		}
		if err := candidate.check(); err != nil {
			return emptyOptimizedRepair(), scanned, err
		}
		if err := traversal.check(); err != nil {
			return emptyOptimizedRepair(), scanned, err
		}
		result, err := conn.ExecContext(ctx, "UPDATE OR ABORT threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?", candidate.path, row.id, row.path)
		if err != nil {
			return emptyOptimizedRepair(), scanned, err
		}
		changes, err := result.RowsAffected()
		if err != nil || changes < 0 || changes > 1 {
			return emptyOptimizedRepair(), scanned, errOptimizedRepairUnavailable
		}
		if changes == 0 {
			summary.Failed++
			continue
		}
		summary.Repaired++
		item := optimizedRepairItem{true, true, row.id, row.path, candidate.path}
		summary.Items = append(summary.Items, item)
		pending = append(pending, optimizedRepairPending{item, candidate})
	}
	if err := source.check(authority); err != nil {
		return emptyOptimizedRepair(), scanned, err
	}
	afterShape, err := optimizedRepairSchema(ctx, conn)
	if err != nil || shape != afterShape {
		return emptyOptimizedRepair(), scanned, errOptimizedRepairUnavailable
	}
	for _, repair := range pending {
		if err := repair.candidate.check(); err != nil {
			return emptyOptimizedRepair(), scanned, err
		}
	}
	if err := traversal.check(); err != nil {
		return emptyOptimizedRepair(), scanned, err
	}
	combined := previous
	combined.Items = append(append([]optimizedRepairItem{}, previous.Items...), summary.Items...)
	combined.Checked += summary.Checked
	combined.Repaired += summary.Repaired
	combined.Failed += summary.Failed
	combined.Reason = "codex_optimized_rollout_repair_unavailable"
	wire, err := marshalWire(combined)
	if err != nil || len(wire)+1 > maxOptimizedRepairOutput {
		return emptyOptimizedRepair(), scanned, ErrBudget
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return emptyOptimizedRepair(), scanned, err
	}
	committed = true
	if err := source.check(authority); err != nil {
		return summary, scanned, err
	}
	return summary, scanned, nil
}

// RepairOptimizedRollouts owns only the real thread/list sidecar-repair leaf.
// It does not own restore, findThreadStateRow, fastread, hydration or a service.
func RepairOptimizedRollouts(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxOptimizedRolloutRepairInput {
		return nil, ErrBudget
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 4 || request["version"] != json.Number("1") || request["op"] != "optimized-rollout-repair" {
		return nil, errOptimizedRepairInput
	}
	home, homeOK := request["codexHome"].(string)
	number, limitOK := request["limit"].(json.Number)
	limit, limitErr := strconv.Atoi(string(number))
	if !homeOK || !filepath.IsAbs(home) || filepath.Clean(home) != home || responseTrim(home) != home || strings.ContainsRune(home, 0) || !limitOK || limitErr != nil || limit < 1 || limit > maxOptimizedRepairRows {
		return nil, errOptimizedRepairInput
	}
	if ctx == nil {
		return nil, errOptimizedRepairInput
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
	summary := emptyOptimizedRepair()
	budget := maxOptimizedRepairRows
	traversal := &optimizedRepairTraversal{}
	for _, source := range sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		part, scanned, err := optimizedRepairDatabase(ctx, authority, source, limit, budget, summary, traversal)
		budget -= scanned
		summary.Checked += part.Checked
		summary.Repaired += part.Repaired
		summary.Failed += part.Failed
		summary.Items = append(summary.Items, part.Items...)
		if err != nil {
			summary.Reason = "codex_optimized_rollout_repair_unavailable"
			break
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return marshalWire(summary)
}
