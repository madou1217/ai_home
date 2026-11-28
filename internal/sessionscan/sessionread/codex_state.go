package sessionread

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
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
	// ParentID/Subagent 来自 threads.source 的 subagent.thread_spawn；
	// Exec 为 codex exec 的一次性线程，不属于可交互持久会话。
	ParentID   string
	Subagent   bool
	AgentName  string
	Exec       bool
	ThreadKind string
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
	codexDir := filepath.Join(home, providerroot.ConfigDir("codex"))
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

func parseCodexSubagentSource(raw string) (string, string, bool) {
	text := strings.TrimSpace(raw)
	if text == "" || !strings.Contains(text, "subagent") {
		return "", "", false
	}
	var payload struct {
		Subagent struct {
			ThreadSpawn struct {
				ParentThreadID string `json:"parent_thread_id"`
				AgentNickname  string `json:"agent_nickname"`
			} `json:"thread_spawn"`
		} `json:"subagent"`
	}
	if json.Unmarshal([]byte(text), &payload) != nil {
		return "", "", true
	}
	return strings.TrimSpace(payload.Subagent.ThreadSpawn.ParentThreadID), strings.TrimSpace(payload.Subagent.ThreadSpawn.AgentNickname), true
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
	sourceExpr := "NULL"
	if columns["source"] {
		sourceExpr = "source"
	}
	threadSourceExpr := "NULL"
	if columns["thread_source"] {
		threadSourceExpr = "thread_source"
	}
	query := "SELECT id, cwd, " + titleExpr + ", " + firstUserExpr + ", " + updatedAtMsExpr + ", " + updatedAtExpr + ", " + sourceExpr + ", " + threadSourceExpr + " FROM threads"
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
		var title, firstUser, source, threadSource sql.NullString
		var updatedAtMS, updatedAt sql.NullInt64
		if rows.Scan(&id, &cwd, &title, &firstUser, &updatedAtMS, &updatedAt, &source, &threadSource) != nil {
			continue
		}
		titleText := strings.TrimSpace(title.String)
		if titleText == "" {
			titleText = strings.TrimSpace(firstUser.String)
		}
		// 标题为空不等于会话不存在：新建会话、后台 thread 和刚恢复的
		// 会话都可能在首个用户消息落库前就要出现在 ss 里。这里保留
		// 空标题，由显示层回退到会话 id/项目名。
		updated := updatedAtMS.Int64
		if updated == 0 {
			updated = updatedAt.Int64 * 1000
		}
		parentID, agentName, subagent := parseCodexSubagentSource(source.String)
		out = append(out, CodexStateSession{
			ID:          strings.TrimSpace(id),
			CWD:         strings.TrimSpace(cwd),
			Title:       titleText,
			UpdatedAtMS: updated,
			ParentID:    parentID,
			Subagent:    subagent || strings.EqualFold(strings.TrimSpace(threadSource.String), "subagent"),
			AgentName:   agentName,
			Exec:        strings.EqualFold(strings.TrimSpace(source.String), "exec"),
			ThreadKind:  strings.TrimSpace(threadSource.String),
		})
	}
	return out
}
