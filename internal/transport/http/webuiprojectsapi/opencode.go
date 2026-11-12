package webuiprojectsapi

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
)

const (
	opencodeProvider = "opencode"
	// opencodeDatabaseRelativePath 是宿主共享的 opencode 会话库。
	opencodeDatabaseRelativePath = ".local/share/opencode/opencode.db"
)

// opencodeSessionLayouts 是两代会话表；新代在前，同 id 并列时保持先扫入的布局。
// 两代可同时存在且各有可能独有的行，必须都扫再按 id 合并（见
// lib/sessions/opencode-db-layouts.js 的硬事实说明）。
var opencodeSessionLayouts = []string{"session_v2", "session"}

// opencodeSession 是从 opencode.db 读到的一条会话事实。
type opencodeSession struct {
	ID        string
	Directory string
	Title     string
	UpdatedAt int64
	Archived  bool
	ParentID  string
}

// opencodeProjects 扫描宿主 opencode.db，按会话的 directory 归项目。
func (scan *scanner) opencodeProjects() []rawProject {
	dbPath := filepath.Join(scan.hostHome, filepath.FromSlash(opencodeDatabaseRelativePath))
	sessions := readOpencodeSessions(scan.ctx, dbPath)
	if scan.outOfTime() {
		return nil
	}

	byPath := make(map[string][]rawSession, 16)
	order := make([]string, 0, 16)
	for _, session := range sessions {
		if scan.outOfTime() {
			break
		}
		if _, exists := byPath[session.Directory]; !exists {
			order = append(order, session.Directory)
		}
		byPath[session.Directory] = append(byPath[session.Directory], rawSession{
			ID:        session.ID,
			Title:     session.Title,
			UpdatedAt: session.UpdatedAt,
			Provider:  opencodeProvider,
			// Node 不给 opencode 会话设置 projectDirName，聚合时退回项目 id。
		})
	}

	projects := make([]rawProject, 0, len(order))
	for _, projectPath := range order {
		sessions := byPath[projectPath]
		sort.SliceStable(sessions, func(left, right int) bool {
			return sessions[left].UpdatedAt > sessions[right].UpdatedAt
		})
		projects = append(projects, rawProject{
			ID:       opencodeProjectID(projectPath),
			Name:     projectBaseName(projectPath),
			Path:     projectPath,
			Provider: opencodeProvider,
			Sessions: sessions,
		})
	}
	return projects
}

// readOpencodeSessions 读取候选布局里的全部会话，并按 id 合并。
//
// 过滤口径与 Node 一致：time_archived 非 NULL（含 0）与 parent_id 非空的会话
// 不下发；同一 id 取 time_updated 更新的副本。
func readOpencodeSessions(ctx context.Context, dbPath string) []opencodeSession {
	database, ok := openReadOnlySQLite(ctx, dbPath)
	if !ok {
		return nil
	}
	defer func() { _ = database.Close() }()

	byID := make(map[string]opencodeSession)
	for _, table := range opencodeSessionLayouts {
		columns, ok := sqliteTableColumns(ctx, database, table)
		if !ok || !columns["id"] || !columns["directory"] || !columns["title"] {
			continue
		}
		updatedExpression := "time_created"
		if columns["time_updated"] {
			updatedExpression = "time_updated"
		}
		archivedExpression := "NULL"
		if columns["time_archived"] {
			archivedExpression = "time_archived"
		}
		parentExpression := "NULL"
		if columns["parent_id"] {
			parentExpression = "parent_id"
		}
		query := fmt.Sprintf(
			"SELECT id, directory, title, %s AS updated_at, %s AS time_archived, %s AS parent_id FROM %s WHERE id <> ''",
			updatedExpression, archivedExpression, parentExpression, quoteSQLiteIdentifier(table),
		)
		rows, err := database.QueryContext(ctx, query)
		if err != nil {
			continue
		}
		for rows.Next() {
			var (
				rawID       any
				rawDir      any
				rawTitle    any
				rawUpdated  any
				rawArchived any
				rawParent   any
			)
			if rows.Scan(&rawID, &rawDir, &rawTitle, &rawUpdated, &rawArchived, &rawParent) != nil {
				continue
			}
			id := trimSpace(sqliteValueString(rawID))
			if id == "" {
				continue
			}
			updatedAt := sqliteValueInt64(rawUpdated)
			existing, exists := byID[id]
			// 同一 id 两代都有时取更新更晚的副本；并列保持先扫入的布局（新代优先）。
			if exists && existing.UpdatedAt >= updatedAt {
				continue
			}
			title := trimSpace(sqliteValueString(rawTitle))
			if title == "" {
				title = id
			}
			byID[id] = opencodeSession{
				ID:        id,
				Directory: normalizeProjectPath(sqliteValueString(rawDir)),
				Title:     title,
				UpdatedAt: updatedAt,
				Archived:  rawArchived != nil,
				ParentID:  trimSpace(sqliteValueString(rawParent)),
			}
		}
		_ = rows.Err()
		_ = rows.Close()
	}

	sessions := make([]opencodeSession, 0, len(byID))
	for _, session := range byID {
		if session.Directory == "" || session.Archived || session.ParentID != "" {
			continue
		}
		sessions = append(sessions, session)
	}
	sort.SliceStable(sessions, func(left, right int) bool {
		if sessions[left].UpdatedAt != sessions[right].UpdatedAt {
			return sessions[left].UpdatedAt > sessions[right].UpdatedAt
		}
		return sessions[left].ID > sessions[right].ID
	})
	return sessions
}

// opencodeProjectID 复刻 Node：opencode- 前缀 + 标准 base64，再把 / + = 折成下划线。
func opencodeProjectID(projectPath string) string {
	return base64PathID("opencode-", projectPath)
}

// projectBaseName 等价于 Node 的 path.basename(projectPath) || projectPath。
func projectBaseName(projectPath string) string {
	name := filepath.Base(projectPath)
	if name == "." || name == string(filepath.Separator) {
		return projectPath
	}
	return name
}
