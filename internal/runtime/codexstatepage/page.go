package codexstatepage

import (
	"container/heap"
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
)

type winner struct {
	id                      string
	source                  int
	updated, created, value float64
	fields                  int
}
type ranked []*winner

func better(a, b *winner) bool {
	if a.value != b.value {
		return a.value > b.value
	}
	return a.id > b.id
}
func (h ranked) Len() int           { return len(h) }
func (h ranked) Less(i, j int) bool { return better(h[j], h[i]) }
func (h ranked) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *ranked) Push(v any)        { *h = append(*h, v.(*winner)) }
func (h *ranked) Pop() any {
	old := *h
	x := old[len(old)-1]
	old[len(old)-1] = nil
	*h = old[:len(old)-1]
	return x
}

type ReadOptions struct{ TitleMaxBytes int64 }

// ReadPage streams one row at a time from each read-only snapshot. Only small
// winner metadata survives that pass; a size-(limit+1) heap selects the page,
// then detailed rows are loaded by ID from those same snapshots. No full sort
// of full row payloads, repeated title scan or per-page all() array is retained.
func ReadPage(ctx context.Context, home string, params Params, options ReadOptions) (*Page, error) {
	p, err := normalized(params)
	if err != nil {
		return nil, err
	}
	empty := &Page{Rows: []Row{}}
	if p.Cwd == "" && !p.AllProjects {
		return empty, nil
	}
	cursor, err := decodeCursor(p)
	if err != nil {
		return nil, err
	}
	sources, err := openSources(ctx, home, p, false)
	if err != nil {
		return nil, err
	}
	defer closeSources(sources)
	spawned, err := spawnIDs(ctx, sources)
	if err != nil {
		return nil, err
	}
	titles := &titleResolver{home: home, maxBytes: options.TitleMaxBytes}
	winners := make(map[string]*winner)
	var identityBytes int
	for _, source := range sources {
		rows, err := source.tx.QueryContext(ctx, source.selectSQL, source.bindings...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			row, err := scanRow(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			id := strings.TrimSpace(text(row["id"]))
			if len(id) > 4096 {
				rows.Close()
				return nil, ErrBudget
			}
			if id == "" || subagent(row, spawned) {
				continue
			}
			cwd := strings.TrimSpace(text(row["cwd"]))
			if cwd == "" || worktree(cwd) || (p.Cwd != "" && cwd != p.Cwd) || (!p.Archived && numeric(row["archived"]) == 1) {
				continue
			}
			if !contains(p.SourceKinds, strings.TrimSpace(text(row["source"]))) || (len(p.ModelProviders) > 0 && !contains(p.ModelProviders, strings.TrimSpace(text(row["model_provider"])))) {
				continue
			}
			title, err := titles.resolve(ctx, row)
			if err != nil {
				rows.Close()
				return nil, err
			}
			if title == "" || title == "Warmup" || title == "未命名会话" {
				continue
			}
			row["title"] = title
			updated, created := timestamps(row)
			fields := completeness(row)
			current := winners[id]
			if current != nil && (updated < current.updated || (updated == current.updated && (fields < current.fields || (fields == current.fields && !sourceLess(source.path, sources[current.source].path))))) {
				continue
			}
			if current == nil {
				identityBytes += len(id) + 80
				if len(winners) >= maxCandidates || identityBytes > maxIdentityBytes {
					rows.Close()
					return nil, ErrBudget
				}
			}
			value := updated
			if p.SortKey == "created_at" {
				value = created
			} else if p.SortKey == "recency_at" {
				value = max(updated, created)
			}
			winners[id] = &winner{id: id, source: source.index, updated: updated, created: created, value: value, fields: fields}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	page := ranked{}
	for _, entry := range winners {
		if cursor != nil && !(entry.value < cursor.Value || (entry.value == cursor.Value && entry.id < cursor.ID)) {
			continue
		}
		if len(page) < p.Limit+1 {
			heap.Push(&page, entry)
		} else if better(entry, page[0]) {
			heap.Pop(&page)
			heap.Push(&page, entry)
		}
	}
	ordered := []*winner(page)
	sort.Slice(ordered, func(i, j int) bool { return better(ordered[i], ordered[j]) })
	result := &Page{Rows: []Row{}, HasMore: len(ordered) > p.Limit}
	if len(ordered) > p.Limit {
		ordered = ordered[:p.Limit]
	}
	pageBytes := 0
	for _, entry := range ordered {
		source := sources[entry.source]
		statement := source.selectSQL
		if strings.Contains(statement, " WHERE ") {
			statement += " AND id=?"
		} else {
			statement += " WHERE id=?"
		}
		args := append(append([]any(nil), source.bindings...), entry.id)
		rows, err := source.tx.QueryContext(ctx, statement, args...)
		if err != nil {
			return nil, err
		}
		if !rows.Next() {
			rows.Close()
			return nil, errors.New("codex_state_snapshot_changed")
		}
		row, err := scanRow(rows)
		rows.Close()
		if err != nil {
			return nil, err
		}
		title, err := titles.resolve(ctx, row)
		if err != nil {
			return nil, err
		}
		row["title"] = title
		row["__stateDbPath"] = source.path
		for _, value := range row {
			if text, ok := value.(string); ok {
				pageBytes += len(text)
			}
		}
		if pageBytes > 16<<20 {
			return nil, ErrBudget
		}
		result.Rows = append(result.Rows, row)
	}
	if result.HasMore && len(ordered) > 0 {
		last := ordered[len(ordered)-1]
		result.NextCursor = encodeCursor(p, last.id, last.value)
	}
	return result, nil
}
func contains(values []string, search string) bool {
	for _, value := range values {
		if value == search {
			return true
		}
	}
	return false
}

// ReadHidden preserves the cross-database spawn-edge and explicit subagent /
// worktree rules. Its returned identities are bounded; payloads are never kept.
func ReadHidden(ctx context.Context, home string) ([]string, error) {
	p, _ := normalized(Params{AllProjects: true})
	sources, err := openSources(ctx, home, p, true)
	if err != nil {
		return nil, err
	}
	defer closeSources(sources)
	hidden, err := spawnIDs(ctx, sources)
	if err != nil {
		return nil, err
	}
	size := 0
	for id := range hidden {
		size += len(id)
	}
	for _, source := range sources {
		fields := []string{"id", "source", "thread_source", "parent_thread_id", "cwd"}
		selects := make([]string, len(fields))
		for i, key := range fields {
			if source.columns[key] {
				selects[i] = `"` + key + `"`
			} else {
				selects[i] = "NULL"
			}
		}
		rows, err := source.tx.QueryContext(ctx, "SELECT "+strings.Join(selects, ",")+" FROM threads")
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, src, thread, parent, cwd sql.NullString
			if err = rows.Scan(&id, &src, &thread, &parent, &cwd); err != nil {
				rows.Close()
				return nil, err
			}
			if len(id.String) > 4096 || len(src.String)+len(thread.String)+len(parent.String)+len(cwd.String) > 1<<20 {
				rows.Close()
				return nil, ErrBudget
			}
			row := Row{"id": id.String, "source": src.String, "thread_source": thread.String, "parent_thread_id": parent.String, "cwd": cwd.String}
			if subagent(row, hidden) || worktree(cwd.String) {
				key := strings.TrimSpace(id.String)
				if key != "" && !hidden[key] {
					size += len(key)
					if len(hidden) >= maxCandidates || size > maxIdentityBytes {
						rows.Close()
						return nil, ErrBudget
					}
					hidden[key] = true
				}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	result := make([]string, 0, len(hidden))
	for id := range hidden {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}
