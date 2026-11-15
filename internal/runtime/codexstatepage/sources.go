package codexstatepage

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type source struct {
	path      string
	db        *sql.DB
	tx        *sql.Tx
	columns   map[string]bool
	selectSQL string
	bindings  []any
	index     int
}

var stateName = regexp.MustCompile(`(?i)^state_(\d+)\.sqlite$`)
var rowFields = []string{"id", "cwd", "title", "updated_at", "updated_at_ms", "created_at", "created_at_ms", "rollout_path", "first_user_message", "source", "model_provider", "model", "cli_version", "archived", "git_sha", "git_branch", "git_origin_url", "reasoning_effort", "thread_source", "parent_thread_id"}

func discover(home string) ([]string, error) {
	var paths []string
	for _, dir := range []string{home, filepath.Join(home, "sqlite")} {
		entries, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if stateName.MatchString(entry.Name()) {
				paths = append(paths, filepath.Join(dir, entry.Name()))
			}
		}
	}
	if len(paths) > maxSources {
		return nil, ErrBudget
	}
	sort.Slice(paths, func(i, j int) bool {
		a, _ := strconv.Atoi(stateName.FindStringSubmatch(filepath.Base(paths[i]))[1])
		b, _ := strconv.Atoi(stateName.FindStringSubmatch(filepath.Base(paths[j]))[1])
		if a != b {
			return a > b
		}
		left, right := filepath.Dir(paths[i]) == home, filepath.Dir(paths[j]) == home
		if left != right {
			return left
		}
		return sourceLess(paths[i], paths[j])
	})
	return paths, nil
}
func tableColumns(ctx context.Context, tx *sql.Tx, name string) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx, `PRAGMA table_info("`+name+`")`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var column, kind string
		var def any
		if err = rows.Scan(&cid, &column, &kind, &notnull, &def, &pk); err != nil {
			return nil, err
		}
		result[column] = true
	}
	return result, rows.Err()
}
func openSources(ctx context.Context, home string, p Params, hidden bool) ([]*source, error) {
	if strings.TrimSpace(home) == "" || !filepath.IsAbs(home) {
		return nil, errors.New("codex_state_home_invalid")
	}
	paths, err := discover(home)
	if err != nil {
		return nil, err
	}
	var sources []*source
	fail := func(err error) ([]*source, error) { closeSources(sources); return nil, err }
	for _, path := range paths {
		db, tx, err := openVendorReadOnly(ctx, path)
		if err != nil {
			return fail(err)
		}
		src := &source{path: path, db: db, tx: tx, index: len(sources)}
		sources = append(sources, src)
		src.columns, err = tableColumns(ctx, tx, "threads")
		if err != nil {
			return fail(err)
		}
		if !src.columns["id"] || (!hidden && (!src.columns["cwd"] || !src.columns["title"])) {
			return fail(ErrSchema)
		}
		selects := make([]string, len(rowFields))
		for i, name := range rowFields {
			if src.columns[name] {
				selects[i] = `"` + name + `"`
			} else if name == "archived" {
				selects[i] = `0 AS "archived"`
			} else {
				selects[i] = `NULL AS "` + name + `"`
			}
		}
		where := []string{}
		if src.columns["archived"] {
			where = append(where, "COALESCE(archived,0)=?")
			if p.Archived {
				src.bindings = append(src.bindings, 1)
			} else {
				src.bindings = append(src.bindings, 0)
			}
		}
		if p.Cwd != "" {
			where = append(where, "cwd=?")
			src.bindings = append(src.bindings, p.Cwd)
		}
		for _, filter := range []struct {
			name   string
			values []string
		}{{"source", p.SourceKinds}, {"model_provider", p.ModelProviders}} {
			if !src.columns[filter.name] || len(filter.values) == 0 {
				continue
			}
			values := make([]string, len(filter.values))
			for i, v := range filter.values {
				values[i] = "?"
				src.bindings = append(src.bindings, v)
			}
			where = append(where, filter.name+" IN ("+strings.Join(values, ",")+")")
		}
		src.selectSQL = "SELECT " + strings.Join(selects, ",") + " FROM threads"
		if len(where) > 0 {
			src.selectSQL += " WHERE " + strings.Join(where, " AND ")
		}
	}
	return sources, nil
}
func closeSources(sources []*source) {
	for _, source := range sources {
		_ = source.tx.Rollback()
		_ = source.db.Close()
	}
}
func scanRow(rows *sql.Rows) (Row, error) {
	values := make([]any, len(rowFields))
	ptr := make([]any, len(values))
	for i := range values {
		ptr[i] = &values[i]
	}
	if err := rows.Scan(ptr...); err != nil {
		return nil, err
	}
	result := make(Row, len(values))
	rowBytes := 0
	for i, k := range rowFields {
		if _, blob := values[i].([]byte); blob {
			return nil, errors.New("codex_state_blob_field_unsupported")
		}
		if value, ok := values[i].(string); ok {
			rowBytes += len(value)
			if rowBytes > 1<<20 {
				return nil, ErrBudget
			}
		}
		result[k] = values[i]
	}
	return result, nil
}
func spawnIDs(ctx context.Context, sources []*source) (map[string]bool, error) {
	out := make(map[string]bool)
	bytes := 0
	for _, source := range sources {
		columns, err := tableColumns(ctx, source.tx, "thread_spawn_edges")
		if err != nil {
			return nil, err
		}
		if !columns["child_thread_id"] {
			continue
		}
		rows, err := source.tx.QueryContext(ctx, "SELECT child_thread_id FROM thread_spawn_edges WHERE child_thread_id IS NOT NULL AND child_thread_id<>''")
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			id = strings.TrimSpace(id)
			if id == "" || out[id] {
				continue
			}
			bytes += len(id)
			if len(out) >= maxCandidates || bytes > maxIdentityBytes {
				rows.Close()
				return nil, ErrBudget
			}
			out[id] = true
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
