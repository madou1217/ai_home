package sessionread

import (
	"context"
	"database/sql"
	"path/filepath"
	"sort"
	"strings"
)

// CodexStateSession 是 Codex state_*.sqlite threads 表里的顶层会话。
//
// rollout 文件可能已被删除，但 state DB 仍保留线程元数据；Node 的列表以这份
// 快照为准，Go 的 rollout 扫描需要用它补齐否则会丢会话。
type CodexStateSession struct {
	ID          string
	CWD         string
	Title       string
	UpdatedAtMS int64
}

// ListCodexStateSessions 读取 ~/.codex/state_*.sqlite 的 threads 表。
//
// 只返回 cwd/title 可用的顶层会话；归档、子代理与已删除账号的线程由调用方
// 用 ReadCodexExcludedThreadIDs 再过滤。读不到任一 state DB 时返回 nil。
func ListCodexStateSessions(ctx context.Context, hostHome string) []CodexStateSession {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return nil
	}
	codexDir := filepath.Join(home, ".codex")
	paths := ListCodexStateDBPaths(codexDir)
	if len(paths) == 0 {
		return nil
	}
	byID := make(map[string]CodexStateSession)
	for _, dbPath := range paths {
		db, exists, err := openReadOnlySQLite(ctx, dbPath)
		if err != nil || !exists {
			continue
		}
		if sqliteTableExists(ctx, db, "threads") {
			columns := getSQLiteTableColumns(ctx, db, "threads")
			if columns["id"] && columns["cwd"] {
				for _, row := range readCodexStateThreadRows(ctx, db, columns) {
					id := strings.TrimSpace(row.ID)
					if id == "" || strings.TrimSpace(row.CWD) == "" {
						continue
					}
					previous, found := byID[id]
					if !found || row.UpdatedAtMS > previous.UpdatedAtMS || (row.UpdatedAtMS == previous.UpdatedAtMS && len(row.Title) > len(previous.Title)) {
						byID[id] = row
					}
				}
			}
		}
		_ = db.Close()
	}
	out := make([]CodexStateSession, 0, len(byID))
	for _, session := range byID {
		out = append(out, session)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAtMS > out[j].UpdatedAtMS })
	return out
}

func readCodexStateThreadRows(ctx context.Context, db *sql.DB, columns map[string]bool) []CodexStateSession {
	titleExpr := "NULL"
	if columns["title"] {
		titleExpr = "title"
	}
	firstUserExpr := "NULL"
	if columns["first_user_message"] {
		firstUserExpr = "first_user_message"
	}
	updatedAtMsExpr := "NULL"
	if columns["updated_at_ms"] {
		updatedAtMsExpr = "updated_at_ms"
	}
	updatedAtExpr := "NULL"
	if columns["updated_at"] {
		updatedAtExpr = "updated_at"
	}
	query := "SELECT id, cwd, " + titleExpr + ", " + firstUserExpr + ", " + updatedAtMsExpr + ", " + updatedAtExpr + " FROM threads"
	if columns["archived"] {
		query += " WHERE archived = 0"
	}
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	out := make([]CodexStateSession, 0, 32)
	for rows.Next() {
		var id, cwd string
		var title, firstUser sql.NullString
		var updatedAtMS, updatedAt sql.NullInt64
		if rows.Scan(&id, &cwd, &title, &firstUser, &updatedAtMS, &updatedAt) != nil {
			continue
		}
		titleText := strings.TrimSpace(title.String)
		if titleText == "" {
			titleText = strings.TrimSpace(firstUser.String)
		}
		if titleText == "" {
			continue
		}
		updated := updatedAtMS.Int64
		if updated == 0 {
			updated = updatedAt.Int64 * 1000
		}
		out = append(out, CodexStateSession{
			ID:          strings.TrimSpace(id),
			CWD:         strings.TrimSpace(cwd),
			Title:       titleText,
			UpdatedAtMS: updated,
		})
	}
	return out
}
